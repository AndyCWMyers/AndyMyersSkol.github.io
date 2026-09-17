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

test("page filters scope every aggregate while user cohorts retain full histories", async () => {
  const { DB, db } = database();
  const insert = db.prepare("INSERT INTO events(id,occurred_at,kind,path,target,visitor_hash,country,region,city,browser,device,referrer_status,is_personal) VALUES(?,?,?,?,?,?,'US','CA','Stanford','Chrome','Desktop','direct',?)");
  for (const [id, kind, path, hash, personal] of [
    ["a-pdf", "pdf_request", PDF, visitor, 0], ["a-home", "page_view", "/index.html", visitor, 0],
    ["a-click", "outbound_click", PDF, visitor, 0], ["b-home", "page_view", "/", "b".repeat(64), 0],
    ["own", "pdf_request", PDF, "c".repeat(64), 1],
  ]) insert.run(id, midnight + 10, kind, path, "https://example.com/article", hash, personal);
  const suffix = `start=2026-09-17&end=2026-09-17&page=${encodeURIComponent(PDF)}`;
  const summary = await report(DB, `view=summary&${suffix}`);
  assert.equal(summary.page, PDF);
  assert.deepEqual(summary.totals.map(row => [row.kind, row.count]), [["outbound_click", 1], ["pdf_request", 1]]);
  for (const view of ["overview", "papers"]) {
    const result = await report(DB, `view=${view}&${suffix}`);
    assert.deepEqual(result.items.map(row => [row.name, row.count]), [[PDF, 1]]);
  }
  for (const [view, key] of [["geography", "countries"], ["sources", "referrers"], ["devices", "devices"]]) {
    const result = await report(DB, `view=${view}&${suffix}`);
    assert.equal(result[key].reduce((n, row) => n + row.count, 0), 2, view);
  }
  for (const [view, key] of [["states", "states"], ["countries", "countryViews"], ["counties", "countyViews"]]) {
    const result = await report(DB, `view=${view}&${suffix}`);
    assert.equal(result[key].reduce((n, row) => n + row.count, 0), 1, view);
  }
  const detail = await report(DB, `view=detail&section=main&name=${encodeURIComponent(PDF)}&${suffix}`);
  assert.equal(detail.items[0].count, 1);
  const outbound = await report(DB, `view=outbound&${suffix}`);
  assert.equal(outbound.items[0].count, 1);
  const users = await report(DB, `view=users&${suffix}`);
  assert.equal(users.rows.length, 1);
  assert.equal(users.rows[0].views, 2);
  const history = await report(DB, `view=users&user=${visitor.slice(0,24)}&${suffix}`);
  assert.equal(history.rows.length, 3);
  assert.ok(history.rows.some(row => row.path === "/"));
  assert.equal((await report(DB, `view=users&user=${"b".repeat(24)}&${suffix}`)).rows.length, 0);
  assert.equal((await report(DB, `view=users&excludePersonal=0&${suffix}`)).rows.length, 2);
  const homepage = await report(DB, "view=summary&start=2026-09-17&end=2026-09-17&page=%2F");
  assert.equal(homepage.totals[0].count, 2);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM events WHERE CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END = ? AND occurred_at >= ? AND occurred_at < ?").all(PDF, midnight, midnight + 86400);
  assert.ok(plan.some(row => row.detail.includes("events_page_time")));
});

test("live users require a current active check-in and respect page and personal filters", async () => {
  const { DB, db } = database(), current = Math.floor(Date.now() / 1000);
  const insert = db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,is_personal) VALUES(?,?,'pdf_request',?,?,?)");
  for (const [id, hash, path, age, active, personal] of [
    ["live-a", visitor, PDF, 20, 1, 0], ["paused", "b".repeat(64), PDF, 20, 0, 0],
    ["expired", "c".repeat(64), PDF, 316, 1, 0], ["host", "d".repeat(64), PDF, 20, 1, 1],
    ["other", "e".repeat(64), "/other.pdf", 20, 1, 0],
  ]) {
    insert.run(id, current - 600, path, hash, personal);
    await startReading(DB, id, hash);
    db.prepare("UPDATE reading_sessions SET last_seen=?, active=? WHERE id=?").run(current - age, active, id);
  }
  assert.equal((await report(DB, "view=live")).rows.length, 2);
  const suffix = `page=${encodeURIComponent(PDF)}`;
  assert.deepEqual((await report(DB, `view=live&${suffix}`)).rows.map(row => row.id), [visitor.slice(0,24)]);
  assert.equal((await report(DB, `view=live&excludePersonal=0&${suffix}`)).rows.length, 2);
  db.exec("UPDATE reading_sessions SET active=0");
  assert.equal((await report(DB, `view=live&${suffix}`)).rows.length, 0);
  assert.equal((await report(DB, `view=users&${suffix}`)).rows.length, 3);
});

