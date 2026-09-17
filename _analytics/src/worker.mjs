import clientSource from "./client.mjs";
import { pdfIdentity, pdfCookie, sendPdfEvent } from "./ga.mjs";
import { excludedBrowser, personalBrowser, preferences, visitorIdentity, visitorHash } from "./preferences.mjs";
import documents from "./documents.mjs";
import { userReport } from "./users.mjs";
import { TIME_ZONE, pacificDate, pacificMidnight, pacificDaily } from "./time.mjs";
import { estimatedCounty } from "./geography.mjs";
import { connectingIp } from "./ip.mjs";
import { QUERY_NAMES, REPORT_PLANS, queryUsage } from "./report-plan.mjs";
import { headlineSummary } from "./summary.mjs";
import { startReading, saveReading, readingItems, addReadingItems } from "./engagement.mjs";
import engagementSource from "./engagement-client.mjs";
import { pdfViewerResponse, pdfNavigationReason } from "./pdf-viewer.mjs";
import { readUsage } from "./usage.mjs";
import { recordPdfDiagnostic, validDiagnosticSignal, updatePdfDiagnostic, pdfDiagnostics } from "./pdf-diagnostics.mjs";

// Configuration and bounded, privacy-preserving normalization.
const HOSTS = new Set(["www.andrewcwmyers.com", "andrewcwmyers.com"]);
const KINDS = new Set(["page_view", "outbound_click", "pdf_click", "pdf_view"]);
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
  const os = /Windows Phone/i.test(ua) ? "Windows Phone" : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS" : /CrOS/i.test(ua) ? "ChromeOS" : /Windows/i.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/i.test(ua) ? "macOS" : /Linux/i.test(ua) ? "Linux" : "";
  return { bot, browser, device, os };
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

async function boundedJson(request, maximum = 4096) {
  if (Number(request.headers.get("Content-Length")) > maximum) throw new Error("large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty");
  let length = 0, text = "";
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.length;
    if (length > maximum) { await reader.cancel(); throw new Error("large"); }
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
  return { ...info, ...estimatedCounty(cf), referrer, referrerStatus, country: String(cf.country || "").slice(0, 2), region: String(cf.regionCode || "").slice(0, 20),
    city: typeof cf.city === "string" ? cf.city.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) : "",
    source: campaign("utm_source"), medium: campaign("utm_medium"), campaign: campaign("utm_campaign") };
}

function browserAttribution(body) {
  const referrer = cleanUrl(body.referrer);
  const campaign = key => typeof body[key] === "string" ? body[key].replace(/[^a-zA-Z0-9_. -]/g, "").slice(0, 100) : "";
  return { referrer: referrer ? new URL(referrer).hostname : "", referrerStatus: referrer ? "known" : body.referrer === "" ? "direct" : "unknown",
    source: campaign("source"), medium: campaign("medium"), campaign: campaign("campaign") };
}

