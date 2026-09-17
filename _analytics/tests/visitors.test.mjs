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
  db.exec(readFileSync(new URL("../migrations/0003_personal_activity.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0004_county_geography.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0005_ip_address.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0006_city.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0007_pdf_duplicates.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0008_client_metadata.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0009_user_history_index.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0010_headline_summaries.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0011_reading_sessions.sql", import.meta.url), "utf8"));
  const pending = [], ga = [];
  const prepare = sql => ({ bind: (...params) => ({ run: async () => db.prepare(sql).run(...params), all: async () => ({ results: db.prepare(sql).all(...params) }) }) });
  const env = { DB: { prepare, batch: queries => Promise.all(queries.map(query => query.all())) }, READ_TOKEN: SECRET,
    GA_MEASUREMENT_ID: "G-TEST", GA_API_SECRET: "test-only", GA_FETCH: async (_url, options) => { ga.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); },
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
  assert.match(await get.text(), /type="checkbox" name="host" value="1" >Host/);
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
  assert.match(await (await s.request("/__analytics/preferences", { Cookie: "__Host-acw_ignore=1" })).text(), /value="1" >Host/);
  assert.match(await (await s.request("/__analytics/preferences?saved=excluded")).text(), /value="1" >Host/);
  const include = await s.request("/__analytics/preferences", { Origin: ROOT }, { method: "POST", body: "" });
  assert.match(include.headers.get("Set-Cookie"), /__Host-acw_ignore=;.*Max-Age=0/);
  await s.finish();
  assert.equal(s.db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 0);
});

