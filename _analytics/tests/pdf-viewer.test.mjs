import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, access } from "node:fs/promises";
import vm from "node:vm";
import { pdfViewerResponse, isPdfNavigation } from "../src/pdf-viewer.mjs";
import template from "../src/pdf-viewer-template.mjs";
import documents from "../src/documents.mjs";
import { inboundDetails } from "../src/inbound.mjs";

const asset = name => new URL("../viewer-assets/" + name, import.meta.url);

class Target {
  callbacks = new Map();
  addEventListener(name, fn) { if (!this.callbacks.has(name)) this.callbacks.set(name, []); this.callbacks.get(name).push(fn); }
  emit(name, value = {}) { for (const fn of this.callbacks.get(name) || []) fn(value); }
}

async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test("viewer advertises a dedicated metadata PDF without changing normal viewer bytes", async () => {
  const html = await pdfViewerResponse('/andrew_c_w_myers_CV.pdf').text();
  assert.match(html, /name="citation_title" content="CV"/);
  assert.match(html, /name="citation_pdf_url" content="https:\/\/www.andrewcwmyers.com\/andrew_c_w_myers_CV.pdf\?__pdf=reference"/);
  assert.match(html, /href="\/andrew_c_w_myers_CV.pdf\?__pdf=raw"/);
});

test("viewer replaces badge with a brief attribution only when tracking is enabled", async () => {
  const enabled = await pdfViewerResponse('/andrew_c_w_myers_CV.pdf').text();
  assert.match(enabled, /<footer class="acwRecaptchaNotice">This site is protected by reCAPTCHA\.<\/footer>/);
  assert.match(enabled, /class="acw-recaptcha-notice"/);
  assert.doesNotMatch(await pdfViewerResponse('/andrew_c_w_myers_CV.pdf', '', false).text(), /acwRecaptchaNotice|acw-recaptcha-notice/);
});

async function bootstrap({ tracking = true, privacy = {}, cookie = "", visible = true, diagnosticId = "", paperTitle = "Paper Title" } = {}) {
  const script = await readFile(asset("web/acw-viewer.js"), "utf8");
  const document = new Target(), window = new Target(), bus = new Target();
  const requests = [], diagnostics = [], assessments = [], starts = [], opens = [], options = {}, timers = new Map(), errorMessage = { hidden: true };
  let resolveStart, downloads = 0;
  Object.assign(document, { visibilityState: visible ? "visible" : "hidden", cookie,
    referrer: "https://ref.example/sensitive?email=hidden", querySelector: name => name === "#acwPdfError" ? errorMessage : ({ content: name.includes("acw-pdf-title") ? paperTitle : name.includes("acw-pdf-diagnostic") ? diagnosticId : name.includes("acw-pdf-path") ? "/paper.pdf" : String(tracking) }) });
  bus.on = bus.addEventListener;
  window.PDFViewerApplication = { initializedPromise: Promise.resolve(), eventBus: bus, pdfDocument: {}, toolbar: {}, secondaryToolbar: {},
    setTitle(title) { assert.equal(this, window.PDFViewerApplication); this._title = title; document.title = title; },
    open(args) { assert.equal(this, window.PDFViewerApplication); opens.push(args); return "opened"; } };
  window.PDFViewerApplicationOptions = { setAll: values => Object.assign(options, values) };
  window.acwStartEngagement = values => { starts.push(values); return { download: () => downloads++, stop() {} }; };
  window.acwAssessPdf = async id => { assessments.push(id); };
  window.acwInboundDetails = () => inboundDetails(document.referrer, "https://site.example/paper.pdf?utm_content=post&token=secret", "browser");
  const context = vm.createContext({ window, document, navigator: privacy, URL, AbortController, performance: { now: () => 1234 },
    location: { href: "https://site.example/paper.pdf?file=evil.pdf&utm_source=test%3C%3E#page=2&zoom=125" },
    crypto: { randomUUID: () => "pdf-view-id" },
    setTimeout: (fn, ms) => { timers.set(ms, fn); return ms; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, init) => { if (url.endsWith("pdf-diagnostic")) { diagnostics.push(JSON.parse(init.body)); return { ok: true, status: 204 }; } requests.push({ url, ...init }); return new Promise(resolve => { resolveStart = resolve; }); },
  });
  vm.runInContext(await readFile(asset("web/acw-diagnostics.js"), "utf8"), context);
  vm.runInContext(script, context);
  document.emit("webviewerloaded");
  await settle();
  return { document, window, bus, requests, diagnostics, assessments, starts, opens, options, timers, errorMessage,
    get downloads() { return downloads; },
    async acknowledge(ok = true) { resolveStart({ ok }); await settle(); },
  };
}