async function record(request, env, event) {
  if (!env.DB || optedOut(request)) return false;
  const m = { ...metadata(request), ...event.attribution };
  const visitor = event.visitorId ? await visitorHash(event.visitorId) : "";
  const id = event.id || crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  // One atomic insert handles concurrent PDF retries across Worker instances.
  // Keep the raw row; the earliest counted retrieval anchors a five-second window.
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO events
    (id, occurred_at, kind, path, target, referrer, source, medium, campaign, country, region, browser, device, bot, status, visitor_hash, referrer_status, is_personal, county, county_fips, ip_address, city, os, bot_score, duplicate_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? = 'pdf_request' AND ? != '' THEN COALESCE((
        SELECT id FROM events WHERE kind = 'pdf_request' AND duplicate_of = ''
          AND visitor_hash = ? AND path = ? AND occurred_at BETWEEN ? AND ?
        ORDER BY occurred_at, rowid LIMIT 1
      ), '') ELSE '' END)`)
    .bind(id, now, event.kind, event.path, event.target || "",
      m.referrer, m.source, m.medium, m.campaign, m.country, m.region, m.browser, m.device, m.bot, event.status || 200, visitor, m.referrerStatus, personalBrowser(request) ? 1 : 0, m.county, m.county_fips, connectingIp(request), m.city, m.os, null,
      event.viewer ? '' : event.kind, visitor, visitor, event.path, now - 5, now).run();
  if ((inserted.meta?.changes ?? inserted.changes) === 0) return false;
  if (event.kind !== 'pdf_request') return true;
  const stored = await env.DB.prepare("SELECT duplicate_of FROM events WHERE id = ?").bind(id).all();
  return stored.results[0]?.duplicate_of === '';
}

function background(ctx, promise) {
  // Analytics must never delay or fail the public content response.
  ctx.waitUntil(promise.catch(() => console.warn("Analytics write failed")));
}

async function recordRoute(request, env, data) {
  if (!env.DB || optedOut(request)) return;
  if (env.PDF_DIAGNOSTIC_LIMIT && !(await env.PDF_DIAGNOSTIC_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" })).success) return;
  await recordPdfDiagnostic(env.DB, request, data);
}

async function diagnosticSignal(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "Forbidden" }, 403);
  if (optedOut(request)) return new Response(null, { status: 204 });
  if (!env.DB) return json({ error: "Unavailable" }, 503);
  if (env.PDF_DIAGNOSTIC_LIMIT && !(await env.PDF_DIAGNOSTIC_LIMIT.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" })).success) return json({ error: "Rate limited" }, 429);
  let body;
  try { body = await boundedJson(request, 512); } catch { return json({ error: "Invalid diagnostic" }, 400); }
  if (!validDiagnosticSignal(body)) return json({ error: "Invalid diagnostic" }, 400);
  const status = await updatePdfDiagnostic(env.DB, body, await visitorHash(visitorIdentity(request).value));
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
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
  if (["outbound_click", "pdf_click"].includes(body.kind) && !target) return json({ error: "Invalid target" }, 400);
  if (body.kind === "pdf_view" && (!/\.pdf$/i.test(path) || !documents.some(document => document.name === path))) return json({ error: "Invalid document" }, 400);
  const visitor = metadata(request).bot ? null : visitorIdentity(request);
  const measured = body.kind === "pdf_view" || (body.kind === "page_view" && body.engagement === true && ["/", "/index", "/index.html"].includes(path));
  const work = record(request, env, { id: body.id, kind: body.kind === "pdf_view" ? "pdf_request" : body.kind,
    path, target, visitorId: visitor?.value, viewer: body.kind === "pdf_view", attribution: browserAttribution(body) });
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  if (visitor) headers.append("Set-Cookie", visitor.cookie);
  if (measured && visitor && env.DB) {
    const counted = await work;
    await startReading(env.DB, body.id, await visitorHash(visitor.value));
    if (counted && body.kind === "pdf_view" && env.GA_API_SECRET && env.GA_MEASUREMENT_ID) {
      const identity = pdfIdentity(request);
      headers.append("Set-Cookie", pdfCookie(identity));
      const pdfRequest = new Request(new URL(path, request.url), { headers: request.headers });
      background(ctx, sendPdfEvent(pdfRequest, env, identity, { ...metadata(request), ...browserAttribution(body) }));
    }
  } else background(ctx, work);
  return new Response(null, { status: 204, headers });
}

async function engagement(request, env) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (request.headers.get("Origin") !== new URL(request.url).origin) return json({ error: "Forbidden" }, 403);
  if (optedOut(request) || personalBrowser(request) || metadata(request).bot) return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (!env.DB) return json({ error: "Database unavailable" }, 503);
  if (env.COLLECT_LIMIT && !(await env.COLLECT_LIMIT.limit({ key: `reading:${request.headers.get("CF-Connecting-IP") || "unknown"}` })).success) return json({ error: "Rate limited" }, 429);
  let body;
  try { body = await boundedJson(request, 16384); } catch { return json({ error: "Invalid reading update" }, 400); }
  const status = await saveReading(env.DB, body, await visitorHash(visitorIdentity(request).value));
  return status === 204 ? new Response(null, { status, headers: JSON_HEADERS }) : json({ error: "Invalid reading update" }, status);
}

export function reportDates(url) {
  const end = url.searchParams.get("end") || pacificDate();
  const start = url.searchParams.get("start") || new Date(Date.parse(pacificDate()) - 29 * 86400000).toISOString().slice(0, 10);
  const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(start) || !valid(end)) return null;
  if (end < start || Date.parse(end) - Date.parse(start) >= 366 * 86400000) return null;
  const from = pacificMidnight(start), until = pacificMidnight(new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10));
  return { start, end, from, until };
}

async function report(request, env) {
  if (!await authorized(request, env.READ_TOKEN)) return json({ error: "Unauthorized" }, 401);
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  if (url.searchParams.get("view") === "usage") return json(await readUsage(env));
  const dates = reportDates(url);
  if (!dates) return json({ error: "Invalid date range (maximum 366 days)" }, 400);
  if (!env.DB) return json({ error: "Database unavailable" }, 503);
  const filter = url.searchParams.get("excludePersonal") ?? "1";
  if (!["0", "1"].includes(filter)) return json({ error: "Invalid personal-activity filter" }, 400);
  const excludePersonal = filter === "1";
  const page = url.searchParams.get("page") || "";
  if (page && (cleanPath(page) !== page || /[\\\u0000-\u0020]/.test(page))) return json({ error: "Invalid page filter" }, 400);
  const period = `occurred_at >= ? AND occurred_at < ? AND duplicate_of = ''${page ? " AND CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END = ?3" : ""}`;
  const personal = "(is_personal = 1 OR visitor_hash IN (SELECT visitor_hash FROM personal_visitors))";
  const where = `${period}${excludePersonal ? ` AND NOT ${personal}` : ""}`;
  if (url.searchParams.get("view") === "pdf_diagnostics") {
    const user = url.searchParams.get("user") || "", offsetText = url.searchParams.get("offset") || "0";
    if ((user && !/^[a-f0-9]{24}$/.test(user)) || !/^\d{1,7}$/.test(offsetText)) return json({ error: "Invalid diagnostic query" }, 400);
    const value = await pdfDiagnostics(env.DB, dates, excludePersonal, user, Number(offsetText), page);
    return json({ start: dates.start, end: dates.end, excludePersonal, user, offset: Number(offsetText), rows: value.rows,
      nextOffset: value.nextOffset, queryUsage: queryUsage([value.measured]) });
  }
  if (["users", "live"].includes(url.searchParams.get("view"))) {
    const value = await userReport(env.DB, url, dates, personal, excludePersonal, page);
    return json(value, value.error ? 400 : 200);
  }
  const view = url.searchParams.get("view") || "all";
  if (!Object.hasOwn(REPORT_PLANS, view)) return json({ error: "Invalid report view" }, 400);
  if (view === "summary" && !page) {
    const summary = await headlineSummary(env.DB, dates, excludePersonal);
    const reading = await readingItems(env.DB, dates, excludePersonal);
    const engagement = reading.rows.reduce((total, row) => ({ readingSeconds: total.readingSeconds + row.readingSeconds, downloads: total.downloads + row.downloads }), { readingSeconds: 0, downloads: 0 });
    return json({ generatedAt: new Date().toISOString(), timeZone: TIME_ZONE, start: dates.start, end: dates.end,
      excludePersonal, page, documents, engagement, gaPropertyId: "465165532", gaMeasurementId: env.GA_MEASUREMENT_ID,
      gaPdfForwarding: Boolean(env.GA_API_SECRET && env.GA_MEASUREMENT_ID), view, ...summary,
      queryUsage: { ...summary.queryUsage, queryCount: summary.queryUsage.queryCount + 1,
        rowsRead: summary.queryUsage.rowsRead === null || reading.measured[1].meta?.rows_read == null ? null : summary.queryUsage.rowsRead + reading.measured[1].meta.rows_read,
        queries: [...summary.queryUsage.queries, ...queryUsage([reading.measured]).queries] } });
  }
  const section = url.searchParams.get("section") || "", name = url.searchParams.get("name") || "";
  if (view === "detail" && (!["main", "outbound"].includes(section) || !name || name.length > 2048)) return json({ error: "Invalid detail query" }, 400);
  // SQLite expression indexes require the same expression, including IN-list order.
  const mainPath = "CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END";
  const scope = view === "detail" ? section : view === "outbound" ? "outbound" : ["papers", "overview"].includes(view) ? "main" : "";
  const itemFilter = scope === "outbound" ? " AND kind = 'outbound_click'" : scope === "main" ? " AND kind IN ('page_view','pdf_request')" : "";
  const detailFilter = view === "detail" ? ` AND ${section === "outbound" ? "target" : mainPath} = ?` : "";
  const query = (sql) => ({ sql, params: [dates.from, dates.until, ...(page ? [page] : []), ...(view === "detail" && sql.startsWith("WITH activity AS") ? [name] : [])] });
  const activity = (materialized = false) => `WITH activity AS ${materialized ? "MATERIALIZED " : ""}(
    SELECT *, CASE WHEN kind = 'outbound_click' THEN 'outbound' ELSE 'main' END AS section,
      CASE WHEN kind = 'outbound_click' THEN target WHEN path IN ('/index.html', '/index') THEN '/' ELSE path END AS name
    FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view', 'pdf_request', 'outbound_click')${itemFilter}${detailFilter}
  )`;
  const counts = `COUNT(*) AS count, COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors,
    COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests`;
  const inboundSource = "CASE WHEN referrer_status = 'known' THEN referrer WHEN referrer_status = 'direct' THEN '__direct__' ELSE '__unknown__' END";
  // Fixed dimensions stay scoped to each destination.
  const dimensions = [
    ["geography", "country", "region"], ["browsers", "browser", "''"], ["devices", "device", "os"],
    ["sources", inboundSource, "''"], ["campaigns", "source", "medium || CASE WHEN campaign != '' THEN ' / ' || campaign ELSE '' END"],
  ];
  const breakdowns = dimensions.map(([dimension, value, detail]) => `SELECT section, name, '${dimension}' AS dimension,
    ${value} AS value, ${detail} AS detail, ${counts} FROM activity
    ${dimension === "campaigns" ? "WHERE source != '' OR medium != '' OR campaign != ''" : ""}
    GROUP BY section, name, ${value}, ${detail}`).join(" UNION ALL ");
  // Fixed aggregate queries; user histories use the private view above.
  const queries = [
    query(`SELECT kind, bot, ${counts} FROM events WHERE ${where} GROUP BY kind, bot`),
    query(`SELECT strftime('%Y-%m-%dT%H:00:00Z', occurred_at, 'unixepoch') AS hour, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 GROUP BY hour, kind ORDER BY hour`),
    query(`SELECT CASE WHEN kind = 'pdf_click' THEN target ELSE path END AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('pdf_request','pdf_click','page_view') GROUP BY name, kind ORDER BY count DESC LIMIT 100`),
    query(`SELECT target AS name, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind = 'outbound_click' GROUP BY target ORDER BY count DESC LIMIT 100`),
    query(`SELECT country AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY country, kind ORDER BY count DESC`),
    query(`SELECT ${inboundSource} AS name, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY name, kind ORDER BY count DESC`),
    query(`SELECT browser AS name, device, os, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY browser, device, os, kind ORDER BY count DESC`),
    query(`SELECT source, medium, campaign, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND source != '' GROUP BY source, medium, campaign ORDER BY count DESC LIMIT 100`),
    query(`SELECT COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors, COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests FROM events WHERE ${where} AND bot = 0 AND kind = 'pdf_request'`),
    query(`SELECT path AS name, COUNT(DISTINCT NULLIF(visitor_hash, '')) AS visitors, COUNT(NULLIF(visitor_hash, '')) AS identifiedRequests, COUNT(*) - COUNT(NULLIF(visitor_hash, '')) AS unidentifiedRequests FROM events WHERE ${where} AND bot = 0 AND kind = 'pdf_request' GROUP BY path ORDER BY COUNT(*) DESC LIMIT 100`),
    query(`${activity()} SELECT section, name, ${counts} FROM activity GROUP BY section, name ORDER BY count DESC`),
    query(`${activity(true)}, breakdowns AS (${breakdowns}), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY section, name, dimension ORDER BY count DESC, value, detail) AS rank FROM breakdowns
    ) SELECT section, name, dimension, value, detail, count, visitors, identifiedRequests, unidentifiedRequests FROM ranked WHERE rank <= 50 ORDER BY section, name, dimension, rank`),
    query(`SELECT COUNT(*) AS events FROM events WHERE ${period} AND bot = 0 AND kind IN ('page_view', 'pdf_request', 'outbound_click') AND ${personal}`),
    query(`SELECT region AS name, ${counts} FROM events WHERE ${where} AND bot = 0 AND country = 'US' AND kind IN ('page_view','pdf_request') GROUP BY region ORDER BY count DESC`),
    query(`SELECT county_fips AS name, county, region, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND country IN ('US','PR') AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY county_fips, county, region, kind ORDER BY count DESC`),
    query(`SELECT county_fips AS name, county, region, ${counts} FROM events WHERE ${where} AND bot = 0 AND country IN ('US','PR') AND kind IN ('page_view','pdf_request') GROUP BY county_fips, county, region ORDER BY count DESC`),
    // D1 permits only five compound SELECT terms; finer geography stays separate.
    query(`${activity(true)}, location_counts AS (
      SELECT section, name, 'counties' AS dimension, county AS value, region AS detail, ${counts}
      FROM activity WHERE country IN ('US','PR') GROUP BY section, name, county, region
      UNION ALL
      SELECT section, name, 'cities' AS dimension, city AS value, country || ' / ' || region AS detail, ${counts}
      FROM activity GROUP BY section, name, city, country, region
      UNION ALL
      SELECT section, name, 'countries' AS dimension, country AS value, '' AS detail, ${counts}
      FROM activity GROUP BY section, name, country
    ), ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY section, name, dimension ORDER BY count DESC, value, detail) AS rank FROM location_counts
    ) SELECT section, name, dimension, value, detail, count, visitors, identifiedRequests, unidentifiedRequests FROM ranked WHERE dimension = 'countries' OR rank <= 50 ORDER BY section, name, rank`),
    query(`SELECT city AS name, country, region, kind, COUNT(*) AS count FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request','outbound_click') GROUP BY city, country, region, kind ORDER BY count DESC`),
    query(`SELECT country AS name, ${counts} FROM events WHERE ${where} AND bot = 0 AND kind IN ('page_view','pdf_request') GROUP BY country ORDER BY count DESC`),
  ];
  const selected = queries.map((entry, index) => ({ ...entry, index, name: QUERY_NAMES[index] }))
    .filter(entry => REPORT_PLANS[view].includes(entry.name));
  const executed = await env.DB.batch(selected.map(entry => env.DB.prepare(entry.sql).bind(...entry.params)));
  const measuredQueries = selected.map((entry, index) => [entry.name, executed[index]]);
  const results = queries.map(() => ({ results: [] }));
  selected.forEach((entry, index) => { results[entry.index] = executed[index]; });
  let engagement;
  if (["all", "summary", "overview", "papers"].includes(view) || (view === "detail" && section === "main")) {
    const reading = await readingItems(env.DB, dates, excludePersonal, view === "detail" ? name : page);
    if (page && view === "detail" && name !== page) reading.rows = [];
    engagement = reading.rows.reduce((total, row) => ({ readingSeconds: total.readingSeconds + row.readingSeconds, downloads: total.downloads + row.downloads }), { readingSeconds: 0, downloads: 0 });
    results[10].results = addReadingItems(results[10].results, reading.rows);
    measuredQueries.push(reading.measured);
  }
  const keys = ["totals", "daily", "pages", "outbound", "countries", "referrers", "devices", "campaigns"];
  results[1].results = pacificDaily(results[1].results);
  const value = { generatedAt: new Date().toISOString(), timeZone: TIME_ZONE, start: dates.start, end: dates.end,
    ...Object.fromEntries(keys.map((key, i) => [key, results[i].results])),
    pdfVisitors: results[8].results[0], pdfVisitorsByPath: results[9].results,
    documents, items: results[10].results, breakdowns: [...results[11].results, ...results[16].results],
    excludePersonal, page, engagement, personalActivity: results[12].results[0],
    states: results[13].results,
    counties: results[14].results, countyViews: results[15].results,
    cities: results[17].results,
    countryViews: results[18].results,
    gaPropertyId: "465165532", gaMeasurementId: env.GA_MEASUREMENT_ID, gaPdfForwarding: Boolean(env.GA_API_SECRET && env.GA_MEASUREMENT_ID),
    notes: ["PDF requests are retrieval starts, not confirmed reads. Same-browser/same-PDF retrievals within five seconds are counted once. Nonzero byte ranges are excluded; unidentified retries can still count twice.",
      "Distinct visitors are estimated browsers, not identified people, using a random 30-day cookie. Only its hash is stored in D1. Old requests have no visitor identifier and cannot be deduplicated.",
      "Marked personal activity can be filtered from all report aggregates. Privacy opt-outs are never recorded. IP addresses are retained privately and shown only in authenticated user profiles; no fingerprints are created."] };
  const fields = new Set(["generatedAt", "timeZone", "start", "end", "excludePersonal", "page", "engagement", "documents", "gaPropertyId", "gaMeasurementId", "gaPdfForwarding", ...REPORT_PLANS[view]]);
  return json({ ...(view === "all" ? value : Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key)))),
    view, ...(view === "detail" ? { section, name } : {}),
    queryUsage: queryUsage(measuredQueries) });
}