test("host page is unlinked, noindex, and contains only an auto-saving checkbox", async () => {
  const s = setup();
  const response = await s.request("/__analytics/preferences", { Cookie: "__Host-acw_personal=1" });
  const html = await response.text();
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /value="1" checked>Host/);
  assert.equal((html.match(/<input\b/g) || []).length, 1);
  assert.doesNotMatch(html, /<a\b|<button\b|<p\b|<h1\b|type="radio"|Do not record|Regular visitor/);
  const [, nonce, source] = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(response.headers.get("Content-Security-Policy").includes(`script-src 'nonce-${nonce}'`));
  let submitted = 0;
  const input = { form: { requestSubmit: () => submitted++ }, addEventListener: (event, fn) => {
    assert.equal(event, "change"); fn.call(input);
  } };
  vm.runInNewContext(source, { document: { querySelector: selector => { assert.equal(selector, "input"); return input; } } });
  assert.equal(submitted, 1);
  for (const file of ["index.html", "sitemap.xml"]) {
    assert.equal(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").includes("/__analytics/preferences"), false);
  }
  const head = await s.request("/__analytics/preferences", {}, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const invalid = await s.request("/__analytics/preferences", { Origin: ROOT }, { method: "POST", body: "host=2" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("Host checkbox saves both states without losing earlier personal history", async () => {
  const s = setup();
  const marked = await s.request("/__analytics/preferences", { Origin: ROOT, Cookie: `__Host-acw_ignore=1; __Host-acw_visitor=${A}` }, { method: "POST", body: "host=1" });
  assert.equal(marked.status, 303);
  assert.equal(marked.headers.get("Location"), "/__analytics/preferences");
  assert.equal(marked.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(marked.headers.get("Set-Cookie"), /__Host-acw_personal=1/);
  assert.match(marked.headers.get("Set-Cookie"), /__Host-acw_ignore=;.*Max-Age=0/);
  const unmarked = await s.request("/__analytics/preferences", { Origin: ROOT, Cookie: `__Host-acw_personal=1; __Host-acw_visitor=${A}` }, { method: "POST", body: "" });
  assert.match(unmarked.headers.get("Set-Cookie"), /__Host-acw_personal=;.*Max-Age=0/);
  assert.match(unmarked.headers.get("Set-Cookie"), /__Host-acw_visitor=;.*Max-Age=0/);
  assert.equal(s.db.prepare("SELECT visitor_hash FROM personal_visitors").get().visitor_hash, await visitorHash(A));
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
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
  assert.deepEqual(report.pdfVisitors, { visitors: 2, identifiedRequests: 3, unidentifiedRequests: 1 });
  assert.deepEqual(report.pdfVisitorsByPath.find(row => row.name === "/a.pdf"), { name: "/a.pdf", visitors: 2, identifiedRequests: 2, unidentifiedRequests: 1 });
  assert.equal(report.pdfVisitorsByPath.find(row => row.name === "/b.pdf").visitors, 1);
  assert.equal(JSON.stringify(report).includes(await visitorHash(A)), false);
  assert.equal(JSON.stringify(s.db.prepare("SELECT * FROM events").all()).includes(A), false);
});

test("PDF 200/304 and initial-range retries count once in every report and GA while preserving raw rows", async t => {
  let now = Date.parse("2026-09-16T18:00:00Z");
  t.mock.method(Date, "now", () => now);
  const s = setup(), cookie = `__Host-acw_visitor=${A}; __Host-acw_personal=1`;
  for (const status of [200, 304, 206]) {
    s.env.ORIGIN.fetch = async () => new Response(status === 304 ? null : "%PDF", { status, headers: { "Content-Type": "application/pdf" } });
    const response = await s.request("/paper.pdf", { Cookie: cookie, "CF-Connecting-IP": "203.0.113.5", ...(status === 206 ? { Range: "bytes=0-100" } : {}) });
    assert.equal(response.status, status);
    assert.equal(await response.text(), status === 304 ? "" : "%PDF");
    await s.finish();
  }
  const raw = s.db.prepare("SELECT id, duplicate_of FROM events ORDER BY rowid").all();
  assert.equal(raw.length, 3);
  assert.deepEqual(raw.map(row => row.duplicate_of), ["", raw[0].id, raw[0].id]);
  assert.equal(s.ga.length, 1);
  const query = "/__analytics/report?start=2026-09-16&end=2026-09-16&excludePersonal=0";
  const get = async suffix => (await s.request(query + suffix, { Authorization: `Bearer ${SECRET}` })).json();
  const report = await get("");
  for (const key of ["totals", "daily", "pages", "countries", "devices", "referrers", "cities", "items"]) {
    assert.equal(report[key].reduce((n, row) => n + row.count, 0), 1, key);
  }
  assert.equal(report.pdfVisitors.identifiedRequests, 1);
  assert.equal(report.personalActivity.events, 1);
  assert.ok(report.breakdowns.every(row => row.count === 1));
  assert.equal((await get("&view=users")).rows[0].views, 1);
  const history = await get(`&view=users&user=${(await visitorHash(A)).slice(0, 24)}`);
  assert.equal(history.rows.length, 1);
  assert.equal(history.addresses[0].events, 1);
  const filtered = await (await s.request(query.replace("excludePersonal=0", "excludePersonal=1"), { Authorization: `Bearer ${SECRET}` })).json();
  assert.equal(filtered.items.length, 0);
  now += 4000;
  await s.request("/paper.pdf", { Cookie: cookie }); await s.finish();
  assert.equal(s.ga.length, 1);
  now += 2000;
  await s.request("/paper.pdf", { Cookie: cookie }); await s.finish();
  assert.equal(s.ga.length, 2, "retries do not extend the original window; later cached opens count");
});

test("concurrent PDF retries share one count but different browsers and PDFs remain separate", async t => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-16T18:00:00Z"));
  const s = setup(), headers = { Cookie: `__Host-acw_visitor=${A}`, "CF-Connecting-IP": "203.0.113.5" };
  await Promise.all(Array.from({ length: 10 }, () => s.request("/paper.pdf", headers)));
  await s.finish();
  assert.equal(s.ga.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE duplicate_of != ''").get().n, 9);
  await s.request("/different.pdf", headers);
  await s.request("/paper.pdf", { ...headers, Cookie: `__Host-acw_visitor=${B}` });
  await s.request("/paper.pdf", { "CF-Connecting-IP": "203.0.113.5" });
  await s.request("/paper.pdf", { "CF-Connecting-IP": "203.0.113.5" });
  await s.finish();
  assert.equal(s.ga.length, 5, "no fingerprinting or IP-based visitor merging");
});

test("historical duplicate correction flags only matching same-second 200/304 pairs and deletes nothing", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const migration of ["0001_pdf_visitors", "0002_referrer_status", "0003_personal_activity", "0004_county_geography", "0005_ip_address", "0006_city"]) {
    db.exec(readFileSync(new URL(`../migrations/${migration}.sql`, import.meta.url), "utf8"));
  }
  const insert = db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,status,ip_address) VALUES(?,?,'pdf_request',?,?,?,?)");
  insert.run("original", 100, "/paper.pdf", "known", 200, "203.0.113.5");
  insert.run("retry", 100, "/paper.pdf", "known", 304, "203.0.113.5");
  insert.run("second-full", 100, "/paper.pdf", "known", 200, "203.0.113.5");
  insert.run("later", 101, "/paper.pdf", "known", 304, "203.0.113.5");
  insert.run("other-browser", 100, "/paper.pdf", "other", 304, "203.0.113.5");
  insert.run("other-path", 100, "/other.pdf", "known", 304, "203.0.113.5");
  insert.run("other-ip", 100, "/paper.pdf", "known", 304, "203.0.113.6");
  insert.run("unknown-full", 100, "/paper.pdf", "", 200, "203.0.113.5");
  insert.run("unknown-retry", 100, "/paper.pdf", "", 304, "203.0.113.5");
  db.exec(readFileSync(new URL("../migrations/0007_pdf_duplicates.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 9);
  assert.deepEqual(db.prepare("SELECT id, duplicate_of FROM events WHERE duplicate_of != ''").all().map(row => ({ ...row })), [{ id: "retry", duplicate_of: "original" }]);
});

test("OS reporting separates matching browsers and omits legacy bot scores", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000), hash = await visitorHash(A);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,browser,device,os,bot_score) VALUES(?,?,'page_view','/',?,'Chrome','Desktop',?,?)");
  insert.run("mac", now - 1, hash, "macOS", 99);
  insert.run("windows", now, hash, "Windows", null);
  const get = async suffix => (await s.request(`/__analytics/report${suffix}`, { Authorization: `Bearer ${SECRET}` })).json();
  const report = await get("");
  assert.deepEqual(report.devices.map(row => row.os).sort(), ["Windows", "macOS"]);
  assert.deepEqual(report.breakdowns.filter(row => row.dimension === "devices").map(row => row.detail).sort(), ["Windows", "macOS"]);
  const users = await get("?view=users");
  assert.equal(users.rows[0].os, "Windows");
  assert.equal(users.rows[0].bot_score, undefined);
  const history = await get(`?view=users&user=${hash.slice(0, 24)}`);
  assert.ok(history.rows.every(row => !("bot_score" in row)));
});

test("headline distinct counts deduplicate across destinations and respect filters for each traffic kind", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,target,visitor_hash,is_personal,bot) VALUES(?,?,?,?,?,?,?,?)");
  for (const kind of ["page_view", "pdf_request", "outbound_click"]) {
    for (const [path, visitor, personal, bot, time] of [["/a", "one", 0, 0, now], ["/b", "one", 0, 0, now], ["/a", "two", 1, 0, now], ["/a", "", 0, 0, now], ["/a", "bot", 0, 1, now], ["/a", "old", 0, 0, now - 400 * 86400]]) {
      insert.run(crypto.randomUUID(), time, kind, path, `https://example.com${path}`, visitor, personal, bot);
    }
  }
  for (const filter of ["0", "1"]) {
    const report = await (await s.request(`/__analytics/report?excludePersonal=${filter}`, { Authorization: `Bearer ${SECRET}` })).json();
    for (const kind of ["page_view", "pdf_request", "outbound_click"]) {
      assert.deepEqual(report.totals.find(row => row.kind === kind && row.bot === 0), { kind, bot: 0, count: filter === "1" ? 3 : 4, visitors: filter === "1" ? 1 : 2, identifiedRequests: filter === "1" ? 2 : 3, unidentifiedRequests: 1 });
    }
  }
});

test("additive migration preserves existing requests with explicitly unknown visitors", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO events(id,occurred_at,kind,path) VALUES(?,?,?,?)").run("old", 1, "pdf_request", "/a.pdf");
  db.exec(readFileSync(new URL("../migrations/0001_pdf_visitors.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT visitor_hash FROM events WHERE id='old'").get().visitor_hash, "");
});

test("homepage honors collection opt-outs before Google Tag Manager loads", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const tag = html.match(/<!-- Google Tag Manager -->\s*<script>([\s\S]*?)<\/script>/)[1];
  for (const [cookie, navigator] of [["__Host-acw_ignore=1", {}], ["__Host-acw_personal=1; __Host-acw_ignore=1", {}], ["", { doNotTrack: "1" }], ["__Host-acw_personal=1", { globalPrivacyControl: true }]]) {
    const window = {};
    vm.runInNewContext(tag, { window, document: { cookie }, navigator });
    assert.equal(window["ga-disable-G-82ZD3DWY3B"], true);
    assert.equal(window.dataLayer, undefined);
  }
});

