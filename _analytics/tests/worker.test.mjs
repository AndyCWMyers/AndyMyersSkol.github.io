import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import worker, { agentInfo, cleanPath, cleanUrl, initialPdfRequest, optedOut, reportDates } from "../src/worker.mjs";
import startAnalytics from "../src/client.mjs";

const ORIGIN = "https://www.andrewcwmyers.com";
const SECRET = "test-only-token-not-a-production-secret";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const prepare = (sql) => ({ bind: (...params) => ({
    run: async () => db.prepare(sql).run(...params),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  }) });
  return { db, DB: { prepare, batch: (queries) => Promise.all(queries.map(q => q.all())) } };
}

function context() {
  const pending = [];
  return { waitUntil: promise => pending.push(promise), finish: () => Promise.all(pending) };
}

function request(path, init) { return new Request(ORIGIN + path, init); }

test("privacy normalization discards credentials, fragments and query strings", () => {
  assert.equal(cleanUrl("https://www.wsj.com/news?email=private@example.com#top"), "https://www.wsj.com/news");
  assert.equal(cleanUrl("https://user:password@example.com"), "");
  assert.equal(cleanUrl("javascript:alert(1)"), "");
  assert.equal(cleanPath("//example.com"), null);
  assert.equal(cleanPath("/paper.pdf?token=secret"), "/paper.pdf");
  assert.equal(optedOut(request("/", { headers: { "Sec-GPC": "1" } })), true);
});

test("PDF byte-range handling excludes chunks, HEADs and errors", () => {
  assert.equal(initialPdfRequest(request("/paper.pdf"), new Response("PDF")), true);
  assert.equal(initialPdfRequest(request("/paper.pdf", { headers: { Range: "bytes=0-100" } }), new Response("PDF", { status: 206 })), true);
  assert.equal(initialPdfRequest(request("/paper.pdf", { headers: { Range: "bytes=100-200" } }), new Response("PDF", { status: 206 })), false);
  assert.equal(initialPdfRequest(request("/paper.pdf", { method: "HEAD" }), new Response()), false);
  assert.equal(initialPdfRequest(request("/paper.pdf"), new Response(null, { status: 404 })), false);
});

test("date validation prevents unbounded and malformed queries", () => {
  assert.equal(reportDates(new URL(ORIGIN + "?start=2026-02-30&end=2026-03-01")), null);
  assert.equal(reportDates(new URL(ORIGIN + "?start=2020-01-01&end=2026-01-01")), null);
  assert.equal(reportDates(new URL(ORIGIN + "?start=2026-03-02&end=2026-03-01")), null);
  assert.equal(reportDates(new URL(ORIGIN + "?start=2026-03-01&end=2026-03-01")).until - Date.parse("2026-03-01") / 1000, 86400);
});

test("read API is fail-closed and never exposes an arbitrary SQL endpoint", async () => {
  const { DB } = database();
  for (const token of [undefined, "", "wrong"]) {
    const response = await worker.fetch(request("/__analytics/report", { headers: token ? { Authorization: `Bearer ${token}` } : {} }), { DB, READ_TOKEN: SECRET }, context());
    assert.equal(response.status, 401);
  }
  assert.equal((await worker.fetch(request("/__analytics/sql"), { DB }, context())).status, 404);
  assert.equal((await worker.fetch(new Request("https://alternate.workers.dev/__analytics/report"), { DB }, context())).status, 404);
});

test("browser events require same-origin requests, bounds, recognized kinds and event IDs", async () => {
  const { DB, db } = database();
  const valid = { id: crypto.randomUUID(), kind: "outbound_click", path: "/", target: "https://www.wsj.com/article?secret=x" };
  const post = (body, headers = { Origin: ORIGIN }) => request("/__analytics/event", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(post(valid, { Origin: "https://evil.example" }), { DB }, context())).status, 403);
  for (const body of [null, {}, { ...valid, kind: "sql" }, { ...valid, path: "x" }, { ...valid, id: "x" }, { ...valid, target: "x" }, { ...valid, extra: "x".repeat(5000) }]) {
    assert.equal((await worker.fetch(post(body), { DB }, context())).status, 400);
  }
  const ctx = context();
  assert.equal((await worker.fetch(post(valid), { DB }, ctx)).status, 204);
  assert.equal((await worker.fetch(post(valid), { DB }, ctx)).status, 204);
  await ctx.finish();
  const rows = db.prepare("SELECT * FROM events").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "https://www.wsj.com/article");
  assert.equal("ip" in rows[0], false);
});

