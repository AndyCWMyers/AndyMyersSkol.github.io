import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { reportDates } from "../src/worker.mjs";
import { startReading, saveReading, validReading, readingItems, userReading, historyReading } from "../src/engagement.mjs";
import { visitorHash } from "../src/preferences.mjs";
import { HOMEPAGE_ITEMS, validAttention, summarizeAttention } from "../src/homepage-attention.mjs";
import { validPdfAttention, summarizePdfAttention } from "../src/pdf-attention.mjs";

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

test("PDF attention is private, date-scoped, cumulative, idempotent and reuses existing hourly writes", async () => {
  const { db, DB } = database();
  const id = await session(db, DB);
  const before = { total: 40, scrolled: 1, pages: [2147483649, 0] };
  const after = { total: 40, scrolled: 0, pages: [0, 128] };
  const body = snapshot(id);
  body.hours[0].pdfAttention = before; body.hours[1].pdfAttention = after;
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  const saved = db.prepare("SELECT * FROM reading_hours ORDER BY hour").all();
  for (const pdfAttention of [undefined, { ...after, pages: [0, 0] }, { ...after, total: 39, pages: [0, 64] }]) {
    await saveReading(DB, { ...body, seq: 2, hours: [body.hours[0], { ...body.hours[1], pdfAttention }] }, visitor, now);
    assert.equal(db.prepare("SELECT seq FROM reading_sessions WHERE id = ?").get(id).seq, 1);
  }
  await saveReading(DB, body, visitor, now);
  assert.deepEqual(db.prepare("SELECT * FROM reading_hours ORDER BY hour").all(), saved);
  const count = db.prepare("SELECT total_changes() AS n").get().n;
  await saveReading(DB, { ...body, seq: 2, milliseconds: 301000, hours: [body.hours[0], { ...body.hours[1], milliseconds: 181000, pdfAttention: { ...after, scrolled: 1, pages: [2, 128] } }] }, visitor, now);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - count, 2);
  const rows = await historyReading(DB, dates("2026-09-16"), true, [id]);
  assert.deepEqual(rows.rows[0].pdfAttention, { totalPages: 40, scrolled: true, pages: [1, 32], furthestPage: 32 });
  const result = await report(DB, `view=users&user=${visitor.slice(0, 24)}&start=2026-09-17&end=2026-09-17`);
  assert.deepEqual(result.rows[0].pdfAttention.pages, [2, 40]);
  const list = await report(DB, "view=users&start=2026-09-17&end=2026-09-17");
  assert.equal(list.rows[0].pdfAttention, undefined);
  const home = await session(db, DB, { kind: "page_view", path: "/" });
  assert.equal(await saveReading(DB, { ...body, id: home, downloads: 0, hours: body.hours.map(h => ({ ...h, downloads: 0 })) }, visitor, now), 400);
  const legacy = await session(db, DB);
  await saveReading(DB, snapshot(legacy), visitor, now);
  assert.equal((await historyReading(DB, dates("2026-09-17"), true, [legacy])).rows[0].pdfAttention, undefined);
  const host = await session(db, DB, { personal: 1 });
  await saveReading(DB, { ...body, id: host }, visitor, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours WHERE session_id=?").get(host).n, 0);
});