test("homepage labels personal and regular traffic before loading GTM without extra page views", () => {
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const tag = html.match(/<!-- Google Tag Manager -->\s*<script>([\s\S]*?)<\/script>/)[1];
  for (const [cookie, expected] of [["__Host-acw_personal=1", "yes"], ["", "no"], ["__Host-acw_personal=10", "no"]]) {
    const window = {}, scripts = [];
    const document = { cookie, createElement: () => ({}), getElementsByTagName: () => [{ parentNode: { insertBefore: script => scripts.push(script) } }] };
    vm.runInNewContext(tag, { window, document, navigator: {} });
    assert.equal(window["ga-disable-G-82ZD3DWY3B"], undefined);
    assert.equal(window.dataLayer.length, 2);
    assert.equal(window.dataLayer[0].personal_activity, expected);
    assert.equal(window.dataLayer[1].event, "gtm.js");
    assert.equal(scripts[0].src, "https://www.googletagmanager.com/gtm.js?id=GTM-MSMBKM2K");
  }
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
    await s.finish();
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
  for (const key of ["countries", "referrers", "devices"]) {
    for (const kind of ["page_view", "pdf_request", "outbound_click"]) {
      assert.equal(report[key].filter(row => row.kind === kind).reduce((sum, row) => sum + row.count, 0), kind === "page_view" ? 2 : kind === "pdf_request" ? 3 : 1, `${key}:${kind}`);
    }
  }
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

test("personal activity is retained, labeled in GA, and filtered across every dashboard aggregate", async () => {
  const s = setup();
  const owner = `__Host-acw_personal=1; __Host-acw_visitor=${A}`;
  const other = `__Host-acw_visitor=${B}`;
  for (const cookie of [owner, other]) {
    await s.request("/paper.pdf", { Cookie: cookie, Referer: "https://source.example/" });
    for (const event of [{ kind: "page_view" }, { kind: "outbound_click", target: "https://www.wsj.com/article" }, { kind: "pdf_click", target: "/paper.pdf" }]) {
      await s.request("/__analytics/event", { Origin: ROOT, Cookie: cookie }, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), path: "/", referrer: "https://source.example/", source: "news", ...event }) });
    }
  }
  await s.finish();
  assert.deepEqual(s.ga.map(payload => payload.events[0].params.personal_activity), ["yes", "no"]);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE is_personal=1").get().n, 4);
  const report = async filter => (await s.request(`/__analytics/report?excludePersonal=${filter}`, { Authorization: `Bearer ${SECRET}` })).json();
  const all = await report(0), filtered = await report(1);
  assert.equal(all.excludePersonal, false);
  assert.equal(filtered.excludePersonal, true);
  assert.equal(filtered.personalActivity.events, 3);
  for (const key of ["totals", "daily", "pages", "outbound", "countries", "referrers", "devices", "campaigns", "items", "breakdowns"]) {
    assert.equal(all[key].length, filtered[key].length, key);
    assert.deepEqual(all[key].map(row => row.count), filtered[key].map(row => row.count * 2), key);
  }
  assert.equal(all.pdfVisitors.visitors, 2);
  assert.equal(filtered.pdfVisitors.visitors, 1);
  assert.equal(filtered.items.find(row => row.name === "/").visitors, 1);
  assert.equal((await s.request("/__analytics/report?excludePersonal=maybe", { Authorization: `Bearer ${SECRET}` })).status, 400);
});

