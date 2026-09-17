import startAnalytics from "./client.mjs";
import { pdfIdentity, pdfCookie, sendPdfEvent } from "./ga.mjs";

// Configuration and bounded, privacy-preserving normalization.
const HOSTS = new Set(["www.andrewcwmyers.com", "andrewcwmyers.com"]);
const KINDS = new Set(["page_view", "outbound_click", "pdf_click"]);
const encoder = new TextEncoder();
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function optedOut(request) {
  return request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1";
}

export function cleanPath(value) {
  if (typeof value !== "string" || value.length > 300 || !value.startsWith("/") || value.startsWith("//")) return null;
  return value.split(/[?#]/)[0];
}

export function cleanUrl(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch { return ""; }
}

export function agentInfo(ua = "") {
  const bot = /bot|crawler|spider|slurp|headless|curl|wget|python|httpclient|facebookexternalhit|preview|fetcher/i.test(ua) ? 1 : 0;
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Other";
  const device = /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobile|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop";
  return { bot, browser, device };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

async function authorized(request, secret) {
  if (!secret || secret.length < 32) return false;
  const expected = await crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${secret}`));
  const actual = await crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("Authorization") || ""));
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

async function boundedJson(request) {
  if (Number(request.headers.get("Content-Length")) > 4096) throw new Error("large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty");
  let length = 0, text = "";
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > 4096) { await reader.cancel(); throw new Error("large"); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}

function metadata(request) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  const info = agentInfo(request.headers.get("User-Agent") || "");
  // Referrer paths and arbitrary query strings can contain personal information.
  let referrer = "";
  try { referrer = new URL(request.headers.get("Referer")).hostname; } catch {}
  const campaign = (key) => (url.searchParams.get(key) || "").replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 100);
  return { ...info, referrer, country: String(cf.country || "").slice(0, 2), region: String(cf.regionCode || "").slice(0, 20),
    source: campaign("utm_source"), medium: campaign("utm_medium"), campaign: campaign("utm_campaign") };
}

async function record(request, env, event) {
  if (!env.DB || optedOut(request)) return;
  const m = metadata(request);
  await env.DB.prepare(`INSERT OR IGNORE INTO events
    (id, occurred_at, kind, path, target, referrer, source, medium, campaign, country, region, browser, device, bot, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id || crypto.randomUUID(), Math.floor(Date.now() / 1000), event.kind, event.path, event.target || "",
      m.referrer, m.source, m.medium, m.campaign, m.country, m.region, m.browser, m.device, m.bot, event.status || 200).run();
}

function background(ctx, promise) {
  // Analytics must never delay or fail the public content response.
  ctx.waitUntil(promise.catch(() => console.warn("Analytics write failed")));
}

export function initialPdfRequest(request, response) {
  if (request.method !== "GET" || ![200, 206, 304].includes(response.status)) return false;
  const range = request.headers.get("Range");
  return !range || /^bytes=0-\d*$/.test(range);
}

async function collect(request, env, ctx) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return json({ error: "Forbidden" }, 403);
  if (optedOut(request)) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (env.COLLECT_LIMIT && !(await env.COLLECT_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" })).success) {
    return json({ error: "Rate limited" }, 429);
  }
  let body;
  try { body = await boundedJson(request); } catch { return json({ error: "Invalid event" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "Invalid event" }, 400);
  const path = cleanPath(body.path);
  if (!KINDS.has(body.kind) || !path || !/^[\da-f-]{36}$/i.test(body.id || "")) return json({ error: "Invalid event" }, 400);
  const target = body.kind === "outbound_click" ? cleanUrl(body.target) : body.kind === "pdf_click" ? cleanPath(body.target) : "";
  if (body.kind !== "page_view" && !target) return json({ error: "Invalid target" }, 400);
  background(ctx, record(request, env, { id: body.id, kind: body.kind, path, target }));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export function reportDates(url) {
  const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);
  const start = url.searchParams.get("start") || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(start) || !valid(end)) return null;
  const from = Date.parse(start) / 1000, until = Date.parse(end) / 1000 + 86400;
  if (until <= from || until - from > 366 * 86400) return null;
  return { start, end, from, until };
}

async function report(request, env) {
  if (!await authorized(request, env.READ_TOKEN)) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const dates = reportDates(new URL(request.url));
  if (!dates) return json({ error: "Invalid date range (maximum 366 days)" }, 400);
  if (!env.DB) return json({ error: "Database unavailable" }, 503);
  const where = "occurred_at >= ? AND occurred_at < ?";
  const query = (sql) => env.DB.prepare(sql).bind(dates.from, dates.until);
  // Only fixed, aggregate queries are exposed. No visitor identifiers or arbitrary SQL.
  const results = await env.DB.batch([
    query(`SELECT kind, bot, COUNT(*) AS count FROM events WHERE ${where} GROUP BY kind, bot`),
    query(`SELECT date(occurred_at, 'unixepoch') AS day, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 GROUP BY day, kind ORDER BY day`),
    query(`SELECT CASE WHEN kind = 'pdf_click' THEN target ELSE path END AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('pdf_request','pdf_click','page_view') GROUP BY name, kind ORDER BY count DESC LIMIT 100`),
    query(`SELECT target AS name, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind = 'outbound_click' GROUP BY target ORDER BY count DESC LIMIT 100`),
    query(`SELECT country AS name, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request') GROUP BY country ORDER BY count DESC LIMIT 100`),
    query(`SELECT referrer AS name, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_request','pdf_request') GROUP BY referrer ORDER BY count DESC LIMIT 100`),
    query(`SELECT browser AS name, device, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request') GROUP BY browser, device ORDER BY count DESC`),
    query(`SELECT source, medium, campaign, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND source != '' GROUP BY source, medium, campaign ORDER BY count DESC LIMIT 100`),
  ]);
  const keys = ["totals", "daily", "pages", "outbound", "countries", "referrers", "devices", "campaigns"];
  return json({ generatedAt: new Date().toISOString(), start: dates.start, end: dates.end,
    ...Object.fromEntries(keys.map((key, i) => [key, results[i].results])),
    gaPropertyId: "465165532", gaMeasurementId: env.GA_MEASUREMENT_ID, gaPdfForwarding: Boolean(env.GA_API_SECRET && env.GA_MEASUREMENT_ID),
    notes: ["PDF requests are retrieval starts, not confirmed reads. Nonzero byte ranges are excluded; anonymous retries can still count twice.",
      "Bot filtering uses browser signatures and is imperfect. The independent database stores no raw IPs or visitor identifiers. GA4 uses a short-lived PDF identifier or the existing Google tag identity; PDF engagement is not measured."] });
}

// Public requests stay on the GitHub Pages origin; Cloudflare routes intercept them.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!HOSTS.has(url.hostname)) return json({ error: "Not found" }, 404);
    if (url.pathname === "/__analytics/report") return report(request, env).catch(() => json({ error: "Analytics unavailable" }, 503));
    if (url.pathname === "/__analytics/event") return collect(request, env, ctx).catch(() => json({ error: "Analytics unavailable" }, 503));
    if (url.pathname === "/__analytics/client.js") return new Response(`(${startAnalytics.toString()})(${JSON.stringify(env.GA_MEASUREMENT_ID || "")});`, { headers: {
      "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
    if (url.pathname.startsWith("/__analytics/")) return json({ error: "Not found" }, 404);
    // Public GET/HEAD content can bypass a tracking-code exception. Private APIs cannot.
    if (request.method === "GET" || request.method === "HEAD") ctx.passThroughOnException?.();
    const response = env.ORIGIN ? await env.ORIGIN.fetch(request) : await fetch(request);
    if (optedOut(request) || request.method !== "GET") return response;
    const type = response.headers.get("Content-Type") || "";
    if ((type.includes("application/pdf") || (response.status === 304 && /\.pdf$/i.test(url.pathname))) && initialPdfRequest(request, response)) {
      background(ctx, record(request, env, { kind: "pdf_request", path: url.pathname, status: response.status }));
      const info = metadata(request);
      if (!info.bot && env.GA_API_SECRET && env.GA_MEASUREMENT_ID) {
        const identity = pdfIdentity(request);
        background(ctx, sendPdfEvent(request, env, identity, info));
        const tracked = new Response(response.body, response);
        tracked.headers.append("Set-Cookie", pdfCookie(identity));
        // Revalidation makes later opens observable without altering PDF bytes or URLs.
        tracked.headers.set("Cache-Control", "private, no-cache");
        return tracked;
      }
    }
    if (type.includes("text/html") && response.status === 200) {
      background(ctx, record(request, env, { kind: "page_request", path: url.pathname }));
    }
    return response;
  },
};