test("PDF page time is date-scoped, cumulative and shares the existing hourly writes", async () => {
  const { db, DB } = database(), id = await session(db, DB);
  const body = snapshot(id);
  body.hours[0].pdfAttention = { total: 3, scrolled: 1, pages: [3], seconds: [30, 90, 0] };
  body.hours[1].pdfAttention = { total: 3, scrolled: 1, pages: [6], seconds: [0, 120, 60] };
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  const before = await historyReading(DB, dates("2026-09-16"), true, [id]);
  assert.deepEqual(before.rows[0].pdfAttention.pageTimes, [{ page: 1, visibleSeconds: 30, share: 0.25 }, { page: 2, visibleSeconds: 90, share: 0.75 }]);
  const after = await historyReading(DB, dates("2026-09-17"), true, [id]);
  assert.equal(after.rows[0].pdfAttention.measuredSeconds, 180);
  assert.deepEqual(after.rows[0].pdfAttention.pageTimes.map(p => p.page), [2, 3]);
  assert.equal(after.rows[0].pdfAttention.pageTimes.reduce((s, p) => s + p.share, 0), 1);
  const stored = db.prepare("SELECT * FROM reading_hours ORDER BY hour").all();
  for (const seconds of [undefined, [0, 0, 0], [0, 100, 60]]) {
    const changed = { ...body.hours[1].pdfAttention, seconds };
    if (seconds === undefined) delete changed.seconds;
    await saveReading(DB, { ...body, seq: 2, hours: [body.hours[0], { ...body.hours[1], pdfAttention: changed }] }, visitor, now);
    assert.equal(db.prepare("SELECT seq FROM reading_sessions WHERE id=?").get(id).seq, 1);
    assert.deepEqual(db.prepare("SELECT * FROM reading_hours ORDER BY hour").all(), stored);
  }
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  const update = { ...body, seq: 2, milliseconds: 301000, hours: [body.hours[0], { ...body.hours[1], milliseconds: 181000, pdfAttention: { ...body.hours[1].pdfAttention, seconds: [0, 121, 60] } }] };
  await saveReading(DB, update, visitor, now);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - changes, 2);
  await saveReading(DB, update, visitor, now);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - changes, 2);
  const old = { total: 3, scrolled: 0, pages: [1] };
  assert.equal(summarizePdfAttention([old]).pageTimes, undefined);
  assert.equal(summarizePdfAttention([old, body.hours[0].pdfAttention]).timingPartial, true);
  assert.deepEqual(summarizePdfAttention([{ ...old, seconds: [0, 0, 0] }]).pageTimes, []);
  for (const seconds of [[1, 1], [-1, 0, 0], [0.5, 0, 0], [3601, 0, 0], [0, 1, 0], [2, 0, 0]]) assert.equal(validPdfAttention({ ...old, seconds }, 1000), false);
});

test("timed PDF payloads remain below the keepalive bound for every supported page count", () => {
  for (const total of [1, 4, 50, 200, 700, 1000, 5000, 10000]) {
    const maxHours = Math.min(16, Math.max(1, Math.floor(61000 / (total * 5 + Math.ceil(total / 32) * 11 + 300))));
    // Deliberately use the widest possible counters, even though their sum exceeds an hour.
    const value = { total, scrolled: 1, pages: Array(Math.ceil(total / 32)).fill(4294967295), seconds: Array(total).fill(3600) };
    const full = snapshot(crypto.randomUUID(), { clientDetails: { languages: Array(5).fill("a".repeat(35)), initialViewport: [20000,20000], viewport: [20000,20000], responseMs: 3600000, domMs: 3600000, loadMs: 3600000, pdfRenderMs: 3600000, assessment: "submission_failed", navigation: "back_forward" }, hours: Array.from({ length: maxHours }, (_, i) => ({ hour: midnight - i * 3600, milliseconds: 3600000, downloads: 10000, pdfAttention: value, interactions: { searches: 10000, prints: 10000, outline: 10000, zoom: 10000 } })) });
    assert(Buffer.byteLength(JSON.stringify(full)) < 64512, `${total} pages / ${maxHours} hours`);
  }
});

test("PDF bitsets are bounded, validate unsigned words and preserve distinct pages across hours", () => {
  const value = { total: 10000, scrolled: 1, pages: Array(313).fill(4294967295) };
  value.pages[312] = 65535;
  assert.equal(validPdfAttention(value), true);
  for (const change of [{ total: 10001 }, { scrolled: 2 }, { pages: [-1] }, { pages: Array(313).fill(4294967295) }]) assert.equal(validPdfAttention({ ...value, ...change }), false);
  const full = snapshot(crypto.randomUUID(), { hours: Array.from({ length: 16 }, (_, i) => ({ hour: midnight - i * 3600, milliseconds: 3600000, downloads: 0, pdfAttention: value })), milliseconds: 16 * 3600000, downloads: 0 });
  assert.equal(validReading(full, now), true);
  assert(Buffer.byteLength(JSON.stringify(full)) < 64512);
  assert.equal(summarizePdfAttention([value, value]).pages.length, 10000);
  assert.equal(summarizePdfAttention([null]), undefined);
  assert.equal(validReading({ ...full, hours: [...full.hours, { ...full.hours[0], hour: midnight - 16 * 3600 }], milliseconds: 17 * 3600000 }, now), false);
});

async function report(DB, search) {
  const response = await worker.fetch(new Request(`${ORIGIN}/__analytics/report?${search}`, { headers: { Authorization: `Bearer ${SECRET}` } }), { DB, READ_TOKEN: SECRET }, context());
  assert.equal(response.status, 200);
  return response.json();
}

