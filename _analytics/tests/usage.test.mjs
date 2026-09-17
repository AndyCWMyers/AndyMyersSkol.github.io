import test from "node:test";
import assert from "node:assert/strict";
import { createUsageReader, normalizeUsage, usageQuery, FREE_LIMITS } from "../src/usage.mjs";
import worker from "../src/worker.mjs";

const env = { CF_USAGE_TOKEN: "test-only-secret", CF_ACCOUNT_ID: "test-account", CF_DATABASE_ID: "website" };
const at = Date.parse("2026-09-17T17:00:00Z");
function payload() { return { data: { viewer: { accounts: [{
  workers: [{ dimensions: { date: "2026-09-17" }, sum: { requests: 1234 } }],
  d1: [{ dimensions: { date: "2026-09-17" }, sum: { rowsRead: 67890, rowsWritten: 123 } }],
  storage: [{ dimensions: { date: "2026-09-17", databaseId: "website" }, max: { databaseSizeBytes: 1000 } },
    { dimensions: { date: "2026-09-17", databaseId: "other" }, max: { databaseSizeBytes: 2000 } }],
}] } }, errors: null }; }

test("usage is account-wide with UTC dates, raw counts and separate daily/storage limits", () => {
  const query = usageQuery("account", "2026-08-19", "2026-09-17");
  assert.equal(query.variables.until, "2026-09-18T00:00:00.000Z");
  assert.doesNotMatch(query.query, /scriptName:|databaseId:|visitor|personal/);
  const result = normalizeUsage(payload(), "2026-08-19", "2026-09-17", "website", at);
  assert.equal(result.rows.length, 30);
  assert.equal(result.timeZone, "UTC");
  assert.deepEqual(result.rows[0], { date: "2026-09-17", requests: 1234, rowsRead: 67890, rowsWritten: 123, storageBytes: 3000, websiteStorageBytes: 1000 });
  assert.deepEqual(result.rows[1], { date: "2026-09-16", requests: 0, rowsRead: 0, rowsWritten: 0, storageBytes: null, websiteStorageBytes: null });
  assert.equal(FREE_LIMITS.rowsRead, 5000000);
  assert.equal(FREE_LIMITS.websiteStorageBytes, 500000000);
});

test("missing, partial and malformed Cloudflare responses are not fabricated as zeros", () => {
  for (const change of [p => p.errors = [{ message: "denied" }], p => p.data.viewer.accounts = [],
    p => delete p.data.viewer.accounts[0].workers, p => p.data.viewer.accounts[0].d1[0].sum.rowsRead = null,
    p => p.data.viewer.accounts[0].workers[0].dimensions.date = "2020-01-01",
    p => p.data.viewer.accounts[0].storage.push(p.data.viewer.accounts[0].storage[0]),
    p => p.data.viewer.accounts[0].workers = Array(31).fill(p.data.viewer.accounts[0].workers[0])]) {
    const p = payload(); change(p);
    assert.throws(() => normalizeUsage(p, "2026-08-19", "2026-09-17", "website", at));
  }
});

test("usage reader coalesces and caches for five minutes, never leaks token or queries D1", async () => {
  let calls = 0, now = at;
  const read = createUsageReader({ now: () => now, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(options.headers.Authorization, `Bearer ${env.CF_USAGE_TOKEN}`);
    assert.equal(options.redirect, "manual");
    return Response.json(payload());
  } });
  const first = read(env), second = read(env);
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(await read(env)).includes(env.CF_USAGE_TOKEN), false);
  assert.equal(calls, 1);
  now += 300001;
  await read(env); assert.equal(calls, 2);
  await assert.rejects(read({}));
});

test("failed reads retry and UTC midnight invalidates the cache", async () => {
  let now = Date.parse("2026-09-17T23:59:59Z"), calls = 0;
  const read = createUsageReader({ now: () => now, fetcher: async () => {
    if (++calls === 1) return new Response("unavailable", { status: 503 });
    return Response.json(payload());
  } });
  await assert.rejects(read(env));
  await read(env);
  now += 2000;
  const result = await read(env);
  assert.equal(calls, 3); assert.equal(result.end, "2026-09-18");
});

test("upstream redirects are rejected without forwarding credentials", async () => {
  const read = createUsageReader({ now: () => at, fetcher: async (_url, options) => {
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://example.com" } });
  } });
  await assert.rejects(read(env), /Usage unavailable/);
});

test("usage view remains behind report authentication and disallows POST", async () => {
  const url = "https://www.andrewcwmyers.com/__analytics/report?view=usage";
  const READ_TOKEN = "a-test-only-value-at-least-32-characters";
  assert.equal((await worker.fetch(new Request(url), { READ_TOKEN }, {})).status, 401);
  assert.equal((await worker.fetch(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${READ_TOKEN}` } }), { READ_TOKEN }, {})).status, 405);
  const unavailable = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${READ_TOKEN}` } }), { READ_TOKEN }, {});
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(await unavailable.text(), /CF_USAGE_TOKEN|test-only/);
});