test("marking a browser matches only its existing identity and unmarking rotates that identity", async () => {
  const s = setup();
  await s.request("/old.pdf", { Cookie: `__Host-acw_visitor=${A}` });
  await s.request("/other.pdf", { Cookie: `__Host-acw_visitor=${B}` });
  await s.finish();
  s.db.prepare("INSERT INTO events(id,occurred_at,kind,path) VALUES(?,?,?,?)").run("anonymous", Math.floor(Date.now()/1000), "pdf_request", "/anonymous.pdf");
  const marked = await s.request("/__analytics/preferences", { Origin: ROOT, Cookie: `__Host-acw_visitor=${A}` }, { method: "POST", body: "mode=personal" });
  assert.equal(marked.status, 303);
  assert.match(marked.headers.get("Set-Cookie"), /__Host-acw_personal=1/);
  assert.match(marked.headers.get("Set-Cookie"), /__Host-acw_ignore=;.*Max-Age=0/);
  assert.equal(marked.headers.get("Set-Cookie").includes("__Host-acw_ga="), false);
  assert.equal(marked.headers.get("Set-Cookie").includes("__Host-acw_pdf="), false);
  assert.equal(s.db.prepare("SELECT visitor_hash FROM personal_visitors").get().visitor_hash, await visitorHash(A));
  const filtered = await (await s.request("/__analytics/report", { Authorization: `Bearer ${SECRET}` })).json();
  assert.deepEqual(filtered.items.map(row => row.name).sort(), ["/anonymous.pdf", "/other.pdf"]);
  const unmarked = await s.request("/__analytics/preferences", { Origin: ROOT, Cookie: `__Host-acw_personal=1; __Host-acw_visitor=${A}` }, { method: "POST", body: "mode=included" });
  assert.match(unmarked.headers.get("Set-Cookie"), /__Host-acw_personal=;.*Max-Age=0/);
  assert.match(unmarked.headers.get("Set-Cookie"), /__Host-acw_visitor=;.*Max-Age=0/);
  assert.equal(JSON.stringify(filtered).includes(await visitorHash(A)), false);
});

