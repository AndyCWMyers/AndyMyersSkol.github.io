import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import { assessVisit, verifiedScore } from "../src/recaptcha.mjs";
import client from "../src/recaptcha-client.mjs";
import { startReading, userReading, historyReading } from "../src/engagement.mjs";
import worker from "../src/worker.mjs";
import { visitorHash } from "../src/preferences.mjs";

const now = Date.parse("2026-09-18T17:00:00Z");
const visitor = "a".repeat(64), host = "www.andrewcwmyers.com";
const token = "test-token-not-a-real-credential";
const valid = { success: true, score: 0.9, hostname: host, action: "homepage_view", challenge_ts: new Date(now).toISOString() };

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const file of readdirSync(new URL("../migrations", import.meta.url)).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const DB = { prepare: sql => ({ bind: (...values) => ({
    run: async () => db.prepare(sql).run(...values),
    all: async () => ({ results: db.prepare(sql).all(...values) }),
  }) }) };
  return { db, DB };
}

async function session(db, DB, changes = {}) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash,is_personal) VALUES(?,?,?,?,?,?)")
    .run(id, changes.at ?? now / 1000, changes.kind || "page_view", changes.path || "/", changes.visitor || visitor, changes.personal || 0);
  await startReading(DB, id, changes.visitor || visitor);
  return id;
}

test("verification rejects quota placeholders, wrong bindings, stale tokens and invalid scores", () => {
  for (const score of [0, 0.1, 0.9, 1]) assert.equal(verifiedScore({ ...valid, score }, host, valid.action, now), score);
  for (const change of [{ success: false }, { hostname: "evil.test" }, { action: "pdf_view" }, { score: null }, { score: "0.9" }, { score: -1 }, { score: 2 }, { score: NaN }, { "error-codes": ["Over free quota."] }, { "error-codes": "error" }, { challenge_ts: "bad" }, { challenge_ts: new Date(now - 120001).toISOString() }, { challenge_ts: new Date(now + 30001).toISOString() }]) assert.equal(verifiedScore({ ...valid, ...change }, host, valid.action, now), null);
});

test("one owner-bound assessment per visit; two writes, no event/count changes, retries are idempotent", async () => {
  const { db, DB } = fixture(), id = await session(db, DB);
  const events = db.prepare("SELECT * FROM events").all();
  let calls = 0;
  const env = { DB, RECAPTCHA_SECRET: "test-secret", RECAPTCHA_FETCH: async (url, request) => {
    calls++;
    assert.equal(url, "https://www.google.com/recaptcha/api/siteverify");
    assert.equal(request.redirect, "manual");
    assert.deepEqual([...request.body.keys()], ["secret", "response"]);
    assert.equal(request.body.get("response"), token);
    return Response.json({ ...valid, score: 0 });
  } };
  await assessVisit(env, { id, token }, "b".repeat(64), host, now);
  assert.equal(calls, 0);
  const before = db.prepare("SELECT total_changes() AS n").get().n;
  await Promise.all([assessVisit(env, { id, token }, visitor, host, now), assessVisit(env, { id, token }, visitor, host, now)]);
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT total_changes() AS n").get().n - before, 2);
  assert.deepEqual(db.prepare("SELECT * FROM events").all(), events);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours").get().n, 0);
  assert.equal(db.prepare("SELECT recaptcha_score FROM reading_sessions WHERE id=?").get(id).recaptcha_score, 0);
  const dates = { from: now / 1000 - 3600, until: now / 1000 + 3600 };
  const list = await userReading(DB, dates, true, [visitor.slice(0, 24)]);
  assert.equal(list.rows[0].latestBotScore, 0);
  assert.equal(list.rows[0].latestBotScoreAt, now / 1000);
  assert.equal(list.rows[0].liveAt, 0);
  assert.equal((await historyReading(DB, dates, true, [id])).rows[0].botScore, 0);
  assert.equal((await userReading(DB, { from: now / 1000 + 1, until: dates.until }, true, [visitor.slice(0, 24)])).rows[0].latestBotScore, null);
  const next = await session(db, DB, { at: now / 1000 + 10, kind: "pdf_request", path: "/andrew_c_w_myers_CV.pdf" });
  env.RECAPTCHA_FETCH = async () => Response.json({ ...valid, action: "pdf_view", score: 0.7 });
  await assessVisit(env, { id: next, token }, visitor, host, now + 10000);
  await session(db, DB, { at: now / 1000 + 20 });
  assert.equal((await userReading(DB, dates, true, [visitor.slice(0, 24)])).rows[0].latestBotScore, 0.7);
});

