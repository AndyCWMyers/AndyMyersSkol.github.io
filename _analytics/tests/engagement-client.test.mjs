import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import source from "../src/engagement-client.mjs";

class Target {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  emit(type, detail = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...detail }); }
}

async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

function browser({ start = Date.UTC(2026, 8, 17, 6, 59, 59), cookie = "", privacy = {}, fetcher, kind = "pdf_view", nodes = [], pdf } = {}) {
  let mono = 0, wall = start, serial = 0, focused = true;
  const tasks = new Map(), requests = [], warnings = [];
  const window = new Target(), document = new Target();
  Object.assign(document, { visibilityState: "visible", cookie, referrer: "https://example.com/private?q=secret", hasFocus: () => focused });
  Object.assign(document, { querySelectorAll: () => nodes, documentElement: { scrollHeight: 2000 } });
  Object.assign(window, { scrollY: 0, innerHeight: 800, innerWidth: 600 });
  if (pdf) {
    window.PDFViewerApplication = { pdfViewer: { pagesCount: pdf.nodes.length, getPageView: i => ({ div: pdf.nodes[i] }) } };
    document.getElementById = () => pdf.container;
  }
  const navigator = { ...privacy };
  const context = vm.createContext({ window, document, navigator, URL, AbortController,
    console: { warn: text => warnings.push(text) },
    Date: { now: () => wall }, performance: { now: () => mono },
    crypto: { randomUUID: () => "rotated-" + (++serial) },
    setInterval: fn => { const id = ++serial; tasks.set(id, { fn, interval: true }); return id; },
    clearInterval: id => tasks.delete(id),
    setTimeout: (fn, delay) => { const id = ++serial; tasks.set(id, { fn, due: mono + delay }); return id; },
    clearTimeout: id => tasks.delete(id),
    fetch: async (url, options) => {
      const request = { url, body: JSON.parse(options.body), options };
      requests.push(request);
      return fetcher ? fetcher(request) : { ok: true };
    },
  });
  vm.runInContext(source, context);
  const handle = window.acwStartEngagement({ id: "view-1", path: kind === "page_view" ? "/" : "/paper.pdf", kind });
  return { window, document, navigator, requests, handle, warnings, tasks,
    get wall() { return wall; },
    async tick(ms = 1000, wallMs = ms) {
      mono += ms; wall += wallMs;
      for (const [id, task] of [...tasks]) {
        if (task.interval) task.fn();
        else if (task.due <= mono) { tasks.delete(id); task.fn(); }
      }
      await settle();
    },
    async focus(value) { focused = value; window.emit(value ? "focus" : "blur"); await settle(); },
    async visible(value) { document.visibilityState = value ? "visible" : "hidden"; document.emit("visibilitychange"); await settle(); },
  };
}

function latest(h) { return h.requests.filter(r => r.url.endsWith("/engagement")).at(-1).body; }

test("PDF records only visible pages, scrolls without extra requests and respects focus/host/privacy", async () => {
  const container = new Target();
  Object.assign(container, { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 600, height: 800 }) });
  const nodes = Array.from({ length: 40 }, (_, i) => ({ dataset: { pageNumber: String(i + 1) }, getBoundingClientRect: () => ({
    top: i * 800 - container.scrollTop, bottom: (i + 1) * 800 - container.scrollTop, left: 0, right: 600, height: 800,
  }) }));
  const pdf = { container, nodes };
  const h = browser({ pdf, start: Date.UTC(2026, 8, 17, 7) });
  assert.deepEqual(latest(h).hours[0].pdfAttention, { total: 40, scrolled: 0, pages: [1, 0], seconds: Array(40).fill(0) });
  container.scrollTop = 31 * 800; container.emit("scroll");
  assert.equal(h.requests.length, 1);
  for (let i = 0; i < 15; i++) await h.tick();
  assert.deepEqual(latest(h).hours[0].pdfAttention, { total: 40, scrolled: 1, pages: [2147483649, 0], seconds: Array.from({ length: 40 }, (_, i) => i === 31 ? 15 : 0) });
  await h.visible(false);
  container.scrollTop = 39 * 800; container.emit("scroll");
  for (let i = 0; i < 15; i++) await h.tick();
  assert.equal(latest(h).hours[0].pdfAttention.pages[1], 0);
  await h.visible(true); await h.tick(); h.handle.download();
  assert.equal(latest(h).hours[0].pdfAttention.pages[1], 128);
  h.handle.stop();
  assert.equal(container.listeners.get("scroll").size, 0);
  for (const options of [{ cookie: "__Host-acw_personal=1" }, { privacy: { globalPrivacyControl: true } }]) {
    const excluded = browser({ pdf, ...options });
    await excluded.tick();
    assert.equal(excluded.requests.length, 0);
    assert.equal(container.listeners.get("scroll").size, 0);
  }
  const rotating = browser({ pdf });
  for (let i = 0; i < 16; i++) { if (i) await rotating.tick(3600000); rotating.handle.download(); }
  await rotating.tick(3600000); rotating.handle.download(); await settle();
  assert.equal(rotating.requests.filter(r => r.url.endsWith("/event")).length, 1);
  assert.notEqual(latest(rotating).id, "view-1");
});