test("private users and chronological histories paginate, filter personal activity and omit unknown identities", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000), a = await visitorHash(A), b = await visitorHash(B);
  const insert = s.db.prepare(`INSERT INTO events(id,occurred_at,kind,path,visitor_hash,country,region,browser,device,referrer_status,is_personal,bot) VALUES(?,?,?,?,?,'US','CA','Safari','Desktop','direct',?,?)`);
  for (let i = 0; i < 103; i++) insert.run(`a-${i}`, now - 500 + i, "pdf_request", `/paper-${i}.pdf`, a, 0, 0);
  insert.run("personal", now, "page_view", "/index.html", b, 0, 0);
  s.db.prepare("INSERT INTO personal_visitors(visitor_hash) VALUES(?)").run(b);
  insert.run("unknown", now, "pdf_request", "/unknown.pdf", "", 0, 0);
  insert.run("bot", now, "pdf_request", "/bot.pdf", a, 0, 1);
  insert.run("click-duplicate", now, "pdf_click", "/", a, 0, 0);
  insert.run("old", now - 400 * 86400, "page_view", "/old", a, 0, 0);
  const query = async suffix => (await s.request(`/__analytics/report?view=users${suffix}`, { Authorization: `Bearer ${SECRET}` })).json();
  assert.equal((await s.request("/__analytics/report?view=users")).status, 401);
  const filtered = await query("");
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.rows[0].views, 103);
  assert.equal(filtered.rows[0].id, a.slice(0, 24));
  assert.equal(JSON.stringify(filtered).includes(a), false);
  const all = await query("&excludePersonal=0");
  assert.equal(all.rows.length, 2);
  assert.equal(all.rows[0].personal, 1);
  assert.equal(all.rows[0].country, "US");
  assert.equal((await query(`&user=${b.slice(0, 24)}`)).rows.length, 0);
  const first = await query(`&user=${a.slice(0, 24)}`), second = await query(`&user=${a.slice(0, 24)}&offset=100`);
  assert.equal(first.rows.length, 100);
  assert.equal(first.nextOffset, 100);
  assert.equal(second.rows.length, 3);
  assert.equal(second.nextOffset, null);
  assert.deepEqual([...first.rows, ...second.rows].map(row => row.path), Array.from({ length: 103 }, (_, i) => `/paper-${102 - i}.pdf`));
  assert.equal(first.rows[0].referrer, "__direct__");
  for (const suffix of ["&user=bad", "&offset=-1", "&offset=1.5", "&offset=10000000", "&excludePersonal=bad"]) {
    assert.equal((await s.request(`/__analytics/report?view=users${suffix}`, { Authorization: `Bearer ${SECRET}` })).status, 400);
  }
  const report = await (await s.request("/__analytics/report", { Authorization: `Bearer ${SECRET}` })).json();
  assert.deepEqual(report.states[0], { name: "CA", count: 104, visitors: 1, identifiedRequests: 103, unidentifiedRequests: 1 });
});

