import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { reportDates } from "../src/worker.mjs";
import { startReading, saveReading, historyReading } from "../src/engagement.mjs";
import { clientDetails, validInteractions } from "../src/visit-details.mjs";
import { pdfPageReport } from "../src/pdf-page-report.mjs";
import { homepageReport } from "../src/homepage-report.mjs";

const origin = "https://www.andrewcwmyers.com", visitor = "a".repeat(64);
const now = Date.parse("2026-09-18T12:00:00Z"), hour = now / 1000 - 3600;

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const file of readdirSync(new URL("../migrations", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const DB = { prepare: sql => ({ bind: (...values) => ({ run: async () => db.prepare(sql).run(...values), all: async () => ({ results: db.prepare(sql).all(...values) }) }) }),
    batch: async statements => { const results = []; for (const statement of statements) results.push(await statement.all()); return results; } };
  return { db, DB };
}

function insert(db, time, kind = "pdf_request", who = visitor, extra = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,is_personal,bot,duplicate_of) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, time, kind, kind === "pdf_request" ? "/paper.pdf" : "/", who, extra.personal || 0, extra.bot || 0, extra.duplicate || "");
  return id;
}

test("edge network fields accompany existing raw and browser event rows; body cannot forge them", async () => {
  const { db, DB } = database(), tasks = [], ctx = { waitUntil: p => tasks.push(p) };
  const env = { DB, ORIGIN: { fetch: async () => new Response("pdf", { headers: { "Content-Type": "application/pdf" } }) } };
  for (const browser of [false, true]) {
    const request = new Request(origin + (browser ? "/__analytics/event" : "/paper.pdf"), browser
      ? { method: "POST", headers: { Origin: origin }, body: JSON.stringify({ id: crypto.randomUUID(), kind: "page_view", path: "/", networkOwner: "forged", networkAsn: 123 }) } : {});
    request.cf = { asn: 32, asOrganization: "Stanford\u0000 University" };
    assert.equal((await worker.fetch(request, env, ctx)).status, browser ? 204 : 200);
  }
  await Promise.all(tasks);
  const rows = db.prepare("SELECT network_asn,network_org FROM events").all();
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.network_asn === 32 && row.network_org === "Stanford University"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours").get().n, 0);
});

test("client details are bounded and allowlisted; action counters reject unknown data", () => {
  assert.deepEqual(clientDetails({ languages: ["en-US", "bad@email.com"], viewport: [390,844], query: "secret", cookies: "secret", assessment: "script_failed", loadMs: -1 }),
    { languages: ["en-US"], viewport: [390,844], assessment: "script_failed" });
  assert.equal(clientDetails({ viewport: [Infinity, 4], assessment: "arbitrary private error", loadMs: 3600001 }), null);
  const actions = { searches: 1, prints: 0, outline: 2, zoom: 3 };
  assert(validInteractions(actions));
  for (const value of [{ ...actions, query: "private" }, { ...actions, searches: -1 }, { ...actions, zoom: 10001 }, { ...actions, prints: 1.5 }]) assert.equal(validInteractions(value), false);
});

test("details and hourly interactions reuse writes, are monotonic, owner-bound and date-scoped", async () => {
  const { db, DB } = database(), id = insert(db, hour);
  await startReading(DB, id, visitor);
  const body = { id, seq: 1, active: true, milliseconds: 1000, downloads: 0, at: now,
    clientDetails: { languages: ["en-US"], loadMs: 1400, assessment: "script_failed", secret: "do-not-store" },
    hours: [{ hour, milliseconds: 1000, downloads: 0, interactions: { searches: 1, prints: 0, outline: 0, zoom: 2 } }] };
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - before, 2);
  assert.equal(await saveReading(DB, body, visitor, now), 204);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - before, 2);
  assert.equal(await saveReading(DB, body, "b".repeat(64), now), 404);
  await saveReading(DB, { ...body, seq: 2, hours: [{ ...body.hours[0], interactions: { searches: 0, prints: 0, outline: 0, zoom: 2 } }] }, visitor, now);
  assert.equal(db.prepare("SELECT seq FROM reading_sessions").get().seq, 1);
  assert.equal(await saveReading(DB, { ...body, seq: 2, clientDetails: { viewport: [400,800] } }, visitor, now), 204);
  const dates = reportDates(new URL(origin + "?start=2026-09-18&end=2026-09-18"));
  const history = (await historyReading(DB, dates, false, [id])).rows[0];
  assert.equal(history.interactions.searches, 1);
  assert.equal(history.clientDetails.loadMs, 1400);
  assert.equal(history.clientDetails.secret, undefined);
  assert.equal(history.assessmentStatus, "unassessed");
  assert.equal((await historyReading(DB, { from: now / 1000, until: now / 1000 + 3600 }, false, [id])).rows[0].interactions, undefined);
  const personal = insert(db, hour, "pdf_request", visitor, { personal: 1 });
  await startReading(DB, personal, visitor);
  await saveReading(DB, { ...body, id: personal }, visitor, now);
  assert.equal(db.prepare("SELECT client_details FROM reading_sessions WHERE id=?").get(personal).client_details, null);
});

