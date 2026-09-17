import clientSource from "./client.mjs";
import { pdfIdentity, pdfCookie, sendPdfEvent } from "./ga.mjs";
import { excludedBrowser, personalBrowser, preferences, visitorIdentity, visitorHash } from "./preferences.mjs";
import documents from "./documents.mjs";
import { userReport } from "./users.mjs";

// Configuration and bounded, privacy-preserving normalization.
const HOSTS = new Set(["www.andrewcwmyers.com", "andrewcwmyers.com"]);
const KINDS = new Set(["page_view", "outbound_click", "pdf_click"]);
const encoder = new TextEncoder();
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function optedOut(request) {
  return excludedBrowser(request) || request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1";
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
  const referrerUrl = cleanUrl(request.headers.get("Referer"));
  const referrer = referrerUrl ? new URL(referrerUrl).hostname : "";
  const referrerStatus = referrer ? "known" : request.headers.has("Referer") ? "unknown" : "direct";
  const campaign = (key) => (url.searchParams.get(key) || "").replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 100);
  return { ...info, referrer, referrerStatus, country: String(cf.country || "").slice(0, 2), region: String(cf.regionCode || "").slice(0, 20),
    source: campaign("utm_source"), medium: campaign("utm_medium"), campaign: campaign("utm_campaign") };
}

function browserAttribution(body) {
  const referrer = cleanUrl(body.referrer);
  const campaign = key => typeof body[key] === "string" ? body[key].replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 100) : "";
  return { referrer: referrer ? new URL(referrer).hostname : "", referrerStatus: referrer ? "known" : body.referrer === "" ? "direct" : "unknown",
    source: campaign("source"), medium: campaign("medium"), campaign: campaign("campaign") };
}