test("homepage attention reuses hourly rows, is cumulative and only appears in scoped private histories", async () => {
  const { DB, db } = database();
  const id = await session(db, DB, { kind: "page_view", path: "/" });
  const before = { depth: 40, scrolled: 0, sections: 3, items: [[1, 10000, 1, 5000]] };
  const after = { depth: 90, scrolled: 1, sections: 6, items: [[1, 15000, 2, 10000], [7, 5000, 0, 0]] };
  const body = snapshot(id, { downloads: 0, hours: [
    { hour: midnight - 3600, milliseconds: 120000, downloads: 0, attention: before },
    { hour: midnight, milliseconds: 180000, downloads: 0, attention: after },
  ] });
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours").get().n, 2);
  const saved = db.prepare("SELECT * FROM reading_hours ORDER BY hour").all();
  await saveReading(DB, body, visitor, now);
  await saveReading(DB, { ...body, seq: 0 }, visitor, now);
  assert.deepEqual(db.prepare("SELECT * FROM reading_hours ORDER BY hour").all(), saved);
  const result = await report(DB, `view=users&user=${visitor.slice(0, 24)}&start=2026-09-17&end=2026-09-17`);
  assert.deepEqual(result.rows[0].homepageAttention, summarizeAttention([after]));
  const previous = await historyReading(DB, dates("2026-09-16"), true, [id]);
  assert.deepEqual(previous.rows[0].homepageAttention, summarizeAttention([before]));
  const list = await report(DB, "view=users&start=2026-09-17&end=2026-09-17");
  assert.equal(list.rows[0].homepageAttention, undefined);
  // New sequence numbers cannot erase earlier per-hour detail or replay opens.
  for (const attention of [undefined, { ...after, depth: 20 }, { ...after, scrolled: 0 }, { ...after, sections: 2 }, { ...after, items: [[1, 15000, 1, 10000]] }]) {
    await saveReading(DB, { ...body, seq: 2, hours: [body.hours[0], { ...body.hours[1], attention }] }, visitor, now);
    assert.equal(db.prepare("SELECT seq FROM reading_sessions WHERE id = ?").get(id).seq, 1);
    assert.deepEqual(db.prepare("SELECT * FROM reading_hours ORDER BY hour").all(), saved);
  }
  const count = db.prepare("SELECT total_changes() AS n").get().n;
  const next = { ...body, seq: 2, milliseconds: 301000, hours: [body.hours[0], { ...body.hours[1], milliseconds: 181000, attention: { ...after, items: [[1, 16000, 2, 11000], [7, 5000, 0, 0]] } }] };
  await saveReading(DB, next, visitor, now);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - count, 2, "same session update and changed hourly row as ordinary reading");
  const legacy = await session(db, DB, { kind: "page_view", path: "/" });
  await saveReading(DB, snapshot(legacy, { downloads: 0, hours: body.hours.map(({ attention, ...row }) => row) }), visitor, now);
  assert.equal((await historyReading(DB, dates("2026-09-17"), true, [legacy])).rows[0].homepageAttention, undefined);
  const host = await session(db, DB, { kind: "page_view", path: "/", personal: 1 });
  await saveReading(DB, { ...body, id: host }, visitor, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours WHERE session_id = ?").get(host).n, 0);
  const pdf = await session(db, DB);
  assert.equal(await saveReading(DB, { ...body, id: pdf }, visitor, now), 400);
  assert.equal(await saveReading(DB, body, "b".repeat(64), now), 404);
});

test("attention payloads are bounded, omit short exposures, and match stable homepage markup", () => {
  const attention = { depth: 100, scrolled: 1, sections: 31, items: HOMEPAGE_ITEMS.map(item => [item.id, 3600000, 1000, 3600000]) };
  assert.equal(validAttention(attention, 3600000), true);
  for (const change of [{ depth: 101 }, { scrolled: true }, { sections: 32 }, { arbitrary: "untrusted" }, { items: [[99, 0, 0, 0]] }, { items: [[1, 0, 0, 1]] }, { items: [[1, 0, 1001, 0]] }, { items: [[1, 0, 0, 0], [1, 0, 0, 0]] }]) {
    assert.equal(validAttention({ ...attention, ...change }, 3600000), false);
  }
  const payload = snapshot(crypto.randomUUID(), { hours: Array.from({ length: 128 }, (_, i) => ({ hour: midnight - i * 3600, milliseconds: 3600000, downloads: 0, attention })) });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 64512, "even 128 full hours fit below the 64 KiB keepalive limit");
  assert.equal(summarizeAttention([null]), undefined);
  assert.deepEqual(summarizeAttention([{ depth: 20, scrolled: 0, sections: 0, items: [[1, 1000, 0, 0], [2, 0, 1, 0]] }]).items.map(item => item.id), [2]);
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/data-acw-item="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(ids, HOMEPAGE_ITEMS.map(item => item.id));
});