test("HTML navigations work without Fetch Metadata while byte clients stay raw", () => {
  const check = (headers, method = "GET") => isPdfNavigation(new Request("https://site.example/paper.pdf", { headers, method }));
  for (const headers of [{}, { "Sec-Fetch-Dest": "document" }, { "Sec-Fetch-Mode": "navigate" }, { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" }]) {
    assert.equal(check({ Accept: "application/pdf,text/html;q=0.8,*/*;q=0.5", ...headers }), true);
  }
  for (const headers of [{}, { Accept: "*/*" }, { Accept: "application/pdf" }, { Accept: "text/html;q=0,*/*" },
    { Accept: "text/html;q=oops" }, { Accept: "text/html", Range: "bytes=0-" },
    { Accept: "text/html", "Sec-Fetch-Dest": "empty" }, { Accept: "text/html", "Sec-Fetch-Dest": "embed" },
    { Accept: "text/html", "Sec-Fetch-Mode": "cors" }]) assert.equal(check(headers), false, JSON.stringify(headers));
  assert.equal(check({ Accept: "text/html" }, "HEAD"), false);
});

test("PDF assessment starts before rendering without recording a view or reading time", async () => {
  const diagnosticId = "11111111-1111-4111-8111-111111111111";
  const h = await bootstrap({ diagnosticId });
  assert.deepEqual(h.assessments, [diagnosticId]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.starts.length, 0);
  h.window.emit("unhandledrejection", { reason: {
    name: "TypeError", message: "URL.parse is not a function: PRIVATE_TOKEN",
    stack: "TypeError: PRIVATE_TOKEN at https://www.andrewcwmyers.com/__pdfjs/web/viewer.mjs:123:5?secret=PRIVATE_TOKEN",
  } });
  const error = h.diagnostics.find(row => row.stage === "error");
  assert.deepEqual(error.detail, { name: "TypeError", category: "unsupported_api", source: "viewer.mjs", line: 123 });
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE_TOKEN|https:|secret/);
  assert(JSON.stringify(error).length < 512);
  assert.equal(h.starts.length, 0);
  assert.equal(h.requests.length, 0);
  const missing = await bootstrap({ diagnosticId });
  missing.bus.emit("documenterror", { reason: "Missing PDF at https://private.example/token" });
  const missingError = missing.diagnostics.find(row => row.stage === "error");
  assert.deepEqual(missingError.detail, { category: "invalid_pdf" });
  assert.doesNotMatch(JSON.stringify(missingError), /private.example|token/);
  for (const settings of [{ tracking: false }, { privacy: { doNotTrack: "1" } }, { privacy: { globalPrivacyControl: true } }, { cookie: "__Host-acw_ignore=1" }]) {
    assert.equal((await bootstrap({ diagnosticId, ...settings })).assessments.length, 0);
  }
});

test("explicit browser navigations use PDF.js without HTML Accept while byte clients stay raw", () => {
  const check = (headers, method = "GET") => isPdfNavigation(new Request("https://site.example/paper.pdf", { headers, method }));
  for (const destination of ["document", "iframe"]) {
    for (const accept of [undefined, "*/*", "application/pdf"]) {
      const headers = { "Sec-Fetch-Dest": destination, "Sec-Fetch-Mode": "navigate", ...(accept ? { Accept: accept } : {}) };
      assert.equal(check(headers), true);
      assert.equal(check({ ...headers, Range: "bytes=0-" }), false);
      assert.equal(check({ ...headers, Range: "bytes=100-200" }), false);
      assert.equal(check(headers, "HEAD"), false);
    }
  }
  for (const headers of [{ "Sec-Fetch-Dest": "document" }, { "Sec-Fetch-Mode": "navigate" },
    { "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "navigate" },
    { "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "cors" }]) assert.equal(check({ Accept: "application/pdf", ...headers }), false);
});

test("diagnostics report bounded startup/render/error codes, reuse route ID, and honor privacy", async () => {
  const diagnosticId = "11111111-1111-4111-8111-111111111111";
  const h = await bootstrap({ diagnosticId });
  assert.deepEqual(h.diagnostics.map(row => row.stage), ["started", "initialized"]);
  h.bus.emit("documentloaded");
  h.bus.emit("pagerendered");
  h.bus.emit("pagerendered");
  assert.equal(h.window.acwPdfRenderMs, 1234);
  assert.deepEqual(h.diagnostics.map(row => row.stage), ["started", "initialized", "loaded", "rendered"]);
  assert.equal(JSON.parse(h.requests[0].body).id, diagnosticId);
  h.bus.emit("documenterror", { message: "PRIVATE STACK NOT TO SEND" });
  h.bus.emit("documenterror", {});
  assert.deepEqual(h.diagnostics.map(row => row.stage), ["started", "initialized", "loaded", "rendered", "error"]);
  assert.equal(h.diagnostics[4].code, "document_error");
  assert.doesNotMatch(JSON.stringify(h.diagnostics), /PRIVATE|ref.example/);
  for (const settings of [{ tracking: false }, { privacy: { doNotTrack: "1" } }, { privacy: { globalPrivacyControl: true } }, { cookie: "__Host-acw_ignore=1" }]) {
    const off = await bootstrap({ diagnosticId, ...settings });
    off.bus.emit("pagerendered"); off.bus.emit("documenterror");
    assert.equal(off.diagnostics.length, 0);
  }
});

test("viewer marks only its own raw fetch and preserves PDF.js options and receiver", async () => {
  const h = await bootstrap(), app = h.window.PDFViewerApplication;
  const args = { url: "/paper.pdf?__pdf=raw", httpHeaders: { Existing: "kept" }, password: "test" };
  assert.equal(app.open(args), "opened");
  assert.equal(h.opens[0].httpHeaders["X-ACW-PDF-Viewer"], "1");
  assert.equal(h.opens[0].httpHeaders.Existing, "kept");
  assert.equal(h.opens[0].password, "test");
  assert.equal(args.httpHeaders["X-ACW-PDF-Viewer"], undefined);
  const other = { url: "/other.pdf" };
  app.open(other);
  assert.equal(h.opens[1], other);
});

test("viewer tab titles use catalog titles and cannot be overwritten by PDF metadata", async () => {
  for (const document of documents.filter(row => row.name.endsWith(".pdf"))) {
    const html = await pdfViewerResponse(document.name, "").text();
    assert(html.includes(`<title>${document.title}</title>`));
    assert(html.includes(`name="acw-pdf-title" content="${document.title}"`));
  }
  for (const tracking of [true, false]) {
    const h = await bootstrap({ paperTitle: 'A Paper: Evidence & "Results"', tracking });
    assert.equal(h.document.title, 'A Paper: Evidence & "Results"');
    h.window.PDFViewerApplication.setTitle("strange embedded metadata - paper.pdf?__pdf=raw");
    assert.equal(h.document.title, 'A Paper: Evidence & "Results"');
    assert.equal(h.window.PDFViewerApplication._title, h.document.title);
  }
});

test("viewer starts with the sidebar closed independently of tracking", async () => {
  for (const tracking of [true, false]) {
    const h = await bootstrap({ tracking });
    assert.equal(h.options.sidebarViewOnLoad, 0);
    assert.equal(h.options.disablePreferences, true);
    assert.equal(h.options.viewOnLoad, 1);
  }
});

test("renderer adapts real generic markup, same URL/raw loading, escaping, CSP and no GA", async () => {
  const response = pdfViewerResponse("/papers/a%22%3Cscript%3E.pdf", "G-UNUSED");
  const html = await response.text();
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.match(html, /<base href="\/__pdfjs\/web\/"/);
  assert.match(html, /a&quot;&lt;script&gt;\.pdf<\/title>/);
  assert.match(html, /acw-pdf-path/);
  assert.match(html, /src="\/__analytics\/engagement.js"/);
  assert.match(html, /src="viewer.mjs" type="module"/);
  assert(html.indexOf('src="acw-diagnostics.js"') < html.indexOf('src="/__analytics/engagement.js"'));
  assert.match(html, /base-uri 'self'/);
  assert.doesNotMatch(html, /connect-src \*|G-UNUSED|googletagmanager|gtag\(/);
  for (const id of ["viewerContainer", "pageNumber", "zoomInButton", "viewFindButton", "viewsManagerToggleButton", "downloadButton", "printButton"]) assert(html.includes('id="' + id + '"'));
  assert.equal(template, await readFile(asset("web/viewer.html"), "utf8"));
  const off = await pdfViewerResponse("/cv.pdf", "", false).text();
  assert.match(off, /acw-tracking" content="false"/);
  assert.doesNotMatch(off, /\/__analytics\/engagement.js/);
  assert.match(off, /<noscript><p class="acwPdfFallback"><a href="\/cv.pdf\?__pdf=raw">Open original PDF<\/a>/);
  assert.match(off, /id="acwPdfError"[^>]+hidden/);
});

test("renderer rejects noncanonical, external, control, query, hash, and non-PDF paths", () => {
  for (const path of ["https://evil/a.pdf", "//evil/a.pdf", "/%2fexample/a.pdf", "/\\evil/a.pdf", "/a%5cb.pdf", "/../a.pdf", "/a.pdf?file=b.pdf", "/a.pdf#page=2", "/a\n.pdf", "/a%00.pdf", "/bad%.pdf", "/a.html", null]) {
    assert.throws(() => pdfViewerResponse(path, ""), TypeError, String(path));
  }
  assert.doesNotThrow(() => pdfViewerResponse("/papers/Andy's%20Paper.PDF", ""));
});

test("full generic release resources and licenses present; query override removed", async () => {
  for (const name of ["LICENSE", "build/pdf.mjs", "build/pdf.worker.mjs", "web/viewer.html", "web/viewer.css", "web/locale/locale.json", "web/compressed.tracemonkey-pldi-09.pdf"]) await access(asset(name));
  for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs", "locale", "images"]) assert((await readdir(asset("web/" + dir))).length > 0);
  const viewer = await readFile(asset("web/viewer.mjs"), "utf8");
  assert.match(viewer, /file = AppOptions.get\("defaultUrl"\);/);
  assert.doesNotMatch(viewer, /file = params.get\("file"\)/);
  const pdf = await readFile(asset("build/pdf.mjs"), "utf8");
  assert.match(pdf, /6\.3\.289/);
  assert.match(pdf, /core-js/);
});

test("pre-render runtime/rejection errors are bounded, private, and do not infer bots", async () => {
  for (const [event, value, code] of [
    ["error", { filename: "https://site.example/__pdfjs/web/viewer.mjs", message: "PRIVATE" }, "runtime_error"],
    ["unhandledrejection", { reason: { stack: "PRIVATE at https://site.example/__pdfjs/build/pdf.mjs" } }, "promise_error"],
  ]) {
    const h = await bootstrap({ diagnosticId: "11111111-1111-4111-8111-111111111111" });
    h.window.emit(event, value); h.window.emit(event, value);
    assert.equal(h.errorMessage.hidden, false);
    assert.equal(h.diagnostics.filter(row => row.stage === "error").length, 1);
    assert.equal(h.diagnostics.at(-1).code, code);
    assert.doesNotMatch(JSON.stringify(h.diagnostics), /PRIVATE/);
  }
  const h = await bootstrap({ diagnosticId: "11111111-1111-4111-8111-111111111111" });
  h.window.emit("error", { filename: "chrome-extension://something/script.js" });
  assert.equal(h.errorMessage.hidden, true);
  assert(h.timers.has(60000));
  h.document.visibilityState = "hidden";
  h.document.emit("visibilitychange");
  assert.equal(h.timers.has(60000), false);
  h.document.visibilityState = "visible";
  h.document.emit("visibilitychange");
  [...h.timers.values()].at(-1)();
  assert.equal(h.diagnostics.at(-1).code, "startup_timeout");
  h.bus.emit("pagerendered");
  assert.equal(h.requests.length, 1, "a slow render can still establish tracking");
});

test("PDF view waits for rendered+visible, then ack before tracker; native download hooks only", async () => {
  const h = await bootstrap({ visible: false });
  h.bus.emit("pagerendered", { error: new Error("failed") });
  assert.equal(h.requests.length, 0);
  h.bus.emit("pagerendered", {});
  assert.equal(h.requests.length, 0);
  h.document.visibilityState = "visible";
  h.document.emit("visibilitychange");
  assert.equal(h.requests.length, 1);
  assert.equal(h.starts.length, 0);
  const app = h.window.PDFViewerApplication;
  h.bus.emit("download", { source: app.toolbar });
  h.bus.emit("download", { source: {} });
  h.bus.emit("print", { source: app.toolbar });
  await h.acknowledge();
  assert.equal(h.starts.length, 1);
  assert.equal(h.downloads, 1);
  assert.equal(h.starts[0].id, "pdf-view-id");
  h.bus.emit("download", { source: h.window });
  h.bus.emit("download", { source: app.secondaryToolbar });
  assert.equal(h.downloads, 3);
  h.bus.emit("pagerendered", {});
  h.document.emit("visibilitychange");
  h.window.emit("pageshow");
  assert.equal(h.requests.length, 1);
  const body = JSON.parse(h.requests[0].body);
  assert.deepEqual(body, { kind: "pdf_view", id: "pdf-view-id", path: "/paper.pdf", referrer: "https://ref.example", source: "test", medium: "", campaign: "",
    inbound: { referrerUrl: "https://ref.example/sensitive", landingUrl: "https://site.example/paper.pdf?utm_content=post", via: "browser" } });
  assert.equal(h.options.defaultUrl, "/paper.pdf?__pdf=raw");
  assert.equal(h.options.annotationEditorMode, -1);
  assert.equal(h.options.enableScripting, false);
});

test("tracking disabled and browser privacy keep native viewer usable without events", async () => {
  for (const settings of [{ tracking: false }, { privacy: { doNotTrack: "1" } }, { privacy: { globalPrivacyControl: true } }, { cookie: "__Host-acw_ignore=1" }]) {
    const h = await bootstrap(settings);
    h.bus.emit("pagerendered");
    assert.equal(h.requests.length, 0);
    assert.equal(h.options.defaultUrl, "/paper.pdf?__pdf=raw");
  }
});

test("document, render, and module-load errors expose the original PDF fallback", async () => {
  for (const type of ["documenterror", "pagerendered", "script"]) {
    const h = await bootstrap();
    assert.equal(h.errorMessage.hidden, true);
    if (type === "script") h.window.emit("error", { target: { tagName: "SCRIPT", src: "https://site.example/__pdfjs/web/viewer.mjs" } });
    else h.bus.emit(type, { error: new Error("PDF unavailable") });
    assert.equal(h.errorMessage.hidden, false);
    assert.equal(h.requests.length, 0);
  }
});

test("failed start never starts tracker and retries same id; repeat save and local-open keys blocked", async () => {
  const h = await bootstrap();
  h.bus.emit("pagerendered");
  await h.acknowledge(false);
  assert.equal(h.starts.length, 0);
  h.timers.get(1000)();
  assert.equal(h.requests.length, 2);
  assert.equal(JSON.parse(h.requests[0].body).id, JSON.parse(h.requests[1].body).id);
  for (const key of [{ key: "s", repeat: true }, { key: "o", repeat: false }]) {
    let prevented = false, stopped = false;
    h.window.emit("keydown", { ...key, ctrlKey: true, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { stopped = true; } });
    assert(prevented && stopped);
  }
});
