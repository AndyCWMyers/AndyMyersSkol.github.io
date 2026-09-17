import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { reportDates } from "../src/worker.mjs";
import { startReading, saveReading, validReading, readingItems, userReading, historyReading } from "../src/engagement.mjs";
import { visitorHash } from "../src/preferences.mjs";

const ORIGIN = "https://www.andrewcwmyers.com";
const PDF = "/andrew_c_w_myers_CV.pdf";
const SECRET = "test-only-private-report-token-32-characters";
const visitor = "a".repeat(64);
const now = Date.parse("2026-09-17T07:10:00Z");
const midnight = now / 1000 - 600;

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const file of readdirSync(new URL("../migrations", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const DB = { prepare: sql => ({ bind: (...values) => ({
    run: async () => db.prepare(sql).run(...values),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
  }) }), batch: async statements => {
    db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  return { db, DB };
}

function context() {
  const tasks = [];
  return { waitUntil: promise => tasks.push(promise), finish: () => Promise.all(tasks) };
}

async function session(db, DB, options = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,is_personal) VALUES(?,?,?,?,?,?)")
    .run(id, midnight - 120, options.kind || "pdf_request", options.path || PDF, options.visitor || visitor, options.personal || 0);
  await startReading(DB, id, options.visitor || visitor);
  return id;
}

function snapshot(id, changes = {}) {
  return { id, seq: 1, active: true, milliseconds: 300000, downloads: 1, at: now,
    hours: [{ hour: midnight - 3600, milliseconds: 120000, downloads: 0 }, { hour: midnight, milliseconds: 180000, downloads: 1 }], ...changes };
}

function dates(day) { return reportDates(new URL(`${ORIGIN}?start=${day}&end=${day}`)); }

async function report(DB, search) {
  const response = await worker.fetch(new Request(`${ORIGIN}/__analytics/report?${search}`, { headers: { Authorization: `Bearer ${SECRET}` } }), { DB, READ_TOKEN: SECRET }, context());
  assert.equal(response.status, 200);
  return response.json();
}

test("cumulative check-ins are idempotent, owner-bound and do not add views", async () => {
  const { DB, db } = database(), id = await session(db, DB);
  const body = snapshot(id);
  assert.equal(await saveReading(DB, body, "b".repeat(64), now), 404);
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  assert.equal(await saveReading(DB, { ...body, seq: 0 }, visitor, now), 204);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  assert.equal(db.prepare("SELECT SUM(milliseconds) AS n FROM reading_hours").get().n, 300000);
  assert.equal(db.prepare("SELECT SUM(downloads) AS n FROM reading_hours").get().n, 1);
  await saveReading(DB, { ...body, seq: 2, active: false }, visitor, now);
  assert.equal(db.prepare("SELECT active FROM reading_sessions").get().active, 0);
  await saveReading(DB, { ...body, seq: 3, at: now - 400000 }, visitor, now);
  assert.equal(db.prepare("SELECT active FROM reading_sessions").get().active, 0);
  const shifted = snapshot(id, { seq: 4, hours: [{ hour: midnight, milliseconds: 300000, downloads: 1 }] });
  await saveReading(DB, shifted, visitor, now);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, 3, "cannot redistribute already saved time between hours");
});

test("updates and hourly buckets roll back together on a database failure", async () => {
  const { DB, db } = database(), id = await session(db, DB);
  db.exec("CREATE TRIGGER fail_hour BEFORE INSERT ON reading_hours BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(saveReading(DB, snapshot(id), visitor, now), /test failure/);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, -1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours").get().n, 0);
});

test("time and downloads use their own Pacific date and continued views do not inflate counts", async () => {
  const { DB, db } = database(), id = await session(db, DB);
  await saveReading(DB, snapshot(id), visitor, now);
  const prior = await readingItems(DB, dates("2026-09-16"), true);
  const today = await readingItems(DB, dates("2026-09-17"), true);
  assert.equal(prior.rows[0].readingSeconds, 120);
  assert.equal(prior.rows[0].downloads, 0);
  assert.equal(today.rows[0].readingSeconds, 180);
  assert.equal(today.rows[0].downloads, 1);
  const papers = await report(DB, "view=papers&start=2026-09-17&end=2026-09-17");
  assert.equal(papers.items[0].count, 0);
  assert.equal(papers.items[0].readingSeconds, 180);
  const users = await report(DB, "view=users&start=2026-09-17&end=2026-09-17");
  assert.equal(users.rows[0].views, 0);
  assert.equal(users.rows[0].lastPath, PDF);
  assert.equal(users.rows[0].readingSeconds, 180);
  const history = await report(DB, `view=users&user=${visitor.slice(0,24)}&start=2026-09-17&end=2026-09-17`);
  assert.equal(history.rows[0].continued, 1);
  assert.equal(history.rows[0].downloads, 1);
  assert.equal(history.engagement.readingSeconds, 180);
});