test("opt-outs and rate limits do not record browser events", async () => {
  const { DB, db } = database();
  const body = JSON.stringify({ id: crypto.randomUUID(), kind: "page_view", path: "/" });
  assert.equal((await worker.fetch(request("/__analytics/event", { method: "POST", headers: { Origin: ORIGIN, DNT: "1" }, body }), { DB }, context())).status, 204);
  assert.equal((await worker.fetch(request("/__analytics/event", { method: "POST", headers: { Origin: ORIGIN }, body }), { DB, COLLECT_LIMIT: { limit: async () => ({ success: false }) } }, context())).status, 429);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("PDF payload and headers are unchanged while requests are recorded", async () => {
  const { DB, db } = database();
  const ctx = context();
  const ORIGIN = { fetch: async () => new Response("%PDF-example", { headers: { "Content-Type": "application/pdf", ETag: '"original"', "Accept-Ranges": "bytes" } }) };
  const response = await worker.fetch(request("/paper.pdf?private=secret"), { DB, ORIGIN }, ctx);
  assert.equal(await response.text(), "%PDF-example");
  assert.equal(response.headers.get("ETag"), '"original"');
  await ctx.finish();
  assert.equal(db.prepare("SELECT path FROM events").get().path, "/paper.pdf");
});

test("analytics database failure cannot fail a public PDF request", async () => {
  const ctx = context();
  const DB = { prepare: () => { throw new Error("quota exceeded"); } };
  const ORIGIN = { fetch: async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }) };
  assert.equal((await worker.fetch(request("/paper.pdf"), { DB, ORIGIN }, ctx)).status, 200);
  await ctx.finish();
});

test("reports aggregate real SQL results and exclude classified bots", async () => {
  const { DB, db } = database();
  const now = Math.floor(Date.now() / 1000);
  for (const [kind, path, target, bot] of [["pdf_request", "/paper.pdf", "", 0], ["pdf_request", "/paper.pdf", "", 1], ["pdf_click", "/", "/paper.pdf", 0], ["outbound_click", "/", "https://www.wsj.com/article", 0]]) {
    db.prepare("INSERT INTO events(id,occurred_at,kind,path,target,bot) VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(), now, kind, path, target, bot);
  }
  const response = await worker.fetch(request("/__analytics/report", { headers: { Authorization: `Bearer ${SECRET}` } }), { DB, READ_TOKEN: SECRET }, context());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.pages.find(p => p.kind === "pdf_request").count, 1);
  assert.equal(data.pages.find(p => p.kind === "pdf_click").name, "/paper.pdf");
  assert.equal(data.outbound[0].name, "https://www.wsj.com/article");
  assert.equal(data.totals.find(p => p.bot === 1).count, 1);
});

test("browser script sends one visible page view and normalizes external/PDF clicks", () => {
  const listeners = {}, sent = [];
  const document = { visibilityState: "visible", addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: () => {} };
  const navigator = { sendBeacon: (url, body) => { sent.push({ url, body }); return true; } };
  vm.runInNewContext(`(${startAnalytics.toString()})();`, { document, navigator, location: new URL(ORIGIN), URL, Blob, crypto });
  listeners.click({ type: "click", target: { closest: () => ({ href: "https://www.wsj.com/article?secret=x#x" }) } });
  listeners.auxclick({ type: "auxclick", button: 1, target: { closest: () => ({ href: ORIGIN + "/paper.pdf" }) } });
  assert.equal(sent.length, 3);
  assert.equal(agentInfo("Googlebot").bot, 1);
  assert.equal(agentInfo("Mozilla/5.0 Chrome/130.0 Safari/537.36").browser, "Chrome");
});
