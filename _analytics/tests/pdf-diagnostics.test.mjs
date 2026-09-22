import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/worker.mjs";
import { pdfNavigationReason } from "../src/pdf-viewer.mjs";
import { validDiagnosticSignal } from "../src/pdf-diagnostics.mjs";
import { automatedClient } from "../src/automated-client.mjs";
import { viewerDocuments as documents } from "../src/documents.mjs";

const ORIGIN = "https://www.andrewcwmyers.com", PDF = "/andrew_c_w_myers_CV.pdf";
const SECRET = "a-private-test-only-token-32-characters";
function setup(extra = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const file of readdirSync(new URL("../migrations", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const DB = { prepare: sql => ({ bind: (...values) => ({ run: async () => db.prepare(sql).run(...values), all: async () => ({ results: db.prepare(sql).all(...values) }) }) }) };
  const pending = [];
  const env = { DB, READ_TOKEN: SECRET, ORIGIN: { fetch: async () => new Response("pdf", { headers: { "Content-Type": "application/pdf" } }) }, ...extra };
  const ctx = { waitUntil: task => pending.push(task) };
  return { db, env, async fetch(path, init) { const response = await worker.fetch(new Request(ORIGIN + path, init), env, ctx); await Promise.all(pending.splice(0)); return response; } };
}
function post(body, cookie, headers = {}) { return { method: "POST", headers: { Origin: ORIGIN, Cookie: cookie, ...headers }, body: JSON.stringify(body) }; }
function today() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
async function viewer(h, headers = {}) {
  const response = await h.fetch(PDF, { headers: { Accept: "text/html", "User-Agent": "Test Browser", ...headers } });
  const html = await response.text();
  return { id: html.match(/acw-pdf-diagnostic" content="([^"]*)"/)[1], cookie: response.headers.get("Set-Cookie")?.split(";")[0] || "" };
}

test("routing reasons preserve navigation behavior and identify raw-client decisions", () => {
  for (const [headers, reason] of [
    [{ Accept: "text/html" }, "viewer"], [{ Accept: "application/pdf" }, "html_not_accepted"],
    [{ Accept: "application/pdf", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate" }, "viewer"],
    [{ Accept: "text/html", Range: "bytes=0-" }, "range_request"],
    [{ Accept: "text/html", "Sec-Fetch-Dest": "embed" }, "non_document_destination"],
    [{ Accept: "text/html", "Sec-Fetch-Mode": "cors" }, "non_navigation_mode"],
    [{ "Sec-Fetch-Dest": "document, document", "Sec-Fetch-Mode": "navigate, navigate" }, "viewer"],
    [{ Accept: "text/html", "Sec-Fetch-Dest": "document, empty", "Sec-Fetch-Mode": "navigate" }, "non_document_destination"],
    [{ Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate, cors" }, "non_navigation_mode"],
    [{ Accept: "text/html", "Sec-Fetch-Dest": "empty, empty" }, "non_document_destination"],
  ]) assert.equal(pdfNavigationReason(new Request(ORIGIN + PDF, { headers })), reason);
});

test("diagnostic error details accept only bounded categories and never private messages", async () => {
  const h = setup(), v = await viewer(h);
  const body = { id: v.id, stage: "error", code: "promise_error", status: 0,
    detail: { name: "TypeError", category: "unsupported_api", source: "viewer.mjs", line: 123 } };
  for (const detail of [{ message: "private" }, { source: "https://example.com/private" }, { line: 1000001 }, { name: "secret" }, { constructor: "oops" }]) {
    assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post({ ...body, detail }, v.cookie))).status, 400);
  }
  assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post(body, v.cookie))).status, 204);
  assert.deepEqual(JSON.parse(h.db.prepare("SELECT error_detail FROM pdf_diagnostics").get().error_detail), body.detail);
});

test("viewer diagnostics are linked, private, bounded and separate from view totals", async () => {
  const h = setup(), v = await viewer(h, { "User-Agent": "custom-tool/1.0 " + "x".repeat(1000), Accept: "text/html", Authorization: "never-save", Referer: "https://example.com/private?secret=hidden" });
  let row = h.db.prepare("SELECT * FROM pdf_diagnostics").get();
  assert.equal(row.id, v.id); assert.equal(row.route, "viewer"); assert.equal(row.reason, "viewer");
  assert.equal(row.user_agent.length, 512);
  assert.doesNotMatch(JSON.stringify(row), /never-save|secret=hidden|__Host-acw/);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  for (const stage of ["started", "initialized", "loaded", "rendered", "error"]) {
    const body = { id: v.id, stage, code: "document_error", status: 0 };
    assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post(body, v.cookie))).status, 204);
    const first = h.db.prepare("SELECT * FROM pdf_diagnostics").get();
    assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post(body, v.cookie))).status, 204);
    assert.deepEqual(h.db.prepare("SELECT * FROM pdf_diagnostics").get(), first);
  }
  row = h.db.prepare("SELECT * FROM pdf_diagnostics").get();
  assert(row.started_at && row.initialized_at && row.loaded_at && row.rendered_at && row.error_at);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
  const day = today(), path = `/__analytics/report?view=pdf_diagnostics&start=${day}&end=${day}&excludePersonal=0`;
  assert.equal((await h.fetch(path)).status, 401);
  const report = await (await h.fetch(path, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
  assert.equal(report.rows[0].id, v.id); assert.equal(report.rows[0].confirmed, 0);
  const accepted = await h.fetch("/__analytics/event", post({ id: v.id, kind: "pdf_view", path: PDF, referrer: "" }, v.cookie));
  assert.equal(accepted.status, 204);
  const confirmed = await (await h.fetch(path, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
  assert.equal(confirmed.rows[0].confirmed, 1);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
});

test("raw retrievals share the event identity; internal bytes and continuation ranges add no diagnostics", async () => {
  const h = setup();
  await h.fetch(PDF, { headers: { Accept: "application/pdf", "User-Agent": "NativeReader/3", Range: "bytes=0-" } });
  const row = h.db.prepare("SELECT * FROM pdf_diagnostics").get(), event = h.db.prepare("SELECT * FROM events").get();
  assert.equal(row.reason, "range_request"); assert.equal(row.range_header, "bytes=0-");
  assert.equal(row.id, event.id); assert.equal(row.visitor_hash, event.visitor_hash);
  await h.fetch(PDF + "?__pdf=raw", { headers: { "X-ACW-PDF-Viewer": "1" } });
  await h.fetch(PDF, { headers: { Range: "bytes=100-200" } });
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM pdf_diagnostics").get().n, 1);
  await h.fetch(PDF + "?__pdf=raw&secret=do-not-store", { headers: { Accept: "text/html" } });
  const raw = h.db.prepare("SELECT * FROM pdf_diagnostics WHERE reason='explicit_raw'").get();
  assert.equal(raw.path, PDF); assert.doesNotMatch(JSON.stringify(raw), /do-not-store/);
});

test("diagnostics enforce origin, ownership, privacy, validation and independent rate limits", async () => {
  const h = setup(), v = await viewer(h), body = { id: v.id, stage: "started" };
  assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post(body, v.cookie, { Origin: "https://other.example" }))).status, 403);
  assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post(body, ""))).status, 404);
  assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post({ ...body, stage: "error", code: "arbitrary private stack", status: 0 }, v.cookie))).status, 400);
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }, { Cookie: "__Host-acw_ignore=1" }]) {
    const off = setup();
    const disabled = await viewer(off, headers);
    assert.equal(disabled.id, "");
    await off.fetch(PDF, { headers });
    assert.equal(off.db.prepare("SELECT COUNT(*) AS n FROM pdf_diagnostics").get().n, 0);
    assert.equal((await h.fetch("/__analytics/pdf-diagnostic", post(body, v.cookie, headers))).status, 204);
  }
  assert.equal(h.db.prepare("SELECT started_at FROM pdf_diagnostics").get().started_at, 0);
  const limited = setup({ PDF_DIAGNOSTIC_LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal((await limited.fetch(PDF, { headers: { Accept: "text/html" } })).status, 200);
  assert.equal(limited.db.prepare("SELECT COUNT(*) AS n FROM pdf_diagnostics").get().n, 0);
  assert.equal((await limited.fetch("/__analytics/pdf-diagnostic", post(body, v.cookie))).status, 429);
  for (const code of ["document_error", "render_error", "initialization_error", "script_error", "runtime_error", "promise_error", "startup_timeout", "tracking_http", "tracking_network", "engagement_start_error"]) assert(validDiagnosticSignal({ ...body, stage: "error", code, status: 503 }));
});