test("headline engagement includes homepage time and honors page and personal filters", async () => {
  const { DB, db } = database();
  const pdf = await session(db, DB), home = await session(db, DB, { path: "/", kind: "page_view" }), own = await session(db, DB, { personal: 1 });
  await saveReading(DB, snapshot(pdf), visitor, now);
  await saveReading(DB, snapshot(home, { downloads: 0, hours: [{ hour: midnight, milliseconds: 300000, downloads: 0 }] }), visitor, now);
  await saveReading(DB, snapshot(own), visitor, now);
  const suffix = "start=2026-09-17&end=2026-09-17";
  assert.deepEqual((await report(DB, `view=summary&${suffix}`)).engagement, { readingSeconds: 480, downloads: 1 });
  assert.deepEqual((await report(DB, `view=summary&excludePersonal=0&${suffix}`)).engagement, { readingSeconds: 660, downloads: 2 });
  assert.deepEqual((await report(DB, `view=summary&page=${encodeURIComponent(PDF)}&${suffix}`)).engagement, { readingSeconds: 180, downloads: 1 });
});

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

test("history distinguishes missing sessions, missing updates, out-of-period updates and measured zero", async () => {
  const { DB, db } = database(), pending = await session(db, DB), tracked = await session(db, DB);
  await saveReading(DB, snapshot(tracked, { milliseconds: 0, downloads: 0, hours: [{ hour: midnight - 3600, milliseconds: 0, downloads: 0 }] }), visitor, now);
  const before = await historyReading(DB, dates("2026-09-16"), false, [pending, tracked]);
  assert.deepEqual(before.rows.find(row => row.id === pending), { id: pending, readingStatus: "no_updates" });
  assert.deepEqual(before.rows.find(row => row.id === tracked), { id: tracked, readingStatus: "tracked", readingSeconds: 0, downloads: 0 });
  const after = await historyReading(DB, dates("2026-09-17"), false, [tracked]);
  assert.deepEqual(after.rows[0], { id: tracked, readingStatus: "outside_period" });
  const raw = crypto.randomUUID();
  db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,'pdf_request',?,?)").run(raw, midnight - 120, PDF, visitor);
  const history = await report(DB, `view=users&user=${visitor.slice(0,24)}&start=2026-09-16&end=2026-09-16`);
  assert.equal(history.rows.find(row => row.id === raw).readingStatus, "untracked");
  assert.equal(history.rows.find(row => row.id === raw).readingSeconds, undefined);
  assert.equal(history.rows.find(row => row.id === pending).downloads, undefined);
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
  const legacy = await worker.fetch(new Request(ORIGIN + PDF, { headers: { Accept: "text/html", Cookie: cookie, "User-Agent": "Safari/605" } }), env, ctx);
  assert.match(legacy.headers.get("Content-Type"), /text\/html/);
  const marked = await worker.fetch(new Request(`${ORIGIN}${PDF}?__pdf=raw`, { headers: { Cookie: cookie, "X-ACW-PDF-Viewer": "1" } }), env, ctx);
  assert.equal(await marked.text(), "%PDF-original");
  const id = crypto.randomUUID(), body = JSON.stringify({ id, kind: "pdf_view", path: PDF, referrer: "" });
  for (let n = 0; n < 2; n++) assert.equal((await worker.fetch(new Request(`${ORIGIN}/__analytics/event`, { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie }, body }), env, ctx)).status, 204);
  await ctx.finish();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_sessions").get().n, 1);
  assert.equal(db.prepare("SELECT visitor_hash FROM reading_sessions").get().visitor_hash, await visitorHash(cookie.split("=")[1]));
});

test("broader routing preserves raw downloads, bots, range requests and opt-outs", async () => {
  const { DB, db } = database(), ctx = context(), env = { DB, ORIGIN: { fetch: async () => new Response("%PDF-original", { headers: { "Content-Type": "application/pdf" } }) } };
  for (const privacy of [{ DNT: "1" }, { "Sec-GPC": "1" }, { Cookie: "__Host-acw_ignore=1" }]) {
    const viewer = await worker.fetch(new Request(ORIGIN + PDF, { headers: { Accept: "text/html", ...privacy } }), env, ctx);
    assert.match(await viewer.text(), /acw-tracking" content="false"/);
    assert.equal(viewer.headers.get("Set-Cookie"), null);
  }
  for (const [path, headers, method] of [[PDF + "?__pdf=raw", {}, "GET"], [PDF, { "User-Agent": "Googlebot" }, "GET"],
    [PDF, { Range: "bytes=100-" }, "GET"], [PDF, {}, "HEAD"], ["/unknown.pdf", {}, "GET"]]) {
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers: { Accept: "text/html", ...headers } }), env, ctx);
    assert.equal(await response.text(), "%PDF-original");
  }
  await ctx.finish();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_sessions").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE path=? AND bot=0").get(PDF).n, 1);
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
