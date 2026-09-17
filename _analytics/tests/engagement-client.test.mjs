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

function browser({ start = Date.UTC(2026, 8, 17, 6, 59, 59), cookie = "", privacy = {}, fetcher } = {}) {
  let mono = 0, wall = start, serial = 0, focused = true;
  const tasks = new Map(), requests = [], warnings = [];
  const window = new Target(), document = new Target();
  Object.assign(document, { visibilityState: "visible", cookie, referrer: "https://example.com/private?q=secret", hasFocus: () => focused });
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
  const handle = window.acwStartEngagement({ id: "view-1", path: "/paper.pdf", kind: "pdf_view" });
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
  const h = browser({ cookie: "__Host-acw_personal=1" });
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(latest(h).active, true);
  assert.equal(latest(h).milliseconds, 0);
  assert.equal(latest(h).hours.length, 1);
  assert.equal(h.document.cookie, "__Host-acw_personal=1");
  assert.equal(h.requests[0].options.credentials, "same-origin");
  assert.equal(h.requests[0].options.keepalive, true);
  assert.doesNotMatch(source, /localStorage|sessionStorage|gtag|dataLayer|document\.cookie\s*=/);
  checkTotals(latest(h));
});

test("five-minute checkpoints have no inactivity cutoff; blur/hide pause and BFCache keeps id", async () => {
  const h = browser();
  for (let i = 0; i < 300; i++) await h.tick();
  assert.equal(latest(h).milliseconds, 300000);
  assert.equal(h.requests.length, 2);
  await h.focus(false);
  assert.equal(latest(h).active, false);
  for (let i = 0; i < 10; i++) await h.tick();
  await h.focus(true);
  await h.tick();
  await h.visible(false);
  assert.equal(latest(h).milliseconds, 301000);
  await h.tick(600000);
  await h.visible(true);
  h.window.emit("pagehide", { persisted: true });
  await h.tick(600000);
  h.window.emit("pageshow", { persisted: true });
  await h.tick();
  h.handle.download();
  assert.equal(latest(h).milliseconds, 302000);
  assert.equal(latest(h).downloads, 1);
  assert(h.requests.every(r => r.body.id === "view-1"));
  h.handle.stop();
  assert.equal(latest(h).active, false);
  const count = h.requests.length;
  await h.tick();
  assert.equal(h.requests.length, count);
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