test("personal activity stays stored and can be excluded retroactively", async () => {
  const { DB, db } = database(), id = await session(db, DB);
  await saveReading(DB, snapshot(id), visitor, now);
  db.prepare("INSERT INTO personal_visitors(visitor_hash) VALUES(?)").run(visitor);
  assert.equal((await readingItems(DB, dates("2026-09-17"), true)).rows.length, 0);
  assert.equal((await userReading(DB, dates("2026-09-17"), true, [visitor.slice(0,24)])).rows.length, 0);
  assert.equal((await historyReading(DB, dates("2026-09-17"), true, [id])).rows.length, 0);
  assert.equal((await readingItems(DB, dates("2026-09-17"), false)).rows[0].readingSeconds, 180);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_sessions").get().n, 1);
});

test("homepage time stays separate, tracked zero differs from historical not measured", async () => {
  const { DB, db } = database(), id = await session(db, DB, { kind: "page_view", path: "/index.html" });
  await saveReading(DB, snapshot(id, { downloads: 0, hours: [{ hour: midnight, milliseconds: 300000, downloads: 0 }] }), visitor, now);
  const stats = (await userReading(DB, dates("2026-09-17"), false, [visitor.slice(0,24)])).rows[0];
  assert.equal(stats.readingSeconds, 0);
  assert.equal(stats.homepageSeconds, 300);
  assert.equal(stats.measuredPdfViews, 0);
  assert.equal(stats.measuredHomepageViews, 1);
  assert.equal(stats.lastReadingPath, "/");
  assert.equal(await saveReading(DB, snapshot(id, { seq: 2 }), visitor, now), 400);
  const old = crypto.randomUUID();
  db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,'pdf_request',?,?)").run(old, midnight + 1, PDF, visitor);
  assert.equal((await historyReading(DB, dates("2026-09-17"), false, [old])).rows.length, 0);
});

test("malformed, impossible and oversized cumulative snapshots are rejected", async () => {
  const { DB, db } = database(), id = await session(db, DB), body = snapshot(id);
  for (const change of [{ seq: -1 }, { milliseconds: -1 }, { downloads: 10001 }, { at: now + 120000 }, { active: 1 }, { hours: [...body.hours, body.hours[0]] }, { milliseconds: 300001 }]) {
    assert.equal(validReading({ ...body, ...change }, now), false);
  }
  assert.equal(await saveReading(DB, { ...body, milliseconds: 3600000, hours: [{ hour: midnight, milliseconds: 3600000, downloads: 1 }] }, visitor, now), 400);
  assert.equal(db.prepare("SELECT milliseconds FROM reading_sessions").get().milliseconds, 0);
});

test("viewer navigation and byte fetch do not create events; rendered acknowledgement counts once", async () => {
  const { DB, db } = database(), ctx = context(), env = { DB, ORIGIN: { fetch: async () => new Response("%PDF-original", { headers: { "Content-Type": "application/pdf" } }) } };
  const navigation = new Request(ORIGIN + PDF, { headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Accept: "text/html", "User-Agent": "Chrome/140" } });
  const viewer = await worker.fetch(navigation, env, ctx);
  assert.match(viewer.headers.get("Content-Type"), /text\/html/);
  const cookie = viewer.headers.get("Set-Cookie").split(";")[0];
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  const raw = await worker.fetch(new Request(`${ORIGIN}${PDF}?__pdf=raw`, { headers: { Cookie: cookie, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "same-origin" } }), env, ctx);
  assert.equal(await raw.text(), "%PDF-original");
  const id = crypto.randomUUID(), body = JSON.stringify({ id, kind: "pdf_view", path: PDF, referrer: "" });
  for (let n = 0; n < 2; n++) assert.equal((await worker.fetch(new Request(`${ORIGIN}/__analytics/event`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie }, body }), env, ctx)).status, 204);
  await ctx.finish();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_sessions").get().n, 1);
  assert.equal(db.prepare("SELECT visitor_hash FROM reading_sessions").get().visitor_hash, await visitorHash(cookie.split("=")[1]));
});

test("engagement endpoint enforces origin, identity, privacy and rate limits", async () => {
  const { DB, db } = database(), cookieId = crypto.randomUUID(), hash = await visitorHash(cookieId);
  const id = await session(db, DB, { visitor: hash });
  const at = Date.now(), hour = Math.floor(at / 3600000) * 3600;
  const body = JSON.stringify(snapshot(id, { milliseconds: 0, downloads: 0, at, hours: [{ hour, milliseconds: 0, downloads: 0 }] }));
  const call = (headers = {}, extra = {}) => worker.fetch(new Request(`${ORIGIN}/__analytics/engagement`, { method: "POST", headers: { Origin: ORIGIN, Cookie: `__Host-acw_visitor=${cookieId}`, ...headers }, body }), { DB, ...extra }, context());
  assert.equal((await call({ Origin: "https://evil.example" })).status, 403);
  assert.equal((await call({ Cookie: "" })).status, 404);
  assert.equal((await call({}, { COLLECT_LIMIT: { limit: async () => ({ success: false }) } })).status, 429);
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }, { Cookie: "__Host-acw_ignore=1" }, { "User-Agent": "Googlebot" }]) assert.equal((await call(headers)).status, 204);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, -1);
  assert.equal((await call()).status, 204);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, 1);
});
