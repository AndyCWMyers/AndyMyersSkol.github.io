import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import worker from "../src/worker.mjs";
import { visitorIdentity, visitorHash } from "../src/preferences.mjs";

const ROOT = "https://www.andrewcwmyers.com";
const SECRET = "test-only-read-token-at-least-32-characters";
const A = "12345678-1234-4234-8234-123456789abc";
const B = "87654321-1234-4234-8234-123456789abc";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0001_pdf_visitors.sql", import.meta.url), "utf8"));
  const pending = [], ga = [];
  const prepare = sql => ({ bind: (...params) => ({ run: async () => db.prepare(sql).run(...params), all: async () => ({ results: db.prepare(sql).all(...params) }) }) });
  const env = { DB: { prepare, batch: queries => Promise.all(queries.map(query => query.all())) }, READ_TOKEN: SECRET,
    GA_MEASUREMENT_ID: "G-TEST", GA_API_SECRET: "test-only", GA_FETCH: async () => { ga.push(1); return new Response(null, { status: 204 }); },
    ORIGIN: { fetch: async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } }) } };
  const ctx = { waitUntil: promise => pending.push(promise) };
  return { db, env, ctx, ga, finish: () => Promise.all(pending),
    request: (path, headers = {}, init = {}) => worker.fetch(new Request(ROOT + path, { ...init, headers }), env, ctx) };
}

test("visitor cookies are random, first-party, bounded and unrelated to IP addresses", async () => {
  const first = visitorIdentity(new Request(ROOT));
  const again = visitorIdentity(new Request(ROOT, { headers: { Cookie: first.cookie.split(";")[0] } }));
  assert.equal(first.value, again.value);
  assert.match(first.cookie, /Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  assert.equal(first.cookie.includes("Domain="), false);
  assert.notEqual(visitorIdentity(new Request(ROOT, { headers: { Cookie: "__Host-acw_visitor=bad" } })).value, "bad");
  assert.match(await visitorHash(first.value), /^[0-9a-f]{64}$/);
  assert.notEqual(await visitorHash(first.value), first.value);
});

test("preferences use same-origin POST, never count page visits, and can be reversed", async () => {
  const s = setup();
  const get = await s.request("/__analytics/preferences");
  assert.match(await get.text(), /This browser is included/);
  assert.equal(get.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await s.request("/__analytics/preferences", { Origin: "https://evil.example" }, { method: "POST", body: "exclude=1" })).status, 403);
  for (const body of ["exclude=2", "exclude=1&token=bad", "x".repeat(65)]) {
    assert.equal((await s.request("/__analytics/preferences", { Origin: ROOT }, { method: "POST", body })).status, 400);
  }
  const exclude = await s.request("/__analytics/preferences", { Origin: ROOT }, { method: "POST", body: "exclude=1" });
  assert.equal(exclude.status, 303);
  assert.match(exclude.headers.get("Set-Cookie"), /__Host-acw_ignore=1/);
  assert.match(exclude.headers.get("Set-Cookie"), /__Host-acw_visitor=;.*Max-Age=0/);
  assert.match(await (await s.request("/__analytics/preferences", { Cookie: "__Host-acw_ignore=1" })).text(), /This browser is excluded/);
  assert.match(await (await s.request("/__analytics/preferences?saved=excluded")).text(), /Preference was not saved/);
  const include = await s.request("/__analytics/preferences", { Origin: ROOT }, { method: "POST", body: "" });
  assert.match(include.headers.get("Set-Cookie"), /__Host-acw_ignore=;.*Max-Age=0/);
  await s.finish();
  assert.equal(s.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
});

test("excluded browsers produce no PDF, page, click, GA events or new identity cookies", async () => {
  const s = setup();
  const Cookie = `__Host-acw_ignore=1; __Host-acw_visitor=${A}`;
  const pdf = await s.request("/paper.pdf", { Cookie });
  assert.equal(await pdf.text(), "%PDF");
  assert.equal(pdf.headers.get("Set-Cookie"), null);
  s.env.ORIGIN.fetch = async () => new Response("<p>Site</p>", { headers: { "Content-Type": "text/html" } });
  await s.request("/", { Cookie });
  await s.request("/__analytics/event", { Cookie, Origin: ROOT }, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), kind: "page_view", path: "/" }) });
  await s.finish();
  assert.equal(s.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
  assert.equal(s.ga.length, 0);
});

test("distinct PDF browsers deduplicate repeats across documents without inventing historic identities", async () => {
  const s = setup();
  for (const [path, id] of [["/a.pdf", A], ["/a.pdf", A], ["/b.pdf", A], ["/a.pdf", B]]) {
    await s.request(path, { Cookie: `__Host-acw_visitor=${id}` });
  }
  await s.request("/a.pdf", { Cookie: `__Host-acw_visitor=${B}`, "User-Agent": "Googlebot" });
  await s.request("/a.pdf", { Cookie: `__Host-acw_visitor=${A}`, Range: "bytes=100-200" });
  await s.finish();
  const now = Math.floor(Date.now() / 1000);
  s.db.prepare("INSERT INTO events(id,occurred_at,kind,path) VALUES(?,?,?,?)").run(crypto.randomUUID(), now, "pdf_request", "/a.pdf");
  s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,?,?,?)").run(crypto.randomUUID(), now - 400 * 86400, "pdf_request", "/old.pdf", "old-hash");
  const report = await (await s.request("/__analytics/report", { Authorization: `Bearer ${SECRET}` })).json();
  assert.deepEqual(report.pdfVisitors, { visitors: 2, identifiedRequests: 4, unidentifiedRequests: 1 });
  assert.deepEqual(report.pdfVisitorsByPath.find(row => row.name === "/a.pdf"), { name: "/a.pdf", visitors: 2, identifiedRequests: 3, unidentifiedRequests: 1 });
  assert.equal(report.pdfVisitorsByPath.find(row => row.name === "/b.pdf").visitors, 1);
  assert.equal(JSON.stringify(report).includes(await visitorHash(A)), false);
  assert.equal(JSON.stringify(s.db.prepare("SELECT * FROM events").all()).includes(A), false);
});

test("additive migration preserves existing requests with explicitly unknown visitors", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO events(id,occurred_at,kind,path) VALUES(?,?,?,?)").run("old", 1, "pdf_request", "/a.pdf");
  db.exec(readFileSync(new URL("../migrations/0001_pdf_visitors.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT visitor_hash FROM events WHERE id='old'").get().visitor_hash, "");
});

test("homepage excludes this browser before Google Tag Manager loads", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const tag = html.match(/<!-- Google Tag Manager -->\s*<script>([\s\S]*?)<\/script>/)[1];
  const window = {};
  vm.runInNewContext(tag, { window, document: { cookie: "__Host-acw_ignore=1" }, navigator: {} });
  assert.equal(window["ga-disable-G-82ZD3DWY3B"], true);
  assert.equal(window.dataLayer, undefined);
});