// Public requests stay on the GitHub Pages origin; Cloudflare routes intercept them.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!HOSTS.has(url.hostname)) return json({ error: "Not found" }, 404);
    if (url.pathname.startsWith("/__pdfjs/")) {
      if (!env.ASSETS || !["GET", "HEAD"].includes(request.method)) return json({ error: "Not found" }, 404);
      const asset = new URL(request.url);
      asset.pathname = asset.pathname.slice("/__pdfjs".length);
      return env.ASSETS.fetch(new Request(asset, request));
    }
    if (url.pathname === "/__analytics/preferences") return preferences(request, env).catch(() => json({ error: "Preference unavailable" }, 503));
    if (url.pathname === "/__analytics/report") return report(request, env).catch(error => {
      console.error("Analytics report failed", error.message);
      return json({ error: "Analytics unavailable" }, 503);
    });
    if (url.pathname === "/__analytics/event") return collect(request, env, ctx).catch(() => json({ error: "Analytics unavailable" }, 503));
    if (url.pathname === "/__analytics/engagement") return engagement(request, env).catch(() => json({ error: "Analytics unavailable" }, 503));
    if (url.pathname === "/__analytics/pdf-diagnostic") return diagnosticSignal(request, env).catch(() => json({ error: "Diagnostics unavailable" }, 503));
    if (url.pathname === "/__analytics/engagement.js") return new Response(engagementSource, { headers: {
      "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
    if (url.pathname === "/__analytics/client.js") return new Response(`(${clientSource})(${JSON.stringify(env.GA_MEASUREMENT_ID || "")});`, { headers: {
      "Content-Type": "application/javascript", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
    if (url.pathname.startsWith("/__analytics/")) return json({ error: "Not found" }, 404);
    // Public GET/HEAD content can bypass a tracking-code exception. Private APIs cannot.
    if (request.method === "GET" || request.method === "HEAD") ctx.passThroughOnException?.();
    const pdfPath = /\.pdf$/i.test(url.pathname) && documents.some(document => document.name === url.pathname);
    const pdfReason = !pdfPath ? "" : url.searchParams.has("__pdf") ? "explicit_raw" : metadata(request).bot ? "known_bot" : pdfNavigationReason(request);
    if (pdfPath && pdfReason === "viewer") {
      const visitor = !optedOut(request) ? visitorIdentity(request) : null;
      const id = visitor ? crypto.randomUUID() : "";
      const viewer = pdfViewerResponse(url.pathname, env.GA_MEASUREMENT_ID, Boolean(visitor), id);
      if (visitor) {
        viewer.headers.append("Set-Cookie", visitor.cookie);
        background(ctx, recordRoute(request, env, { id, path: url.pathname, reason: pdfReason, status: 200, visitorId: visitor.value }));
      }
      return viewer;
    }
    const response = env.ORIGIN ? await env.ORIGIN.fetch(request) : await fetch(request);
    // PDF.js fetches bytes separately; its rendered view creates exactly one event.
    if (pdfPath && url.searchParams.get("__pdf") === "raw" && (
      request.headers.get("X-ACW-PDF-Viewer") === "1" ||
      (request.headers.get("Sec-Fetch-Dest") === "empty" && request.headers.get("Sec-Fetch-Site") === "same-origin")
    )) return response;
    if (optedOut(request) || request.method !== "GET") return response;
    const diagnosticId = pdfPath ? crypto.randomUUID() : undefined;
    const pdfInfo = pdfPath ? metadata(request) : null;
    const pdfVisitor = pdfInfo && !pdfInfo.bot ? visitorIdentity(request) : null;
    // Skip continuation byte ranges and the viewer's internal fetches above.
    if (pdfPath && (!request.headers.has("Range") || /^bytes=0-\d*$/.test(request.headers.get("Range")))) {
      background(ctx, recordRoute(request, env, { id: diagnosticId, path: url.pathname, reason: pdfReason,
        status: response.status, visitorId: pdfVisitor?.value, bot: pdfInfo.bot }));
    }
    const type = response.headers.get("Content-Type") || "";
    if ((type.includes("application/pdf") || (response.status === 304 && /\.pdf$/i.test(url.pathname))) && initialPdfRequest(request, response)) {
      const info = metadata(request);
      const visitor = pdfVisitor || (info.bot ? null : visitorIdentity(request));
      const identity = visitor && env.GA_API_SECRET && env.GA_MEASUREMENT_ID ? pdfIdentity(request) : null;
      background(ctx, record(request, env, { id: diagnosticId, kind: "pdf_request", path: url.pathname, status: response.status, visitorId: visitor?.value })
        .then(counted => counted && identity ? sendPdfEvent(request, env, identity, info) : undefined));
      if (visitor) {
        const tracked = new Response(response.body, response);
        tracked.headers.append("Set-Cookie", visitor.cookie);
        if (identity) {
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
