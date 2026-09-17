import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { headlineSummary } from "../src/summary.mjs";
import { reportDates } from "../src/worker.mjs";

const MIGRATION = readFileSync(new URL("../migrations/0010_headline_summaries.sql", import.meta.url), "utf8");
const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);

function database(migrate = true) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const name of readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql")).sort()) {
    if (!migrate && name.startsWith("0010_")) continue;
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const queries = [], plans = [];
  const DB = {
    prepare: sql => ({ bind: (...args) => ({ all: async () => {
      queries.push(sql);
      plans.push(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
      return { results: db.prepare(sql).all(...args) };
    } }) }),
    batch: queries => Promise.all(queries.map(query => query.all())),
  };
  return { db, DB, queries, plans };
}

function insert(db, { id = crypto.randomUUID(), time = "2026-09-16T12:00:00Z", kind = "page_view", visitor = A, personal = 0, bot = 0, duplicate = "", path = "/" } = {}) {
  db.prepare(`INSERT OR IGNORE INTO events(id, occurred_at, kind, path, visitor_hash, is_personal, bot, duplicate_of)
    VALUES(?,?,?,?,?,?,?,?)`).run(id, typeof time === "number" ? time : Date.parse(time) / 1000, kind, path, visitor, personal, bot, duplicate);
  return id;
}

function dates(start = "2026-09-16", end = start) {
  return reportDates(new URL(`https://example.com/?start=${start}&end=${end}`));
}

function rawSummary(db, range, excludePersonal) {
  const period = "occurred_at >= ? AND occurred_at < ? AND duplicate_of = ''";
  const personal = "(is_personal = 1 OR visitor_hash IN (SELECT visitor_hash FROM personal_visitors))";
  const totals = db.prepare(`SELECT kind, bot, COUNT(*) AS count, COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors,
    COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests
    FROM events WHERE ${period}${excludePersonal ? ` AND NOT ${personal}` : ""} GROUP BY kind, bot ORDER BY kind, bot`).all(range.from, range.until);
  const personalActivity = db.prepare(`SELECT COUNT(*) AS events FROM events WHERE ${period} AND bot = 0
    AND kind IN ('page_view','pdf_request','outbound_click') AND ${personal}`).get(range.from, range.until);
  return JSON.parse(JSON.stringify({ totals, personalActivity }));
}

async function matchesRaw(fixture, range = dates()) {
  for (const exclude of [false, true]) {
    const { totals, personalActivity } = await headlineSummary(fixture.DB, range, exclude);
    assert.deepEqual({ totals, personalActivity }, rawSummary(fixture.db, range, exclude));
  }
}

function matchesBuckets(db) {
  const counters = db.prepare(`SELECT occurred_at - occurred_at % 3600 AS hour, kind, bot, is_personal,
    COUNT(*) AS requests, COUNT(NULLIF(visitor_hash,'')) AS identified_requests FROM events
    WHERE duplicate_of = '' GROUP BY hour, kind, bot, is_personal ORDER BY hour, kind, bot, is_personal`).all();
  const members = db.prepare(`SELECT occurred_at - occurred_at % 3600 AS hour, kind, bot, is_personal, visitor_hash,
    COUNT(*) AS requests FROM events WHERE duplicate_of = '' AND visitor_hash != ''
    GROUP BY hour, kind, bot, is_personal, visitor_hash ORDER BY hour, kind, bot, is_personal, visitor_hash`).all();
  assert.deepEqual(db.prepare("SELECT * FROM analytics_hour_totals ORDER BY hour, kind, bot, is_personal").all(), counters);
  assert.deepEqual(db.prepare("SELECT * FROM analytics_hour_visitors ORDER BY hour, kind, bot, is_personal, visitor_hash").all(), members);
}

test("backfill preserves raw history and matches counts, unknown identities, bots and personal filters", async () => {
  const fixture = database(false), { db } = fixture;
  for (let i = 0; i < 240; i++) insert(db, {
    id: String(i), time: Date.parse("2026-09-16T06:00:00Z") / 1000 + i * 500,
    kind: ["page_view", "pdf_request", "outbound_click", "pdf_click", "page_request"][i % 5],
    visitor: [A, B, C, ""][i % 4], personal: i % 7 === 0 ? 1 : 0, bot: i % 11 === 0 ? 1 : 0,
    duplicate: i % 13 === 0 ? "original" : "",
  });
  db.prepare("INSERT INTO personal_visitors VALUES(?)").run(B);
  const before = db.prepare("SELECT * FROM events ORDER BY rowid").all();
  db.exec(MIGRATION);
  assert.deepEqual(db.prepare("SELECT * FROM events ORDER BY rowid").all(), before);
  matchesBuckets(db);
  for (const range of [dates("2026-09-15", "2026-09-17"), dates(), dates("2026-09-17"), dates("2026-10-01")]) await matchesRaw(fixture, range);
  // Re-running the snapshot portion replaces values instead of double counting.
  db.exec(MIGRATION.slice(MIGRATION.indexOf("-- Install triggers first.")));
  matchesBuckets(db);
  db.close();
});