test("old, missing, personal and malformed visits never consume Google quota", async () => {
  const { db, DB } = fixture(); let calls = 0;
  const env = { DB, RECAPTCHA_FETCH: async () => { calls++; throw Error("should not run"); } };
  const old = await session(db, DB, { at: now / 1000 - 601 });
  const personal = await session(db, DB, { personal: 1 });
  for (const id of [old, personal, crypto.randomUUID()]) await assessVisit(env, { id, token }, visitor, host, now);
  assert.equal(await assessVisit(env, { id: "invalid", token }, visitor, host, now), 400);
  assert.equal(calls, 0);
});

test("Google outages and quota errors are unknown, never plausible placeholder scores", async () => {
  const { db, DB } = fixture();
  for (const fetcher of [async () => { throw Error("offline"); }, async () => Response.json({ ...valid, "error-codes": ["Over free quota."] }), async () => new Response("unavailable", { status: 503 }), async () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } })]) {
    const id = await session(db, DB);
    assert.equal(await assessVisit({ DB, RECAPTCHA_FETCH: fetcher }, { id, token }, visitor, host, now), 204);
    assert.equal(db.prepare("SELECT recaptcha_score FROM reading_sessions WHERE id=?").get(id).recaptcha_score, null);
  }
});

test("public endpoint enforces origin, privacy, rate limits and server verification", async () => {
  const { db, DB } = fixture();
  const identity = crypto.randomUUID(), hash = await visitorHash(identity);
  const id = await session(db, DB, { visitor: hash, at: Math.floor(Date.now() / 1000) });
  let calls = 0;
  const env = { DB, RECAPTCHA_SITE_KEY: "public-key", RECAPTCHA_SECRET: "test-secret", RECAPTCHA_FETCH: async () => { calls++; return Response.json({ ...valid, challenge_ts: new Date().toISOString() }); } };
  const request = (headers = {}, body = { id, token }) => new Request(`https://${host}/__analytics/assessment`, { method: "POST", headers: { Origin: `https://${host}`, Cookie: `__Host-acw_visitor=${identity}`, "User-Agent": "Mozilla/5.0", ...headers }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(request({ Origin: "https://evil.test" }), env, {})).status, 403);
  for (const headers of [{ DNT: "1" }, { "Sec-GPC": "1" }, { Cookie: "__Host-acw_personal=1" }]) assert.equal((await worker.fetch(request(headers), env, {})).status, 204);
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(request(), { ...env, COLLECT_LIMIT: { limit: async () => ({ success: false }) } }, {})).status, 429);
  const response = await worker.fetch(request(), env, {});
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(calls, 1);
  assert.equal((await worker.fetch(request({}, { id, token, score: 1 }), env, {})).status, 204);
  assert.equal(calls, 1);
});

test("browser assessment loads once, excludes host/privacy and never gates engagement", async () => {
  let enabled = false, scripts = 0; const calls = [], posts = [];
  const context = vm.createContext({ setTimeout, clearTimeout, allowed: () => enabled,
    window: { acwRecaptchaSiteKey: "public-key", grecaptcha: { ready: callback => callback(), execute: async (key, options) => { calls.push(options.action); return token; } } },
    document: { createElement: () => ({}), head: { appendChild: script => { scripts++; queueMicrotask(() => script.onload()); } } },
    post: async (url, body) => { posts.push({ url, ...JSON.parse(body) }); },
  });
  vm.runInContext(client + ";this.assess = assessVisit;", context);
  await context.assess("a", "page_view"); assert.equal(scripts, 0);
  enabled = true;
  await Promise.all([context.assess("a", "page_view"), context.assess("a", "page_view")]);
  await context.assess("b", "pdf_request");
  assert.equal(scripts, 1);
  assert.deepEqual(calls, ["homepage_view", "pdf_view"]);
  assert.deepEqual(posts.map(p => Object.keys(p)), [["url", "id", "token"], ["url", "id", "token"]]);
});