test("homepage averages combine hours per session and preserve filters and missing versus zero", async () => {
  const { db, DB } = database();
  const a = insert(db, hour - 3600, "page_view"), b = insert(db, hour, "page_view"), personal = insert(db, hour, "page_view", visitor, { personal: 1 });
  for (const id of [a,b,personal]) await startReading(DB, id, visitor);
  insert(db, hour, "page_view"); // no timed session, excluded from denominator
  const add = (id, at, items) => db.prepare("INSERT INTO reading_hours(session_id,hour,attention) VALUES(?,?,?)").run(id, at, JSON.stringify({ depth: 10, scrolled: 1, sections: 3, items }));
  add(a, hour - 3600, [[1,10000,0,0]]);
  add(a, hour, [[1,20000,0,0],[2,4000,0,0]]);
  add(b, hour, [[1,0,0,0]]);
  add(personal, hour, [[3,100000,0,0]]);
  const dates = { from: hour - 3600, until: hour + 3600 };
  const result = await homepageReport(DB, dates, true);
  assert.equal(result.measuredSessions, 2);
  assert.deepEqual(result.homepageItems.slice(0,3).map(({ sessions, totalSeconds, averageSeconds }) => ({ sessions, totalSeconds, averageSeconds })), [
    { sessions: 2, totalSeconds: 30, averageSeconds: 15 },
    { sessions: 1, totalSeconds: 4, averageSeconds: 4 },
    { sessions: 0, totalSeconds: 0, averageSeconds: null },
  ]);
  assert.equal((await homepageReport(DB, { from: hour, until: hour + 3600 }, true)).homepageItems[0].averageSeconds, 10);
  assert.equal((await homepageReport(DB, dates, false)).homepageItems[2].averageSeconds, 100);
  assert.equal((await homepageReport(DB, { from: hour + 3600, until: hour + 7200 }, false)).measuredSessions, 0);
  const plans = [];
  await homepageReport({ prepare: sql => ({ bind: (...params) => { plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)); return DB.prepare(sql).bind(...params); } }) }, dates, true);
  assert(plans[0].some(row => row.detail.includes("reading_homepage_path")));
  const headers = { Authorization: "Bearer test-only-report-secret-32-characters" }, env = { DB, READ_TOKEN: "test-only-report-secret-32-characters" };
  const url = origin + "/__analytics/report?view=homepage_attention&section=main&name=/&start=2026-09-18&end=2026-09-18";
  assert.equal((await worker.fetch(new Request(url), env, {})).status, 401);
  const response = await worker.fetch(new Request(url, { headers }), env, {}), value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.queryUsage.queryCount, 1); assert.equal(value.homepageItems.length, 15);
  for (const [key, invalid] of [["page", "/paper.pdf"], ["name", "/paper.pdf"], ["section", "outbound"]]) {
    const invalidUrl = new URL(url); invalidUrl.searchParams.set(key, invalid);
    assert.equal((await worker.fetch(new Request(invalidUrl, { headers }), env, {})).status, 400);
  }
});

test("per-page averages count each reached reading session once across hours and exclude unmeasured requests", async () => {
  const { db, DB } = database();
  const a = insert(db, hour - 3600), b = insert(db, hour), old = insert(db, hour), personal = insert(db, hour, "pdf_request", visitor, { personal: 1 });
  for (const id of [a,b,old,personal]) await startReading(DB, id, visitor);
  const add = (id, at, attention) => db.prepare("INSERT INTO reading_hours(session_id,hour,pdf_attention) VALUES(?,?,?)").run(id, at, JSON.stringify(attention));
  add(a, hour - 3600, { total: 3, pages: [1], scrolled: 0, seconds: [10,0,0] });
  add(a, hour, { total: 3, pages: [3], scrolled: 1, seconds: [20,4,0] });
  add(b, hour, { total: 3, pages: [1], scrolled: 0, seconds: [0,0,0] });
  add(old, hour, { total: 3, pages: [7], scrolled: 1 });
  add(personal, hour, { total: 3, pages: [4], scrolled: 1, seconds: [0,0,100] });
  insert(db, hour); // native retrieval, no session
  const dates = { from: hour - 3600, until: hour + 3600 };
  const result = await pdfPageReport(DB, dates, "/paper.pdf", true);
  assert.equal(result.measuredSessions, 2);
  assert.deepEqual(result.pdfPages, [
    { page: 1, sessions: 2, totalSeconds: 30, averageSeconds: 15 },
    { page: 2, sessions: 1, totalSeconds: 4, averageSeconds: 4 },
    { page: 3, sessions: 0, totalSeconds: 0, averageSeconds: null },
  ]);
  assert.equal((await pdfPageReport(DB, { from: hour, until: hour + 3600 }, "/paper.pdf", true)).pdfPages[0].averageSeconds, 10);
  assert.equal((await pdfPageReport(DB, dates, "/paper.pdf", false)).pdfPages[2].averageSeconds, 100);
  assert.equal((await pdfPageReport(DB, dates, "/other.pdf", false)).measuredSessions, 0);
  const plans = [];
  await pdfPageReport({ prepare: sql => ({ bind: (...params) => { plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)); return DB.prepare(sql).bind(...params); } }) }, dates, "/paper.pdf", true);
  assert(plans[0].some(row => row.detail.includes("reading_pdf_path")));
  const headers = { Authorization: "Bearer test-only-report-secret-32-characters" };
  const env = { DB, READ_TOKEN: headers.Authorization.slice(7) };
  const url = origin + "/__analytics/report?view=pdf_pages&name=/paper.pdf&start=2026-09-18&end=2026-09-18";
  assert.equal((await worker.fetch(new Request(url), env, {})).status, 401);
  const response = await worker.fetch(new Request(url, { headers }), env, {});
  const value = await response.json();
  assert.equal(response.status, 200); assert.equal(value.queryUsage.queryCount, 1); assert.equal(value.view, "pdf_pages");
  assert.equal((await worker.fetch(new Request(url + "&page=/other.pdf", { headers }), env, {})).status, 400);
});