test("PDF page time splits overlaps, preserves hourly boundaries, and pauses hidden or unfocused", async () => {
  const container = new Target();
  Object.assign(container, { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, right: 600, height: 800 }) });
  const nodes = Array.from({ length: 3 }, (_, i) => ({ dataset: { pageNumber: String(i + 1) }, getBoundingClientRect: () => ({
    top: i * 400 - container.scrollTop, bottom: (i + 1) * 400 - container.scrollTop, left: 0, right: 600, height: 400,
  }) }));
  const h = browser({ pdf: { container, nodes }, start: Date.UTC(2026, 8, 17, 6, 59, 58) });
  for (let i = 0; i < 4; i++) await h.tick();
  await h.focus(false);
  assert.deepEqual(latest(h).hours.map(row => row.pdfAttention.seconds), [[1, 1, 0], [1, 1, 0]]);
  const paused = latest(h);
  for (let i = 0; i < 20; i++) await h.tick();
  assert.deepEqual(latest(h), paused);
  await h.focus(true);
  container.scrollTop = 800; container.emit("scroll");
  const requests = h.requests.length;
  for (let i = 0; i < 6; i++) await h.tick();
  assert.equal(h.requests.length, requests);
  await h.visible(false);
  assert.deepEqual(latest(h).hours[1].pdfAttention.seconds, [1, 1, 6]);
  for (let i = 0; i < 15; i++) await h.tick();
  assert.equal(latest(h).milliseconds, 10000);
  assert.equal(latest(h).hours.flatMap(row => row.pdfAttention.seconds).reduce((a, b) => a + b, 0), 10);
});

function checkTotals(body) {
  assert.equal(body.milliseconds, body.hours.reduce((sum, h) => sum + h.milliseconds, 0));
  assert.equal(body.downloads, body.hours.reduce((sum, h) => sum + h.downloads, 0));
  assert(body.hours.length <= 128);
  assert(Buffer.byteLength(JSON.stringify(body)) < 16384);
  for (const item of body.hours) {
    assert.equal(item.hour % 3600, 0);
    assert(item.milliseconds >= 0 && item.milliseconds <= 3600000);
  }
}

test("startup sends immediate active snapshot with current zero hour; no cookie/storage/GA writes", async () => {
  const h = browser({ cookie: "unrelated=1" });
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(latest(h).active, true);
  assert.equal(latest(h).milliseconds, 0);
  assert.equal(latest(h).hours.length, 1);
  assert.equal(h.document.cookie, "unrelated=1");
  assert.equal(h.requests[0].options.credentials, "same-origin");
  assert.equal(h.requests[0].options.keepalive, true);
  assert.doesNotMatch(source, /localStorage|sessionStorage|gtag|dataLayer|document\.cookie\s*=/);
  checkTotals(latest(h));
});

test("homepage and PDF save at 15/30/45/60 active seconds, then five-minute intervals", async () => {
  for (const kind of ["pdf_view", "page_view"]) {
    const h = browser({ kind });
    for (let i = 0; i < 660; i++) await h.tick();
    assert.deepEqual(h.requests.map(row => row.body.milliseconds), [0, 15000, 30000, 45000, 60000, 360000, 660000]);
    assert.deepEqual(h.requests.map(row => row.body.seq), [1, 2, 3, 4, 5, 6, 7]);
    for (const row of h.requests) checkTotals(row.body);
  }
});