test("user lists distinguish PDF retrievals from confirmed viewer sessions without updates", async () => {
  const { DB, db } = database();
  const id = await session(db, DB);
  const insert = db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,?,?,?)");
  insert.run("raw", midnight + 10, "pdf_request", PDF, "b".repeat(64));
  insert.run("home", midnight + 10, "page_view", "/", "c".repeat(64));
  const waitingId = crypto.randomUUID();
  insert.run(waitingId, midnight + 10, "pdf_request", PDF, "d".repeat(64));
  await startReading(DB, waitingId, "d".repeat(64));
  // An older viewer session does not confirm this period's new raw retrieval.
  insert.run("later-raw", midnight + 10, "pdf_request", PDF, visitor);
  let result = await report(DB, "view=users&start=2026-09-17&end=2026-09-17");
  const row = prefix => result.rows.find(value => value.id === prefix.repeat(24));
  assert.equal(row("a").pdfViewerSessions, 0);
  assert.equal(row("b").pdfViews, 1); assert.equal(row("b").pdfViewerSessions, 0);
  assert.equal(row("c").pdfViews, 0); assert.equal(row("c").pdfViewerSessions, 0);
  assert.equal(row("d").pdfViews, 1); assert.equal(row("d").pdfViewerSessions, 1);
  assert.equal(row("d").measuredPdfViews, 0);
  await saveReading(DB, snapshot(id), visitor, now);
  result = await report(DB, "view=users&start=2026-09-17&end=2026-09-17");
  assert.equal(row("a").pdfViewerSessions, 1);
  assert.equal(row("a").measuredPdfViews, 1);
});

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

test("live fallback uses recent unmeasured activity consistently in lists and profiles", async () => {
  const { DB, db } = database(), current = Math.floor(Date.now() / 1000);
  const hashes = new Map();
  const insert = db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,bot,duplicate_of,is_personal) VALUES(?,?,?,?,?,?,?,?)");
  const fixtures = [
    ["raw", "pdf_request", PDF, 120], ["expired", "pdf_request", PDF, 301],
    ["home", "page_view", "/index.html", 60], ["click", "outbound_click", "/", 70],
    ["waiting", "pdf_request", PDF, 90], ["paused", "pdf_request", PDF, 10],
    ["host", "pdf_request", PDF, 80], ["registered", "pdf_request", PDF, 90],
    ["future", "pdf_request", PDF, -60], ["bot", "pdf_request", PDF, 10],
    ["duplicate", "pdf_request", PDF, 10], ["pdf-click-only", "pdf_click", PDF, 10],
    ["anonymous", "pdf_request", PDF, 10],
  ];
  for (const [id, kind, path, age] of fixtures) {
    const hash = id === "anonymous" ? "" : await visitorHash(id);
    hashes.set(id, hash);
    insert.run(id, current - age, kind, path, hash, id === "bot" ? 1 : 0, id === "duplicate" ? "original" : "", id === "host" ? 1 : 0);
    if (["waiting", "paused", "host"].includes(id)) await startReading(DB, id, hash);
  }
  db.exec("UPDATE reading_sessions SET seq=1, active=0 WHERE id='paused'");
  db.prepare("INSERT INTO personal_visitors(visitor_hash) VALUES(?)").run(hashes.get("registered"));
  insert.run("click-home", current - 600, "page_view", "/", hashes.get("click"), 0, "", 0);
  // An old tracked visit does not prevent fallback on a new raw retrieval.
  insert.run("older-session", current - 600, "pdf_request", PDF, hashes.get("raw"), 0, "", 0);
  await startReading(DB, "older-session", hashes.get("raw"));
  db.exec("UPDATE reading_sessions SET seq=1 WHERE id='older-session'");
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  const expected = ["raw", "home", "click", "waiting"].map(id => hashes.get(id).slice(0,24)).sort();
  const live = await report(DB, "view=live");
  assert.deepEqual(live.rows.map(row => row.id).sort(), expected);
  const users = await report(DB, "view=users");
  assert.deepEqual(users.rows.filter(row => row.liveAt > 0).map(row => row.id).sort(), expected);
  for (const row of live.rows) {
    assert.equal(row.liveUntil, row.liveAt + 300);
    const profile = await report(DB, `view=users&user=${row.id}`);
    assert.equal(profile.engagement.liveAt, row.liveAt);
    assert.equal(profile.engagement.liveUntil, row.liveUntil);
  }
  assert.equal((await report(DB, "view=live&excludePersonal=0")).rows.length, 6);
  const filtered = await report(DB, `view=live&page=${encodeURIComponent(PDF)}`);
  assert.deepEqual(filtered.rows.map(row => row.id).sort(), ["raw", "waiting"].map(id => hashes.get(id).slice(0,24)).sort());
  assert.deepEqual((await report(DB, "view=live&page=%2F")).rows.map(row => row.id).sort(), ["home", "click"].map(id => hashes.get(id).slice(0,24)).sort());
  assert.equal((await report(DB, "view=live&start=2020-01-01&end=2020-01-01")).rows.length, 0);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
  // A received pause supersedes the unmeasured-view fallback immediately.
  db.exec("UPDATE reading_sessions SET seq=1, active=0 WHERE id='waiting'");
  assert.equal((await report(DB, "view=live")).rows.length, 3);
});

