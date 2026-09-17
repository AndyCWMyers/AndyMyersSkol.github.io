import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import worker from "../src/worker.mjs";
import { visitorIdentity, visitorHash } from "../src/preferences.mjs";
import documents from "../src/documents.mjs";

const ROOT = "https://www.andrewcwmyers.com";
const SECRET = "test-only-read-token-at-least-32-characters";
const A = "12345678-1234-4234-8234-123456789abc";
const B = "87654321-1234-4234-8234-123456789abc";

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0001_pdf_visitors.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0002_referrer_status.sql", import.meta.url), "utf8"));
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
  assert.equal(get.headers.get("Referrer-Policy"), "same-origin");
  assert.equal((await s.request("/__analytics/preferences", { Origin: "https://evil.example" }, { method: "POST", body: "exclude=1" })).status, 403);
  for (const headers of [{}, { Origin: "null" }]) {
    assert.equal((await s.request("/__analytics/preferences", headers, { method: "POST", body: "exclude=1" })).status, 403);
  }
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

test("homepage, clicks and PDFs share one visitor cookie while source capture stays sanitized", async () => {
  const s = setup();
  s.env.ORIGIN.fetch = async () => new Response("homepage", { headers: { "Content-Type": "text/html" } });
  const home = await s.request("/");
  const cookie = home.headers.get("Set-Cookie").split(";")[0];
  assert.match(cookie, /^__Host-acw_visitor=/);
  assert.equal(home.headers.get("Cache-Control"), "private, no-cache");
  for (const event of [
    { kind: "page_view", referrer: "" },
    { kind: "page_view", referrer: "https://google.com/search?private=hidden", source: "newsletter", medium: "email" },
    { kind: "outbound_click", target: "https://www.wsj.com/article" },
  ]) {
    const response = await s.request("/__analytics/event", { Origin: ROOT, Cookie: cookie }, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), path: "/", ...event }) });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Set-Cookie").split(";")[0], cookie);
  }
  s.env.ORIGIN.fetch = async () => new Response("%PDF", { headers: { "Content-Type": "application/pdf" } });
  await s.request("/paper.pdf", { Cookie: cookie });
  await s.finish();
  const rows = s.db.prepare("SELECT * FROM events WHERE kind != 'page_request' ORDER BY rowid").all();
  assert.equal(new Set(rows.map(row => row.visitor_hash)).size, 1);
  assert.deepEqual(rows.map(row => row.referrer_status), ["direct", "known", "unknown", "direct"]);
  assert.equal(rows[1].referrer, "google.com");
  assert.equal(rows[1].source, "newsletter");
  assert.equal(JSON.stringify(rows).includes("private=hidden"), false);
});

test("per-item counts and every detail dimension are date-, bot- and destination-scoped", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000);
  const insert = s.db.prepare(`INSERT INTO events(id,occurred_at,kind,path,target,country,region,browser,device,referrer,referrer_status,visitor_hash,bot)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of [
    [now, "page_view", "/", "", "US", "CA", "Chrome", "Desktop", "", "direct", "one", 0],
    [now, "page_view", "/index.html", "", "US", "CA", "Chrome", "Desktop", "", "direct", "one", 0],
    [now, "pdf_request", "/a.pdf", "", "US", "CA", "Chrome", "Desktop", "google.com", "known", "one", 0],
    [now, "pdf_request", "/a.pdf", "", "GB", "ENG", "Safari", "Mobile", "", "unknown", "two", 0],
    [now, "pdf_request", "/b.pdf", "", "FR", "IDF", "Firefox", "Desktop", "example.org", "known", "three", 0],
    [now, "outbound_click", "/", "https://www.wsj.com/article", "US", "CA", "Chrome", "Desktop", "", "direct", "one", 0],
    [now, "page_request", "/", "", "ZZ", "", "Other", "Desktop", "", "unknown", "", 0],
    [now, "pdf_click", "/", "/a.pdf", "ZZ", "", "Other", "Desktop", "", "unknown", "", 0],
    [now, "pdf_request", "/a.pdf", "", "ZZ", "", "Other", "Desktop", "", "unknown", "bot", 1],
    [now - 400 * 86400, "pdf_request", "/a.pdf", "", "ZZ", "", "Other", "Desktop", "", "unknown", "old", 0],
  ]) insert.run(crypto.randomUUID(), ...row);
  const report = await (await s.request("/__analytics/report", { Authorization: `Bearer ${SECRET}` })).json();
  assert.equal(report.items.find(row => row.name === "/").count, 2);
  assert.equal(report.items.find(row => row.name === "/").visitors, 1);
  assert.equal(report.items.find(row => row.name === "/a.pdf").count, 2);
  assert.equal(report.items.find(row => row.section === "outbound").count, 1);
  const details = report.breakdowns.filter(row => row.name === "/a.pdf");
  assert.deepEqual(details.filter(row => row.dimension === "geography").map(row => row.value).sort(), ["GB", "US"]);
  assert.deepEqual(details.filter(row => row.dimension === "sources").map(row => row.value).sort(), ["__unknown__", "google.com"]);
  assert.deepEqual(details.filter(row => row.dimension === "browsers").map(row => row.value).sort(), ["Chrome", "Safari"]);
  assert.equal(details.some(row => row.value === "ZZ" || row.value === "FR"), false);
  assert.equal(report.referrers.find(row => row.name === "__direct__").count, 2);
  assert.equal(report.referrers.find(row => row.name === "__unknown__").count, 1);
  assert.equal(JSON.stringify(report).includes("visitor_hash"), false);
});

test("source migration preserves events and never labels missing historic sources as direct", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const [id, kind, referrer] of [["pdf", "pdf_request", "google.com"], ["old", "pdf_request", ""], ["html", "page_view", "www.andrewcwmyers.com"]]) {
    db.prepare("INSERT INTO events(id,occurred_at,kind,path,referrer) VALUES(?,?,?,?,?)").run(id, 1, kind, "/", referrer);
  }
  db.exec(readFileSync(new URL("../migrations/0002_referrer_status.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT referrer_status FROM events WHERE id='pdf'").get().referrer_status, "known");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE referrer_status='unknown'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 3);
});

test("document labels match actual website titles and case-correct local assets", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.equal(new Set(documents.map(doc => doc.name)).size, documents.length);
  for (const doc of documents.slice(1)) {
    assert.ok(existsSync(new URL(`../..${doc.name}`, import.meta.url)), doc.name);
    assert.ok(html.includes(`href="${doc.name}"`), doc.name);
    assert.ok(html.includes(doc.title), doc.title);
  }
});