test("user list pagination includes every identity once and history ties use newest insertion first", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,'page_view',?,?)");
  for (let i = 1; i <= 101; i++) insert.run(String(i), now, "/", i.toString(16).padStart(64, "0").split("").reverse().join(""));
  const get = async offset => (await (await s.request(`/__analytics/report?view=users&offset=${offset}`, { Authorization: `Bearer ${SECRET}` })).json());
  const first = await get(0), pages = [first];
  assert.equal(first.limit, 15);
  assert.equal(first.rows.length, 15);
  assert.equal(first.nextOffset, 15);
  while (pages.at(-1).nextOffset !== null) pages.push(await get(pages.at(-1).nextOffset));
  assert.equal(pages.at(-1).rows.length, 11);
  const ids = pages.flatMap(page => page.rows.map(row => row.id));
  assert.equal(new Set(ids).size, 101);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual((await get(0)).rows, first.rows);
  const hash = "f".repeat(64);
  insert.run("z-first", now, "/first", hash); insert.run("a-second", now, "/second", hash);
  const history = await (await s.request(`/__analytics/report?view=users&user=${hash.slice(0, 24)}`, { Authorization: `Bearer ${SECRET}` })).json();
  assert.deepEqual(history.rows.map(row => row.path), ["/second", "/first"]);
});

test("country maps deduplicate across regions and papers, with destination and personal filters", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000), a = await visitorHash(A), b = await visitorHash(B);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,target,visitor_hash,country,region,is_personal,bot,duplicate_of) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  for (const [id, kind, path, hash, country, region, personal, bot, duplicate] of [
    ["1", "page_view", "/", a, "US", "CA", 0, 0, ""],
    ["2", "pdf_request", "/paper.pdf", a, "US", "NY", 0, 0, ""],
    ["3", "pdf_request", "/paper.pdf", a, "US", "CA", 0, 0, ""],
    ["4", "pdf_request", "/paper.pdf", b, "US", "CA", 1, 0, ""],
    ["5", "outbound_click", "/paper.pdf", a, "FR", "", 0, 0, ""],
    ["6", "pdf_request", "/paper.pdf", "", "GB", "", 0, 0, ""],
    ["7", "pdf_request", "/paper.pdf", a, "US", "CA", 0, 1, ""],
    ["8", "pdf_request", "/paper.pdf", a, "US", "CA", 0, 0, "3"],
  ]) insert.run(id, now, kind, path, "https://example.com", hash, country, region, personal, bot, duplicate);
  const get = async filter => (await (await s.request(`/__analytics/report?excludePersonal=${filter}`, { Authorization: `Bearer ${SECRET}` })).json());
  const filtered = await get(1), all = await get(0);
  assert.deepEqual(filtered.countryViews.find(row => row.name === "US"), { name: "US", count: 3, visitors: 1, identifiedRequests: 3, unidentifiedRequests: 0 });
  assert.equal(all.countryViews.find(row => row.name === "US").visitors, 2);
  assert.equal(filtered.countryViews.some(row => row.name === "FR"), false);
  const paper = filtered.breakdowns.find(row => row.dimension === "countries" && row.name === "/paper.pdf" && row.value === "US");
  assert.equal(paper.count, 2); assert.equal(paper.visitors, 1);
  assert.equal(filtered.countryViews.find(row => row.name === "GB").unidentifiedRequests, 1);
  assert.equal(filtered.breakdowns.find(row => row.dimension === "countries" && row.section === "outbound").value, "FR");
});

