import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker, { reportDates } from "../src/worker.mjs";

const MIGRATION = readFileSync(new URL("../migrations/0022_activity_rollups.sql", import.meta.url), "utf8");
const A = "a".repeat(64), B = "b".repeat(64), SECRET = "local-test-only-secret-with-32-characters";

function fixture(migrate = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    if (!migrate && file >= "0022_") continue;
    db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const plans = [], queries = [];
  const DB = { prepare: sql => ({ bind: (...args) => ({ all: async () => {
    queries.push(sql);
    plans.push(db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(row => row.detail));
    return { results: db.prepare(sql).all(...args) };
  } }) }), batch: statements => Promise.all(statements.map(s => s.all())) };
  return { db, DB, plans, queries };
}

function insert(db, values = {}) {
  const row = { id: crypto.randomUUID(), occurred_at: Date.parse("2026-09-18T12:00:00Z") / 1000,
    kind: "pdf_request", path: "/a.pdf", visitor_hash: A, ...values };
  db.prepare(`INSERT INTO events(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  return row.id;
}

function assertBuckets(db) {
  const columns = db.prepare("PRAGMA table_info(analytics_activity_hours)").all().map(row => row.name).filter(name => name !== "requests");
  const dimensions = columns.slice(1).join(",");
  const expected = db.prepare(`SELECT occurred_at - occurred_at % 3600 AS occurred_at, ${dimensions}, COUNT(*) AS requests
    FROM events WHERE duplicate_of = '' GROUP BY occurred_at - occurred_at % 3600, ${dimensions}
    ORDER BY ${columns.join(",")}`).all();
  assert.deepEqual(db.prepare(`SELECT * FROM analytics_activity_hours ORDER BY ${columns.join(",")}`).all(), expected);
}

async function report(f, options = {}) {
  const params = new URLSearchParams({ start: "2026-09-18", end: "2026-09-18", view: "papers", ...options });
  const result = await worker.fetch(new Request("https://www.andrewcwmyers.com/__analytics/report?" + params,
    { headers: { Authorization: "Bearer " + SECRET } }), { DB: f.DB, READ_TOKEN: SECRET }, {});
  assert.equal(result.status, 200);
  return result.json();
}

test("backfill leaves raw records intact and preserves every aggregate dimension", () => {
  const { db } = fixture(false);
  for (let i = 0; i < 200; i++) insert(db, { id: String(i), visitor_hash: [A, B, ""][i % 3],
    country: ["US", "GB", ""][i % 3], region: "CA", county: "County", county_fips: "06001",
    city: "City " + i % 3, browser: "Chrome", device: "Desktop", os: "macOS", referrer: "example.com",
    referrer_status: ["known", "direct", "unknown"][i % 3], source: "newsletter", medium: "email", campaign: "paper",
    target: "https://example.com", kind: ["pdf_request", "page_view", "outbound_click", "pdf_click"][i % 4],
    is_personal: i % 5 === 0 ? 1 : 0, bot: i % 7 === 0 ? 1 : 0, duplicate_of: i % 11 === 0 ? "original" : "" });
  const original = db.prepare("SELECT * FROM events ORDER BY rowid").all();
  db.exec(MIGRATION);
  assert.deepEqual(db.prepare("SELECT * FROM events ORDER BY rowid").all(), original);
  assertBuckets(db);
  db.exec(MIGRATION.slice(MIGRATION.indexOf("-- Replace each bucket")));
  assertBuckets(db);
  db.close();
});

test("corrections, deletions and duplicate retries update summaries atomically", () => {
  const { db } = fixture();
  insert(db, { id: "original" }); insert(db, { id: "second" });
  insert(db, { id: "duplicate", duplicate_of: "original" });
  const columns = db.prepare("PRAGMA table_info(analytics_activity_hours)").all().map(row => row.name).filter(name => name !== "requests");
  for (const column of columns) {
    const value = column === "occurred_at" ? 1789736400 : ["bot", "is_personal"].includes(column) ? 1 : "changed";
    db.prepare(`UPDATE events SET ${column} = ? WHERE id = 'second'`).run(value);
    assertBuckets(db);
  }
  for (const sql of ["UPDATE events SET duplicate_of = 'original' WHERE id = 'second'",
    "UPDATE events SET duplicate_of = '' WHERE id = 'duplicate'", "DELETE FROM events WHERE id = 'original'", "DELETE FROM events"]) {
    db.exec(sql); assertBuckets(db);
  }
  db.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON analytics_activity_hours BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(() => insert(db), /test failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM analytics_hour_totals").get().n, 0);
  db.close();
});

test("ten thousand views collapse to memberships, with exact distinct users and retroactive host filtering", async () => {
  const f = fixture(), { db } = f;
  db.exec("BEGIN");
  for (let i = 0; i < 10000; i++) insert(db, { id: String(i), visitor_hash: i % 2 ? A : B });
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM analytics_activity_hours").get().n, 2);
  let result = await report(f);
  assert.equal(result.items[0].count, 10000); assert.equal(result.items[0].visitors, 2);
  assert.ok(f.plans[0].some(plan => /USING COVERING INDEX analytics_activity_kind_time/.test(plan)));
  assert.ok(!/\bFROM events\b/.test(f.queries[0]));
  db.prepare("INSERT INTO personal_visitors VALUES(?)").run(A);
  result = await report(f);
  assert.equal(result.items[0].count, 5000); assert.equal(result.items[0].visitors, 1);
  insert(db, { visitor_hash: "" });
  result = await report(f);
  assert.equal(result.items[0].count, 5001); assert.equal(result.items[0].visitors, 1);
  assert.equal(result.items[0].unidentifiedRequests, 1);
  assert.equal((await report(f, { excludePersonal: "0" })).items[0].count, 10001);
  db.close();
});

test("hourly memberships preserve Pacific boundaries and distinct users across days and paths", async () => {
  const f = fixture(), { db } = f;
  for (const day of ["2026-03-08", "2026-11-01", "2026-09-18"]) {
    const range = reportDates(new URL("https://example.com/?start=" + day + "&end=" + day));
    for (const occurred_at of [range.from - 1, range.from, range.from + 3601, range.until - 1, range.until]) insert(db, { occurred_at });
    const result = await report(f, { start: day, end: day });
    assert.equal(result.items[0].count, 3); assert.equal(result.items[0].visitors, 1);
    assert.equal((await report(f, { start: day, end: day, page: "/missing.pdf" })).items.length, 0);
  }
  insert(db, { path: "/index" }); insert(db, { path: "/index.html" }); insert(db, { path: "/" });
  const homepage = await report(f, { page: "/" });
  assert.equal(homepage.items[0].count, 3); assert.equal(homepage.items[0].visitors, 1);
  assertBuckets(db);
  db.close();
});

test("latest user metadata is resolved after pagination, including timestamp ties", async () => {
  const f = fixture(), { db } = f;
  for (let i = 0; i < 40; i++) {
    const visitor_hash = i.toString(16).padStart(24, "0").padEnd(64, "a");
    insert(db, { visitor_hash, city: "Earlier" });
    insert(db, { visitor_hash, city: "Later", path: "/b.pdf" });
  }
  const first = await report(f, { view: "users" }), second = await report(f, { view: "users", offset: "15" });
  assert.equal(first.rows.length, 15); assert.equal(second.rows.length, 15);
  assert.ok(first.rows.every(row => row.city === "Later" && row.lastPath === "/b.pdf" && row.views === 2));
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 30);
  const list = f.queries.findIndex(sql => sql.startsWith("WITH candidates AS"));
  assert.ok(list >= 0); assert.doesNotMatch(f.queries[list], /ROW_NUMBER/);
  assert.ok(f.plans[list].some(plan => plan.includes("events_user_history")));
  assert.ok(f.plans[list].some(plan => plan.includes("USING COVERING INDEX events_activity_time")));
  db.close();
});

test("continued sessions on either side of the range remain eligible exactly once", async () => {
  const f = fixture(), { db } = f;
  const range = reportDates(new URL("https://example.com/?start=2026-09-18&end=2026-09-18"));
  for (const [visitor_hash, occurred_at] of [[A, range.from - 10], [B, range.until + 1]]) {
    const id = insert(db, { visitor_hash, occurred_at });
    db.prepare(`INSERT INTO reading_sessions(id, visitor_hash, path, kind, is_personal, started_at, last_seen)
      VALUES(?,?, '/a.pdf', 'pdf_request', 0,?,?)`).run(id, visitor_hash, occurred_at, occurred_at);
    db.prepare("INSERT INTO reading_hours(session_id,hour,milliseconds) VALUES(?,?,1000)").run(id, range.until - 3600);
  }
  insert(db, { visitor_hash: "c".repeat(64), occurred_at: range.until + 1 });
  const result = await report(f, { view: "users" });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.events === 1 && row.views === 0 && row.pdfViews === 1));
  db.close();
});