test("distinct users deduplicate across hours, days, documents and personal classifications", async () => {
  const fixture = database(), { db, DB } = fixture;
  for (const time of ["2026-09-16T10:00:00Z", "2026-09-16T12:00:00Z", "2026-09-17T20:00:00Z"]) {
    for (const path of ["/cv.pdf", "/paper.pdf"]) insert(db, { time, kind: "pdf_request", path });
    insert(db, { time, kind: "pdf_request", visitor: B });
  }
  insert(db, { kind: "pdf_request", personal: 1 });
  insert(db, { kind: "pdf_request", visitor: "" });
  insert(db, { kind: "pdf_request", visitor: "", personal: 1 });
  const range = dates("2026-09-16", "2026-09-17");
  const before = await headlineSummary(DB, range, false);
  assert.equal(before.totals[0].visitors, 2);
  assert.equal(before.totals[0].count, 12);
  await matchesRaw(fixture, range);
  // Marking an existing browser must immediately classify its historical visits.
  db.prepare("INSERT INTO personal_visitors VALUES(?)").run(A);
  const excluded = await headlineSummary(DB, range, true);
  assert.deepEqual(excluded.totals, [{ kind: "pdf_request", bot: 0, count: 4, visitors: 1, identifiedRequests: 3, unidentifiedRequests: 1 }]);
  assert.equal(excluded.personalActivity.events, 8);
  await matchesRaw(fixture, range);
  // Unmarking rotates identity; old marked history remains personal.
  insert(db, { kind: "pdf_request", visitor: C });
  await matchesRaw(fixture, range);
  assert.equal((await headlineSummary(DB, range, true)).totals[0].visitors, 2);
  db.close();
});

test("insert retries, duplicate corrections, dimension changes and deletes keep rollups exact", async () => {
  const fixture = database(), { db } = fixture;
  const first = insert(db, { id: "original" });
  insert(db, { id: "second" });
  insert(db, { id: first });
  insert(db, { id: "retry", duplicate: first });
  matchesBuckets(db);
  for (const sql of [
    "UPDATE events SET duplicate_of = 'original' WHERE id = 'second'",
    "UPDATE events SET duplicate_of = '' WHERE id = 'second'",
    "UPDATE events SET visitor_hash = '', is_personal = 1, kind = 'pdf_request', bot = 1, occurred_at = occurred_at + 3600 WHERE id = 'second'",
    "UPDATE events SET duplicate_of = '' WHERE id = 'retry'",
    "UPDATE events SET path = '/cv.pdf' WHERE id = 'original'",
    "DELETE FROM events WHERE id = 'original'",
    "DELETE FROM events",
  ]) {
    db.exec(sql);
    matchesBuckets(db);
    await matchesRaw(fixture);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_hour_visitors").get().n, 0);
  db.close();
});

test("Pacific midnight and both daylight-saving transitions match raw date filtering", async () => {
  const fixture = database(), { db, DB } = fixture;
  for (const [day, hours] of [["2026-03-08", 23], ["2026-11-01", 25]]) {
    const range = dates(day);
    assert.equal(range.until - range.from, hours * 3600);
    for (const time of [range.from - 1, range.from, range.from + 3600, range.until - 1, range.until]) insert(db, { time });
    await matchesRaw(fixture, range);
    const summary = await headlineSummary(DB, range, true);
    assert.equal(summary.totals[0].count, 3);
    assert.equal(summary.totals[0].visitors, 1);
  }
  db.close();
});

test("ten thousand repeated views use compact summaries and no raw event reads", async () => {
  const fixture = database(), { db, DB, queries, plans } = fixture;
  db.exec("BEGIN");
  for (let i = 0; i < 10000; i++) insert(db, { id: String(i), visitor: i % 2 ? A : B });
  db.exec("COMMIT");
  const result = await headlineSummary(DB, dates(), true);
  assert.equal(result.totals[0].count, 10000);
  assert.equal(result.totals[0].visitors, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_hour_totals").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_hour_visitors").get().n, 2);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(sql => !/\b(?:FROM|JOIN)\s+events\b/i.test(sql)));
  assert.ok(plans.every(plan => plan.some(row => /USING PRIMARY KEY.*hour>\? AND hour<\?/.test(row.detail))));
  matchesBuckets(db);
  await matchesRaw(fixture);
  db.close();
});

test("a failed rollup update rolls back the event and other summary writes atomically", () => {
  const { db } = database();
  db.exec(`CREATE TRIGGER fail_summary BEFORE INSERT ON analytics_hour_visitors
    BEGIN SELECT RAISE(ABORT, 'test rollup failure'); END;`);
  assert.throws(() => insert(db), /test rollup failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analytics_hour_totals").get().n, 0);
  db.close();
});