async function record(request, env, event) {
  if (!env.DB || optedOut(request)) return;
  const m = { ...metadata(request), ...event.attribution };
  const visitor = event.visitorId ? await visitorHash(event.visitorId) : "";
  await env.DB.prepare(`INSERT OR IGNORE INTO events
    (id, occurred_at, kind, path, target, referrer, source, medium, campaign, country, region, browser, device, bot, status, visitor_hash, referrer_status, is_personal)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id || crypto.randomUUID(), Math.floor(Date.now() / 1000), event.kind, event.path, event.target || "",
      m.referrer, m.source, m.medium, m.campaign, m.country, m.region, m.browser, m.device, m.bot, event.status || 200, visitor, m.referrerStatus, personalBrowser(request) ? 1 : 0).run();
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
  const visitor = metadata(request).bot ? null : visitorIdentity(request);
  background(ctx, record(request, env, { id: body.id, kind: body.kind, path, target, visitorId: visitor?.value,
    attribution: browserAttribution(body) }));
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (visitor) headers.append("Set-Cookie", visitor.cookie);
  return new Response(null, { status: 204, headers });
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
  const url = new URL(request.url);
  const dates = reportDates(url);
  if (!dates) return json({ error: "Invalid date range (maximum 366 days)" }, 400);
  if (!env.DB) return json({ error: "Database unavailable" }, 503);
  const filter = url.searchParams.get("excludePersonal") ?? "1";
  if (!["0", "1"].includes(filter)) return json({ error: "Invalid personal-activity filter" }, 400);
  const excludePersonal = filter === "1";
  const period = "occurred_at >= ? AND occurred_at < ?";
  const personal = "(is_personal = 1 OR visitor_hash IN (SELECT visitor_hash FROM personal_visitors))";
  const where = `${period}${excludePersonal ? ` AND NOT ${personal}` : ""}`;
  if (url.searchParams.get("view") === "users") {
    const value = await userReport(env.DB, url, dates, where, personal, excludePersonal);
    return json(value, value.error ? 400 : 200);
  }
  const query = (sql) => env.DB.prepare(sql).bind(dates.from, dates.until);
  const activity = `WITH activity AS (
    SELECT *, CASE WHEN kind = 'outbound_click' THEN 'outbound' ELSE 'main' END AS section,
      CASE WHEN kind = 'outbound_click' THEN target WHEN path IN ('/index.html', '/index') THEN '/' ELSE path END AS name
    FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view', 'pdf_request', 'outbound_click')
  )`;
  const counts = `COUNT(*) AS count, COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors,
    COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests`;
  const inboundSource = "CASE WHEN referrer_status = 'known' THEN referrer WHEN referrer_status = 'direct' THEN '__direct__' ELSE '__unknown__' END";
  // Fixed dimensions stay scoped to each destination.
  const dimensions = [
    ["geography", "country", "region"], ["browsers", "browser", "''"], ["devices", "device", "''"],
    ["sources", inboundSource, "''"], ["campaigns", "source", "medium || CASE WHEN campaign != '' THEN ' / ' || campaign ELSE '' END"],
  ];
  const breakdowns = dimensions.map(([dimension, value, detail]) => `SELECT section, name, '${dimension}' AS dimension,
    ${value} AS value, ${detail} AS detail, ${counts} FROM activity
    ${dimension === "campaigns" ? "WHERE source != '' OR medium != '' OR campaign != ''" : ""}
    GROUP BY section, name, ${value}, ${detail}`).join(" UNION ALL ");
  // Fixed aggregate queries; user histories use the private view above.
  const results = await env.DB.batch([
    query(`SELECT kind, bot, COUNT(*) AS count FROM events WHERE ${where} GROUP BY kind, bot`),
    query(`SELECT date(occurred_at, 'unixepoch') AS day, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 GROUP BY day, kind ORDER BY day`),
    query(`SELECT CASE WHEN kind = 'pdf_click' THEN target ELSE path END AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('pdf_request','pdf_click','page_view') GROUP BY name, kind ORDER BY count DESC LIMIT 100`),
    query(`SELECT target AS name, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind = 'outbound_click' GROUP BY target ORDER BY count DESC LIMIT 100`),
    query(`SELECT country AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY country, kind ORDER BY count DESC`),
    query(`SELECT ${inboundSource} AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY name, kind ORDER BY count DESC`),
    query(`SELECT browser AS name, device, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY browser, device, kind ORDER BY count DESC`),
    query(`SELECT source, medium, campaign, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND source != '' GROUP BY source, medium, campaign ORDER BY count DESC LIMIT 100`),
    query(`SELECT COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors, COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests FROM events WHERE ${where} AND bot = 0 AND kind = 'pdf_request'`),
    query(`SELECT path AS name, COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors, COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests FROM events WHERE ${where} AND bot = 0 AND kind = 'pdf_request' GROUP BY path ORDER BY COUNT(*) DESC LIMIT 100`),
    query(`${activity} SELECT section, name, ${counts} FROM activity GROUP BY section, name ORDER BY count DESC`),
    query(`${activity}, breakdowns AS (${breakdowns}), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY section, name, dimension ORDER BY count DESC, value, detail) AS rank FROM breakdowns
    ) SELECT section, name, dimension, value, detail, count, visitors, identifiedRequests, unidentifiedRequests FROM ranked WHERE rank <= 50 ORDER BY section, name, dimension, rank`),
    query(`SELECT COUNT(*) AS events FROM events WHERE ${period} AND bot = 0 AND kind IN ('page_view', 'pdf_request', 'outbound_click') AND ${personal}`),
    query(`SELECT region AS name, ${counts} FROM events WHERE ${where} AND bot = 0 AND country = 'US' AND kind IN ('page_view','pdf_request') GROUP BY region ORDER BY count DESC`),
  ]);
  const keys = ["totals", "daily", "pages", "outbound", "countries", "referrers", "devices", "campaigns"];
  return json({ generatedAt: new Date().toISOString(), start: dates.start, end: dates.end,
    ...Object.fromEntries(keys.map((key, i) => [key, results[i].results])),
    pdfVisitors: results[8].results[0], pdfVisitorsByPath: results[9].results,
    documents, items: results[10].results, breakdowns: results[11].results,
    excludePersonal, personalActivity: results[12].results[0],
    states: results[13].results,
    gaPropertyId: "465165532", gaMeasurementId: env.GA_MEASUREMENT_ID, gaPdfForwarding: Boolean(env.GA_API_SECRET && env.GA_MEASUREMENT_ID),
    notes: ["PDF requests are retrieval starts, not confirmed reads. Nonzero byte ranges are excluded; anonymous retries can still count twice.",
      "Distinct visitors are estimated browsers, not identified people, using a random 30-day cookie. Only its hash is stored in D1. Old requests have no visitor identifier and cannot be deduplicated.",
      "Marked personal activity can be filtered from all report aggregates. Do-not-record browsers and privacy opt-outs are never recorded. No raw IPs or fingerprints are stored."] });
}

// Public requests stay on the GitHub Pages origin; Cloudflare routes intercept them.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!HOSTS.has(url.hostname)) return json({ error: "Not found" }, 404);
    if (url.pathname === "/__analytics/preferences") return preferences(request, env).catch(() => json({ error: "Preference unavailable" }, 503));
    if (url.pathname === "/__analytics/report") return report(request, env).catch(() => json({ error: "Analytics unavailable" }, 503));
    if (url.pathname === "/__analytics/event") return collect(request, env, ctx).catch(() => json({ error: "Analytics unavailable" }, 503));
    if (url.pathname === "/__analytics/client.js") return new Response(`(${clientSource})(${JSON.stringify(env.GA_MEASUREMENT_ID || "")});`, { headers: {
      "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
    if (url.pathname.startsWith("/__analytics/")) return json({ error: "Not found" }, 404);
    // Public GET/HEAD content can bypass a tracking-code exception. Private APIs cannot.
    if (request.method === "GET" || request.method === "HEAD") ctx.passThroughOnException?.();
    const response = env.ORIGIN ? await env.ORIGIN.fetch(request) : await fetch(request);
    if (optedOut(request) || request.method !== "GET") return response;
    const type = response.headers.get("Content-Type") || "";
    if ((type.includes("application/pdf") || (response.status === 304 && /\.pdf$/i.test(url.pathname))) && initialPdfRequest(request, response)) {
      const info = metadata(request);
      const visitor = info.bot ? null : visitorIdentity(request);
      background(ctx, record(request, env, { kind: "pdf_request", path: url.pathname, status: response.status, visitorId: visitor?.value }));
      if (visitor) {
        const tracked = new Response(response.body, response);
        tracked.headers.append("Set-Cookie", visitor.cookie);
        if (env.GA_API_SECRET && env.GA_MEASUREMENT_ID) {
          const identity = pdfIdentity(request);
          background(ctx, sendPdfEvent(request, env, identity, info));
          tracked.headers.append("Set-Cookie", pdfCookie(identity));
        }
        // Revalidation makes later opens observable without altering PDF bytes or URLs.
        tracked.headers.set("Cache-Control", "private, no-cache");
        return tracked;
      }
    }
    if (type.includes("text/html") && response.status === 200) {
      background(ctx, record(request, env, { kind: "page_request", path: url.pathname }));
      if (!metadata(request).bot) {
        const tracked = new Response(response.body, response);
        tracked.headers.append("Set-Cookie", visitorIdentity(request).cookie);
        tracked.headers.set("Cache-Control", "private, no-cache");
        return tracked;
      }
    }
    return response;
  },
};
