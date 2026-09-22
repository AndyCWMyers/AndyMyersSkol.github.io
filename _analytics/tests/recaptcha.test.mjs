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
  }) }), batch: async statements => {
    db.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.all()); db.exec("COMMIT"); return results; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
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

test("client assessment failure categories contain no token or error text and create no extra posts", async () => {
  for (const mode of ["script", "execute", "post", "success"]) {
    const statuses = [], posts = [];
    const context = vm.createContext({ setTimeout, clearTimeout, allowed: () => true,
      window: { acwRecaptchaSiteKey: "key", grecaptcha: { ready: callback => callback(), execute: async () => {
        if (mode === "execute") throw Error("private error"); return token;
      } } },
      document: { createElement: () => ({}), head: { appendChild: script => queueMicrotask(() => mode === "script" ? script.onerror() : script.onload()) } },
      post: async (url, body) => { posts.push({ url, body }); return mode !== "post"; },
    });
    vm.runInContext(client + ";this.assess = assessVisit;", context);
    await context.assess("id", "page_view", value => statuses.push(value));
    assert.equal(statuses.at(-1), { script: "script_failed", execute: "execution_failed", post: "submission_failed", success: "submitted" }[mode]);
    assert.equal(posts.length, ["post", "success"].includes(mode) ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(statuses), /private error|test-token/);
  }
});

test("early PDF scores survive failed rendering, transfer once on rendering, and deduplicate races", async () => {
  for (const timing of ["before", "during", "after", "never"]) {
    const { db, DB } = fixture(), id = crypto.randomUUID();
    db.prepare(`INSERT INTO pdf_diagnostics(id, occurred_at, visitor_hash, path, route, reason, status)
      VALUES (?, ?, ?, '/paper.pdf', 'viewer', 'viewer', 200)`).run(id, now / 1000, visitor);
    let calls = 0;
    const render = async () => {
      db.prepare("INSERT INTO events(id,occurred_at,kind,path,visitor_hash) VALUES(?,?,'pdf_request','/paper.pdf',?)").run(id, now / 1000, visitor);
      await startReading(DB, id, visitor);
    };
    if (timing === "before") await render();
    const env = { DB, RECAPTCHA_FETCH: async () => {
      calls++;
      if (timing === "during") await render();
      return Response.json({ ...valid, action: "pdf_view", score: 0.7 });
    } };
    assert.equal(await assessVisit(env, { id, token, diagnostic: true }, "b".repeat(64), host, now), 404);
    await Promise.all([
      assessVisit(env, { id, token, diagnostic: true }, visitor, host, now),
      assessVisit(env, { id, token, diagnostic: true }, visitor, host, now),
      assessVisit(env, { id, token }, visitor, host, now),
    ]);
    if (timing === "after") await render();
    await assessVisit(env, { id, token }, visitor, host, now);
    assert.equal(calls, 1);
    assert.equal(db.prepare("SELECT recaptcha_score FROM pdf_diagnostics").get().recaptcha_score, 0.7);
    const rows = db.prepare("SELECT * FROM reading_sessions").all();
    assert.equal(rows.length, timing === "never" ? 0 : 1);
    if (rows.length) {
      assert.equal(rows[0].recaptcha_score, 0.7);
      assert.equal(rows[0].downloads, 0);
      assert.equal(rows[0].milliseconds, 0);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reading_hours").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, timing === "never" ? 0 : 1);
  }
});

test("early scoring excludes raw, old, bot and personal diagnostic records", async () => {
  const { db, DB } = fixture(); let calls = 0;
  const env = { DB, RECAPTCHA_FETCH: async () => { calls++; throw Error("must not run"); } };
  for (const [route, age, personal, bot] of [["raw", 0, 0, 0], ["viewer", 601, 0, 0], ["viewer", 0, 1, 0], ["viewer", 0, 0, 1]]) {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO pdf_diagnostics(id,occurred_at,visitor_hash,path,route,reason,status,is_personal,bot)
      VALUES (?,?,?,'/paper.pdf',?,'viewer',200,?,?)`).run(id, now / 1000 - age, visitor, route, personal, bot);
    await assessVisit(env, { id, token, diagnostic: true }, visitor, host, now);
  }
  assert.equal(calls, 0);
});

test("transient script failure retries once, shares early score/status, and stops on privacy opt-out", async () => {
  for (const optOut of [false, true]) {
    let enabled = true, scripts = 0, executions = 0; const posts = [], statuses = [];
    const context = vm.createContext({ setTimeout, clearTimeout, allowed: () => enabled,
      window: { acwRecaptchaSiteKey: "key", grecaptcha: { ready: callback => callback(), execute: async () => { executions++; return token; } } },
      document: { createElement: () => ({}), head: { appendChild: script => {
        scripts++;
        queueMicrotask(() => { if (scripts === 1) { if (optOut) enabled = false; script.onerror(); } else script.onload(); });
      } } }, post: async (url, body) => { posts.push(JSON.parse(body)); return true; },
    });
    vm.runInContext(client + ";this.assess = assessVisit;", context);
    await context.assess("visit", "pdf_view", () => {}, true);
    await context.assess("visit", "pdf_view", value => statuses.push(value));
    assert.equal(scripts, optOut ? 1 : 2);
    assert.equal(executions, optOut ? 0 : 1);
    assert.equal(posts.length, optOut ? 0 : 1);
    if (!optOut) { assert.equal(posts[0].diagnostic, true); assert.equal(statuses.at(-1), "submitted"); }
  }
});