test("all catalog PDFs including appendices and older papers render and accept tracking", async () => {
  assert.equal(new Set(documents.map(row => row.name)).size, documents.length);
  for (const doc of documents.filter(row => row.name.endsWith(".pdf"))) {
    const h = setup();
    const response = await h.fetch(doc.name, { headers: { Accept: "text/html" } });
    assert.match(response.headers.get("Content-Type"), /text\/html/);
    const id = (await response.text()).match(/acw-pdf-diagnostic" content="([^"]*)"/)[1];
    const cookie = response.headers.get("Set-Cookie").split(";")[0];
    assert.equal((await h.fetch("/__analytics/event", post({ id, kind: "pdf_view", path: doc.name }, cookie))).status, 204);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM reading_sessions").get().n, 1);
  }
});

test("self-identified automation gets raw bytes and a report label without reclassifying counts", async () => {
  for (const agent of ["MistralFrozenResearch/1.0", "Claude-User (claude-code/2)", "grok-search-verify/1.10", "Docoloc"]) {
    const h = setup();
    const response = await h.fetch(PDF, { headers: { Accept: "text/html", "User-Agent": agent } });
    assert.equal(response.headers.get("Content-Type"), "application/pdf");
    const row = h.db.prepare("SELECT * FROM pdf_diagnostics").get();
    assert.equal(row.reason, "automated_client");
    assert.equal(row.bot, 0, "labels do not silently change the historical bot/count policy");
    const day = today();
    const report = await (await h.fetch(`/__analytics/report?view=pdf_diagnostics&start=${day}&end=${day}`, { headers: { Authorization: `Bearer ${SECRET}` } })).json();
    assert.equal(report.rows[0].automatedClient, automatedClient(agent));
  }
  for (const agent of ["", "Mozilla/5.0 Chrome/124.0", "Safari/604.1"]) assert.equal(automatedClient(agent), "");
});

test("personal diagnostic rows are filterable without exposing other user profiles", async () => {
  const h = setup();
  await viewer(h, { Cookie: "__Host-acw_personal=1" });
  const v = await viewer(h);
  const day = today(), query = `/__analytics/report?view=pdf_diagnostics&start=${day}&end=${day}`;
  const options = { headers: { Authorization: `Bearer ${SECRET}` } };
  const report = await (await h.fetch(query, options)).json();
  assert.deepEqual(report.rows.map(row => row.id), [v.id]);
  const other = await (await h.fetch(query + "&user=" + "a".repeat(24), options)).json();
  assert.equal(other.rows.length, 0);
});

test("diagnostic database failures cannot block public PDF delivery", async () => {
  const h = setup({ DB: { prepare: () => { throw new Error("unavailable"); } } });
  assert.equal((await h.fetch(PDF, { headers: { Accept: "text/html" } })).status, 200);
  assert.equal((await h.fetch(PDF, { headers: { Accept: "application/pdf" } })).status, 200);
});