test("early milestones survive downloads and hidden time does not advance them", async () => {
  const h = browser();
  for (let i = 0; i < 10; i++) await h.tick();
  h.handle.download();
  await h.visible(false);
  for (let i = 0; i < 120; i++) await h.tick();
  assert.equal(latest(h).milliseconds, 10000);
  const hiddenCount = h.requests.length;
  await h.visible(true);
  for (let i = 0; i < 4; i++) await h.tick();
  assert.equal(h.requests.length, hiddenCount + 1);
  await h.tick();
  assert.equal(latest(h).milliseconds, 15000);
  assert.equal(latest(h).downloads, 1);
  for (let i = 0; i < 45; i++) await h.tick();
  assert.deepEqual(h.requests.slice(hiddenCount + 1).map(row => row.body.milliseconds), [15000, 30000, 45000, 60000]);
});

test("checkpoints have no inactivity cutoff; blur/hide pause and BFCache keeps id", async () => {
  const h = browser();
  for (let i = 0; i < 360; i++) await h.tick();
  assert.equal(latest(h).milliseconds, 360000);
  assert.equal(h.requests.length, 6);
  await h.focus(false);
  assert.equal(latest(h).active, false);
  for (let i = 0; i < 10; i++) await h.tick();
  await h.focus(true);
  await h.tick();
  await h.visible(false);
  assert.equal(latest(h).milliseconds, 361000);
  await h.tick(600000);
  await h.visible(true);
  h.window.emit("pagehide", { persisted: true });
  await h.tick(600000);
  h.window.emit("pageshow", { persisted: true });
  await h.tick();
  h.handle.download();
  assert.equal(latest(h).milliseconds, 362000);
  assert.equal(latest(h).downloads, 1);
  assert(h.requests.every(r => r.body.id === "view-1"));
  h.handle.stop();
  assert.equal(latest(h).active, false);
  const count = h.requests.length;
  await h.tick();
  assert.equal(h.requests.length, count);
});

test("host browsers send no engagement; marking an open page stops accrual and retries", async () => {
  const host = browser({ cookie: "other=1; __Host-acw_personal=1" });
  host.handle.download();
  await host.tick(300000);
  await host.visible(false);
  host.handle.stop();
  assert.equal(host.requests.length, 0);
  assert.equal(host.tasks.size, 0);
  const h = browser({ fetcher: async () => ({ ok: false }) });
  await settle();
  h.document.cookie = "__Host-acw_personal=1";
  await h.tick(1000);
  h.handle.download();
  await h.focus(false);
  h.handle.stop();
  await h.tick(300000);
  assert.equal(h.requests.length, 1);
});

test("UTC-hour and Pacific-midnight intervals split exactly; downloads belong to action hour", async () => {
  const h = browser({ start: Date.UTC(2026, 8, 17, 6, 59, 59, 500) });
  await h.tick(1000);
  h.handle.download();
  const body = latest(h);
  assert.equal(body.milliseconds, 1000);
  assert.deepEqual(body.hours.map(x => [x.milliseconds, x.downloads]), [[500, 0], [500, 1]]);
  assert.equal(new Date(body.hours[1].hour * 1000).getUTCHours(), 7);
  checkTotals(body);
});

test("suspended long timer and forward/backward clock jumps never credit unobserved time", async () => {
  const h = browser();
  await h.tick();
  await h.tick(3600000);
  await h.tick(1000, 3600000);
  await h.tick(1000, -100000);
  h.handle.download();
  assert.equal(latest(h).milliseconds, 1000);
  checkTotals(latest(h));
});

test("DNT/GPC/ignore suppress startup; revocation suppresses retries and stops accrual", async () => {
  for (const options of [{ privacy: { doNotTrack: "1" } }, { privacy: { globalPrivacyControl: true } }, { cookie: "a=1; __Host-acw_ignore=1" }]) {
    const h = browser(options);
    h.handle.download();
    await h.tick(300000);
    assert.equal(h.requests.length, 0);
  }
  const h = browser({ fetcher: async () => ({ ok: false }) });
  await settle();
  h.document.cookie = "__Host-acw_ignore=1";
  await h.tick(1000);
  assert.equal(h.requests.length, 1);
  h.handle.download();
  assert.equal(h.requests.length, 1);
});