test("counties preserve unknowns, deduplicate across papers, and respect all filters and user histories", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000), a = await visitorHash(A), b = await visitorHash(B);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,country,region,county,county_fips,is_personal,bot) VALUES(?,?,?, ?,?,'US','CA',?,?,?,?)");
  for (const [id, kind, path, visitor, county, fips, personal, bot, time] of [
    ["pdf1", "pdf_request", "/a.pdf", a, "Santa Clara County", "06085", 0, 0, now - 2],
    ["pdf2", "pdf_request", "/b.pdf", a, "Santa Clara County", "06085", 0, 0, now - 1],
    ["page", "page_view", "/", a, "Santa Clara County", "06085", 0, 0, now],
    ["click", "outbound_click", "/", a, "Santa Clara County", "06085", 0, 0, now],
    ["old", "pdf_request", "/a.pdf", "", "", "", 0, 0, now],
    ["own", "pdf_request", "/a.pdf", b, "Santa Clara County", "06085", 0, 0, now],
    ["ownflag", "pdf_request", "/a.pdf", "", "Santa Clara County", "06085", 1, 0, now],
    ["bot", "pdf_request", "/a.pdf", a, "Santa Clara County", "06085", 0, 1, now],
    ["duplicate", "pdf_click", "/a.pdf", a, "Santa Clara County", "06085", 0, 0, now],
    ["outside", "pdf_request", "/a.pdf", a, "Santa Clara County", "06085", 0, 0, now - 400 * 86400],
  ]) insert.run(id, time, kind, path, visitor, county, fips, personal, bot);
  s.db.prepare("INSERT INTO personal_visitors(visitor_hash) VALUES(?)").run(b);
  const report = async suffix => (await s.request(`/__analytics/report${suffix}`, { Authorization: `Bearer ${SECRET}` })).json();
  const filtered = await report("");
  assert.deepEqual(filtered.countyViews.find(r => r.name === "06085"), { name: "06085", county: "Santa Clara County", region: "CA", count: 3, visitors: 1, identifiedRequests: 3, unidentifiedRequests: 0 });
  assert.equal(filtered.countyViews.find(r => r.name === "").count, 1);
  assert.equal(filtered.counties.find(r => r.name === "06085" && r.kind === "outbound_click").count, 1);
  assert.equal(filtered.breakdowns.find(r => r.name === "/a.pdf" && r.dimension === "counties" && r.value === "Santa Clara County").count, 1);
  assert.equal((await report("?excludePersonal=0")).countyViews.find(r => r.name === "06085").count, 5);
  assert.equal((await report("?view=users")).rows[0].county_fips, "06085");
  const history = await report(`?view=users&user=${a.slice(0,24)}`);
  assert.equal(history.rows.length, 4);
  assert.ok(history.rows.every(r => r.county === "Santa Clara County"));
});

test("county migration does not invent historical counties or alter event counts", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO events(id,occurred_at,kind,path,country,region) VALUES('old',1,'page_view','/','US','CA')");
  db.exec(readFileSync(new URL("../migrations/0004_county_geography.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  assert.deepEqual({ ...db.prepare("SELECT county, county_fips FROM events").get() }, { county: "", county_fips: "" });
});

test("city reports preserve state/country distinctions, missing history and personal filters", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000), a = await visitorHash(A);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,country,region,city,is_personal,bot) VALUES(?,?,?,'/',?,'US',?,?,?,?)");
  insert.run("first", now - 5, "page_view", a, "IL", "Springfield", 0, 0);
  insert.run("last", now, "pdf_request", a, "MA", "Springfield", 0, 0);
  insert.run("click", now, "outbound_click", a, "MA", "Springfield", 0, 0);
  insert.run("missing", now, "page_view", "", "MA", "", 0, 0);
  insert.run("own", now, "page_view", "", "MA", "Springfield", 1, 0);
  insert.run("bot", now, "page_view", "", "MA", "Springfield", 0, 1);
  const get = async suffix => (await s.request(`/__analytics/report${suffix}`, { Authorization: `Bearer ${SECRET}` })).json();
  const report = await get("");
  assert.equal(report.cities.length, 4);
  assert.equal(report.cities.filter(r => r.name === "Springfield").length, 3);
  assert.equal(report.cities.find(r => r.name === "").count, 1);
  assert.equal(report.breakdowns.filter(r => r.dimension === "cities" && r.value === "Springfield" && r.section === "main").length, 2);
  assert.equal((await get("?excludePersonal=0")).cities.length, 5);
  assert.equal((await get("?view=users")).rows[0].city, "Springfield");
  const history = await get(`?view=users&user=${a.slice(0,24)}`);
  assert.ok(history.rows.every(r => r.city === "Springfield"));
  assert.equal(history.rows[0].region, "MA");
  assert.equal(history.rows.at(-1).region, "IL");
});