test("live reports skip historical scans when empty and index only the recent cohort", async () => {
  const { DB, db } = database(), current = Math.floor(Date.now() / 1000);
  const queries = [], plans = [];
  const inspected = { ...DB, prepare: sql => ({ bind: (...params) => {
    queries.push(sql);
    plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
    return DB.prepare(sql).bind(...params);
  } }) };
  const insert = db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,'pdf_request',?,?)");
  for (let i = 0; i < 100; i++) insert.run(String(i), current - 1000, PDF, await visitorHash(String(i)));
  const empty = await report(inspected, "view=live");
  assert.deepEqual(empty.rows, []);
  assert.equal(queries.length, 1);
  assert.equal(empty.queryUsage.queries[0].name, "userLiveActivity");
  queries.length = 0; plans.length = 0;
  insert.run("recent", current, PDF, visitor);
  const live = await report(inspected, "view=live");
  assert.equal(live.rows.length, 1);
  assert.equal(live.rows[0].id, visitor.slice(0,24));
  assert.equal(live.queryUsage.queries.filter(row => row.name === "userLiveActivity").length, 1);
  assert.ok(plans[1].some(row => row.detail.includes("events_user_history")));
});

test("headline engagement includes homepage time and honors page and personal filters", async () => {
  const { DB, db } = database();
  const pdf = await session(db, DB), home = await session(db, DB, { path: "/", kind: "page_view" }), own = await session(db, DB);
  await saveReading(DB, snapshot(pdf), visitor, now);
  await saveReading(DB, snapshot(home, { downloads: 0, hours: [{ hour: midnight, milliseconds: 300000, downloads: 0 }] }), visitor, now);
  await saveReading(DB, snapshot(own), visitor, now);
  // Historical personal measurements remain available after collection stops.
  db.prepare("UPDATE reading_sessions SET is_personal=1 WHERE id=?").run(own);
  db.prepare("UPDATE events SET is_personal=1 WHERE id=?").run(own);
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
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(await saveReading(DB, snapshot(id, { seq: 2 }), visitor, now), 204);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, 1);
});

test("personal sessions keep viewer confirmation but never save reading or downloads", async () => {
  const { DB, db } = database(), id = await session(db, DB, { personal: 1 });
  const changes = db.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(await saveReading(DB, snapshot(id), visitor, now), 204);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n, changes);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, -1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours").get().n, 0);
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
  assert.deepEqual(before.rows.find(row => row.id === pending), { id: pending, botScore: null, botScoreAt: null, assessmentStatus: "unassessed", readingStatus: "no_updates" });
  assert.deepEqual(before.rows.find(row => row.id === tracked), { id: tracked, botScore: null, botScoreAt: null, assessmentStatus: "unassessed", readingStatus: "tracked", readingSeconds: 0, downloads: 0 });
  const after = await historyReading(DB, dates("2026-09-17"), false, [tracked]);
  assert.deepEqual(after.rows[0], { id: tracked, botScore: null, botScoreAt: null, assessmentStatus: "unassessed", readingStatus: "outside_period" });
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
  const navigationWithoutHtml = await worker.fetch(new Request(ORIGIN + PDF, { headers: { Accept: "application/pdf", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", Cookie: cookie } }), env, ctx);
  assert.match(navigationWithoutHtml.headers.get("Content-Type"), /text\/html/);
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
    const response = await worker.fetch(new Request(ORIGIN + path, { method, headers: { Accept: "application/pdf", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", ...headers } }), env, ctx);
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
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }, { Cookie: "__Host-acw_ignore=1" }, { Cookie: `__Host-acw_personal=1; __Host-acw_visitor=${cookieId}` }, { "User-Agent": "Googlebot" }]) assert.equal((await call(headers)).status, 204);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, -1);
  assert.equal((await call()).status, 204);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, 1);
});
