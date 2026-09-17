import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../src/worker.mjs";
import startAnalytics from "../src/client.mjs";
import { pdfIdentity, pdfPayload } from "../src/ga.mjs";

const URL = "https://www.andrewcwmyers.com/paper.pdf?private=secret";
const NOW = 1800000000;
const info = { device: "Desktop", browser: "Safari", country: "US", region: "CA", referrer: "example.org", source: "newsletter", medium: "email", campaign: "paper", ip_address: "203.0.113.5", county: "Santa Clara County", county_fips: "06085" };

function setup(headers = {}, status = 200, fail = false) {
  const pending = [], sent = [];
  const env = { GA_API_SECRET: "test-secret", GA_MEASUREMENT_ID: "G-TEST",
    DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), all: async () => ({ results: [{ duplicate_of: "" }] }) }) }) },
    ORIGIN: { fetch: async () => new Response(status === 304 ? null : "%PDF", { status, headers: { "Content-Type": "application/pdf", ETag: '"original"' } }) },
    GA_FETCH: async (url, options) => { if (fail) throw new Error("Offline"); sent.push({ url, options }); return new Response(null, { status: 204 }); } };
  const request = new Request(URL, { headers });
  const ctx = { waitUntil: promise => pending.push(promise) };
  return { sent, request, env, ctx, finish: () => Promise.all(pending) };
}

test("PDF identity reuses valid Google context, then PDF context, and expires after 30 minutes", () => {
  const withCookie = cookie => new Request(URL, { headers: { Cookie: cookie } });
  assert.equal(pdfIdentity(withCookie(`__Host-acw_ga=123.456|789|${NOW - 60}; __Host-acw_pdf=9.8|7|${NOW - 30}`), NOW).client, "123.456");
  assert.equal(pdfIdentity(withCookie(`__Host-acw_pdf=9.8|7|${NOW - 30}`), NOW).session, 7);
  for (const cookie of [`__Host-acw_pdf=9.8|7|${NOW - 1800}`, `__Host-acw_ga=9.8|7|${NOW + 10}`, "__Host-acw_pdf=private@email.com|1|1800000000", "__Host-acw_ga=9.8|0|1800000000"]) {
    const identity = pdfIdentity(withCookie(cookie), NOW);
    assert.equal(identity.session, NOW);
    assert.notEqual(identity.client, "9.8");
  }
});

test("GA payload reports coarse location/device but no IP, arbitrary query, or invented engagement", () => {
  const payload = pdfPayload(new Request(URL, { headers: { "User-Agent": "Macintosh Safari/600", "Accept-Language": "en-US,en;q=0.9" } }), { client: "123.456", session: 789 }, info);
  assert.deepEqual(payload.user_location, { country_id: "US", region_id: "US-CA" });
  assert.equal(payload.device.operating_system, "MacOS");
  assert.equal(payload.device.language, "en-US");
  assert.equal(payload.events[0].params.page_location, "https://www.andrewcwmyers.com/paper.pdf");
  assert.equal(payload.events[0].params.page_referrer, "https://example.org");
  assert.equal(payload.events[0].params.personal_activity, "no");
  assert.equal(payload.events[0].params.engagement_time_msec, undefined);
  assert.equal(payload.ip_override, undefined);
  assert.equal(JSON.stringify(payload).includes("203.0.113.5"), false);
  assert.equal(JSON.stringify(payload).includes("Santa Clara"), false);
  assert.equal(payload.consent.ad_personalization, "DENIED");
});

test("human PDF requests are forwarded in the background and private cookie never enters payload headers", async () => {
  const s = setup({ "User-Agent": "Safari/600" });
  const response = await worker.fetch(s.request, s.env, s.ctx);
  assert.equal(await response.text(), "%PDF");
  assert.equal(response.headers.get("ETag"), '"original"');
  assert.match(response.headers.get("Set-Cookie"), /Secure; HttpOnly; SameSite=Lax; Max-Age=1800/);
  assert.equal(response.headers.get("Cache-Control"), "private, no-cache");
  await s.finish();
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].url.hostname, "www.google-analytics.com");
  assert.equal(s.sent[0].options.headers.Cookie, undefined);
});

test("bots, opt-outs and PDF byte chunks get no GA event or cookie", async () => {
  for (const headers of [{ "User-Agent": "Googlebot" }, { DNT: "1" }, { "Sec-GPC": "1" }, { Range: "bytes=100-200" }]) {
    const s = setup(headers);
    const response = await worker.fetch(s.request, s.env, s.ctx);
    await s.finish();
    assert.equal(s.sent.length, 0);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
});

test("conditional PDF opens are observed; GA failure does not break delivery", async () => {
  for (const [status, fail] of [[304, false], [200, true]]) {
    const s = setup({}, status, fail);
    assert.equal((await worker.fetch(s.request, s.env, s.ctx)).status, status);
    await s.finish();
  }
});

test("browser obtains GA identifiers for regular and personal activity without overwriting GA cookies", () => {
  for (const cookie of ["", "__Host-acw_personal=1"]) {
    const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, cookie };
    const dataLayer = [];
    dataLayer.push = args => { assert.equal(args[0], "get"); args[3](args[2] === "client_id" ? "123.456" : 789); };
    vm.runInNewContext(`(${startAnalytics.toString()})("G-TEST");`, { window: { dataLayer }, document, navigator: { sendBeacon: () => true },
      location: new globalThis.URL("https://www.andrewcwmyers.com/"), URL: globalThis.URL, Blob, crypto });
    assert.match(document.cookie, /^__Host-acw_ga=123\.456\|789\|\d+; Path=\/; Secure; SameSite=Lax; Max-Age=1800$/);
  }
});