test("city migration leaves previous events unchanged and unlocated", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO events(id,occurred_at,kind,path,country,region) VALUES('old',1,'page_view','/','US','CA')");
  db.exec(readFileSync(new URL("../migrations/0006_city.sql", import.meta.url), "utf8"));
  assert.equal(db.prepare("SELECT city FROM events").get().city, "");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
});

test("IP profiles include every address across pages, never other users, bots, excluded or out-of-period events", async () => {
  const s = setup(), now = Math.floor(Date.now() / 1000), a = await visitorHash(A), b = await visitorHash(B);
  const insert = s.db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,ip_address,is_personal,bot) VALUES(?,?,'page_view','/',?,?,?,?)");
  for (let i = 0; i < 101; i++) insert.run(`normal-${i}`, now - 200 + i, a, "203.0.113.1", 0, 0);
  insert.run("changed-network", now, a, "2001:db8::1", 0, 0);
  insert.run("unknown-old", now - 300, a, "", 0, 0);
  insert.run("other-user", now, b, "198.51.100.1", 0, 0);
  insert.run("bot", now, a, "198.51.100.2", 0, 1);
  insert.run("personal", now, a, "198.51.100.3", 1, 0);
  insert.run("outside", now - 400 * 86400, a, "198.51.100.4", 0, 0);
  const get = async suffix => (await s.request(`/__analytics/report${suffix}`, { Authorization: `Bearer ${SECRET}` })).json();
  const path = `?view=users&user=${a.slice(0,24)}`;
  const first = await get(path), next = await get(path + "&offset=100");
  assert.deepEqual(first.addresses, next.addresses);
  assert.deepEqual(first.addresses.map(r => r.address), ["2001:db8::1", "203.0.113.1"]);
  assert.equal(first.addresses[1].events, 101);
  assert.equal(first.addresses[1].firstSeen, now - 200);
  assert.equal(first.unrecordedIpEvents, 1);
  assert.equal(first.rows[1].ip_address, "203.0.113.1");
  assert.equal((await get(path + "&excludePersonal=0")).addresses.length, 3);
  for (const suffix of ["", "?view=users"]) {
    const summary = JSON.stringify(await get(suffix));
    assert.equal(summary.includes("203.0.113.1"), false);
    assert.equal(summary.includes("ip_address"), false);
  }
  s.db.prepare("INSERT INTO personal_visitors(visitor_hash) VALUES(?)").run(a);
  assert.deepEqual((await get(path)).addresses, []);
  assert.equal((await s.request(`/__analytics/report${path}`)).status, 401);
});

test("do-not-record and privacy signals still override a personal marker", async () => {
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }, { Cookie: "__Host-acw_personal=1; __Host-acw_ignore=1" }]) {
    const s = setup(), actual = { Cookie: `__Host-acw_personal=1; __Host-acw_visitor=${A}`, ...headers };
    await s.request("/paper.pdf", actual);
    await s.request("/__analytics/event", { ...actual, Origin: ROOT }, { method: "POST", body: JSON.stringify({ id: crypto.randomUUID(), kind: "page_view", path: "/" }) });
    await s.finish();
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
    assert.equal(s.ga.length, 0);
  }
});