test("failed sends retry exactly three attempts with unchanged cumulative sequence", async () => {
  const h = browser({ fetcher: async () => ({ ok: false }) });
  await settle();
  await h.tick(1000);
  await h.tick(2000);
  await h.tick(4000);
  assert.equal(h.requests.length, 3);
  assert.equal(new Set(h.requests.map(r => r.options.body)).size, 1);
  h.handle.download();
  assert.equal(latest(h).seq, 2);
  assert.equal(latest(h).downloads, 1);
});

test("128-hour cap flushes full old session then awaits new view acknowledgement before successor", async () => {
  let release;
  const h = browser({ fetcher: request => request.url.endsWith("/event") ? new Promise(resolve => { release = resolve; }) : { ok: true } });
  for (let i = 0; i < 128; i++) {
    if (i) await h.tick(3600000);
    h.handle.download();
  }
  await h.tick(3600000);
  h.handle.download();
  await settle();
  const old = latest(h);
  assert.equal(old.hours.length, 128);
  assert.equal(old.downloads, 128);
  assert.equal(old.active, false);
  checkTotals(old);
  const event = h.requests.at(-1);
  assert.equal(event.url, "/__analytics/event");
  assert.equal(event.body.kind, "pdf_view");
  assert.equal(event.body.engagement, true);
  assert.equal(event.body.referrer, "https://example.com");
  assert.notEqual(event.body.id, old.id);
  release({ ok: true });
  await settle();
  assert.equal(latest(h).id, event.body.id);
  assert.equal(latest(h).downloads, 1);
  assert.equal(latest(h).hours.length, 1);
  checkTotals(latest(h));
});

test("terminal pagehide flushes and removes listeners; explicit stop is idempotent", async () => {
  const h = browser();
  await h.tick();
  h.window.emit("pagehide", { persisted: false });
  assert.equal(latest(h).milliseconds, 1000);
  assert.equal(latest(h).active, false);
  const count = h.requests.length;
  h.handle.stop();
  h.handle.download();
  h.window.emit("pageshow", { persisted: false });
  await h.tick();
  assert.equal(h.requests.length, count);
});

test("homepage attention shares checkpoints, respects visibility, tracks scroll and counts abstract opens once", async () => {
  const detail = new Target(); detail.open = false;
  let rect = { top: 100, bottom: 400, left: 0, right: 600, height: 300 };
  const abstract = { getBoundingClientRect: () => rect };
  detail.querySelector = () => abstract;
  const node = { dataset: { acwSection: "1", acwItem: "1" }, getBoundingClientRect: () => rect, querySelector: () => detail };
  const h = browser({ kind: "page_view", nodes: [node], start: Date.UTC(2026, 8, 17, 7) });
  assert.deepEqual(latest(h).hours[0].attention, { depth: 40, scrolled: 0, sections: 2, items: [[1, 0, 0, 0]] });
  for (let i = 0; i < 10; i++) await h.tick();
  detail.open = true; detail.emit("toggle"); detail.emit("toggle");
  h.window.scrollY = 800; h.window.emit("scroll");
  assert.equal(h.requests.length, 1, "opening and scrolling make no requests");
  for (let i = 0; i < 5; i++) await h.tick();
  assert.deepEqual(latest(h).hours[0].attention, { depth: 80, scrolled: 1, sections: 2, items: [[1, 15000, 1, 5000]] });
  await h.visible(false);
  h.window.scrollY = 1200; h.window.emit("scroll");
  detail.open = false; detail.emit("toggle"); detail.open = true; detail.emit("toggle");
  for (let i = 0; i < 10; i++) await h.tick();
  await h.visible(true);
  assert.equal(latest(h).hours[0].attention.depth, 80);
  rect = { ...rect, top: -1000, bottom: -700 };
  for (let i = 0; i < 15; i++) await h.tick();
  h.handle.stop();
  assert.deepEqual(latest(h).hours[0].attention.items, [[1, 15000, 1, 5000]]);
  assert.equal(h.window.listeners.get("scroll").size, 0);
  assert.equal(detail.listeners.get("toggle").size, 0);
  for (const options of [{ cookie: "__Host-acw_personal=1" }, { privacy: { globalPrivacyControl: true } }, { privacy: { doNotTrack: "1" } }]) {
    const excluded = browser({ ...options, kind: "page_view", nodes: [node] });
    await excluded.tick();
    assert.equal(excluded.requests.length, 0);
  }
  const pdf = browser({ nodes: [node] });
  await pdf.tick(); pdf.handle.stop();
  assert.equal(latest(pdf).hours[0].attention, undefined);
});
