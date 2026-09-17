// Labels are truncated random-cookie hashes, never cookie values or identities.
// Called only after the report endpoint's bearer, date and personal-filter checks.
import { queryUsage } from "./report-plan.mjs";
import { userReading, historyReading } from "./engagement.mjs";
import { pdfDiagnostics } from "./pdf-diagnostics.mjs";

function liveActivityQuery(excludePersonal, page) {
  // Both branches use time indexes; fallback activity never creates heartbeat writes.
  return `SELECT visitor_hash, MAX(time) AS liveAt, MAX(expires) AS liveUntil FROM (
    SELECT s.visitor_hash, s.last_seen AS time, s.last_seen + 315 AS expires
    FROM reading_sessions s WHERE s.active = 1
      AND s.last_seen >= unixepoch() - 315 AND s.last_seen <= unixepoch()
      AND s.last_seen >= ?1 AND s.last_seen < ?2 ${page ? "AND s.path = ?3" : ""}
      ${excludePersonal ? "AND s.is_personal = 0 AND s.visitor_hash NOT IN (SELECT visitor_hash FROM personal_visitors)" : ""}
    UNION ALL
    SELECT e.visitor_hash, e.occurred_at AS time, e.occurred_at + 300 AS expires
    FROM events e LEFT JOIN reading_sessions s ON s.id = e.id
    WHERE e.occurred_at >= unixepoch() - 300 AND e.occurred_at <= unixepoch()
      AND e.occurred_at >= ?1 AND e.occurred_at < ?2
      AND e.bot = 0 AND e.duplicate_of = '' AND e.visitor_hash != ''
      AND e.kind IN ('page_view','pdf_request','outbound_click')
      AND (s.id IS NULL OR s.seq < 0)
      ${page ? "AND CASE WHEN e.path IN ('/index','/index.html') THEN '/' ELSE e.path END = ?3" : ""}
      ${excludePersonal ? "AND e.is_personal = 0 AND e.visitor_hash NOT IN (SELECT visitor_hash FROM personal_visitors)" : ""}
  ) GROUP BY visitor_hash`;
}

export async function userReport(db, url, dates, personal, excludePersonal, page = "") {
  const user = url.searchParams.get("user") || "";
  const offsetText = url.searchParams.get("offset") || "0";
  if ((user && !/^[a-f0-9]{24}$/.test(user)) || !/^\d{1,7}$/.test(offsetText)) return { error: "Invalid user or offset" };
  const offset = Number(offsetText), limit = user ? 100 : 15;
  const live = url.searchParams.get("view") === "live";
  const params = [dates.from, dates.until, ...(page ? [page] : [])];
  const cohort = page ? `AND visitor_hash IN (SELECT visitor_hash FROM events
    WHERE CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END = ?3
      AND ((occurred_at >= ?1 AND occurred_at < ?2) OR id IN (SELECT session_id FROM reading_hours WHERE hour >= ?1 AND hour < ?2))
      AND bot = 0 AND duplicate_of = '' AND kind IN ('page_view','pdf_request'))` : "";
  const activitySql = liveActivityQuery(excludePersonal, page);
  const liveFilter = live ? `AND visitor_hash IN (SELECT visitor_hash FROM (${activitySql}))` : "";
  const base = `FROM events WHERE ((occurred_at >= ?1 AND occurred_at < ?2)
      OR id IN (SELECT session_id FROM reading_hours WHERE hour >= ?1 AND hour < ?2))
    AND duplicate_of = '' ${excludePersonal ? `AND NOT ${personal}` : ""}
    AND bot = 0 AND visitor_hash != '' AND kind IN ('page_view', 'pdf_request', 'outbound_click') ${cohort} ${liveFilter}`;
  let rows, addresses = [], unrecordedIpEvents = 0, diagnostics, diagnosticsMore = false, diagnosticsUnavailable = false;
  const measured = [];
  if (user) {
    rows = await db.prepare(`SELECT id, occurred_at AS time, occurred_at < ?1 AS continued, kind,
      CASE WHEN path IN ('/index.html', '/index') THEN '/' ELSE path END AS path,
      target, country, region, city, county, county_fips, ip_address, browser, device, os,
      CASE WHEN referrer_status = 'known' THEN referrer WHEN referrer_status = 'direct' THEN '__direct__' ELSE '__unknown__' END AS referrer,
      source, medium, campaign, ${personal} AS personal
      ${base} AND substr(visitor_hash, 1, 24) = ? ORDER BY occurred_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .bind(...params, user, limit + 1, offset).all();
    // Cover the full filtered history, not just its current 100-event page.
    const ipRows = await db.prepare(`SELECT ip_address AS address, COUNT(*) AS events,
      MIN(occurred_at) AS firstSeen, MAX(occurred_at) AS lastSeen
      ${base} AND substr(visitor_hash, 1, 24) = ? GROUP BY ip_address ORDER BY lastSeen DESC, address`)
      .bind(...params, user).all();
    addresses = ipRows.results.filter(row => row.address);
    unrecordedIpEvents = ipRows.results.find(row => !row.address)?.events || 0;
    measured.push(["userHistory", rows], ["userAddresses", ipRows]);
    try {
      const diagnosticReport = await pdfDiagnostics(db, dates, excludePersonal, user);
      diagnostics = diagnosticReport.rows;
      diagnosticsMore = diagnosticReport.nextOffset !== null;
      measured.push(diagnosticReport.measured);
    } catch { diagnosticsUnavailable = true; }
  } else {
    rows = await db.prepare(`WITH activity AS (
      SELECT visitor_hash, occurred_at, kind, path, country, region, city, county, county_fips, browser, device, os,
        ${personal} AS personal, ROW_NUMBER() OVER (PARTITION BY visitor_hash ORDER BY occurred_at DESC, rowid DESC) AS recent ${base}
    ) SELECT substr(visitor_hash, 1, 24) AS id, COUNT(*) AS events,
      SUM(kind != 'outbound_click' AND occurred_at >= ?1 AND occurred_at < ?2) AS views, SUM(kind = 'outbound_click') AS clicks,
      SUM(kind = 'pdf_request') AS pdfViews,
      MIN(occurred_at) AS firstSeen, MAX(occurred_at) AS lastSeen, MAX(personal) AS personal,
      MAX(CASE WHEN recent = 1 THEN CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END END) AS lastPath,
      MAX(CASE WHEN recent = 1 THEN country END) AS country, MAX(CASE WHEN recent = 1 THEN region END) AS region,
      MAX(CASE WHEN recent = 1 THEN city END) AS city,
      MAX(CASE WHEN recent = 1 THEN county END) AS county, MAX(CASE WHEN recent = 1 THEN county_fips END) AS county_fips,
      MAX(CASE WHEN recent = 1 THEN browser END) AS browser, MAX(CASE WHEN recent = 1 THEN device END) AS device,
      MAX(CASE WHEN recent = 1 THEN os END) AS os
      FROM activity GROUP BY visitor_hash ORDER BY lastSeen DESC, id LIMIT ? OFFSET ?`)
      .bind(...params, limit + 1, offset).all();
    measured.push(["users", rows]);
  }
  const visible = rows.results.slice(0, limit);
  const labels = user ? [user] : visible.map(row => row.id);
  const activity = labels.length ? await db.prepare(`SELECT substr(visitor_hash,1,24) AS id, liveAt, liveUntil
    FROM (${activitySql}) WHERE substr(visitor_hash,1,24) IN (${labels.map(() => "?").join(",")})`)
    .bind(...params, ...labels).all() : null;
  if (activity) measured.push(["userLiveActivity", activity]);
  const byActivity = new Map(activity?.results.map(({ id, ...row }) => [id, row]) || []);
  const liveDetails = id => byActivity.get(id) || { liveAt: 0, liveUntil: 0 };
  const reading = await userReading(db, dates, excludePersonal, user ? [user] : visible.map(row => row.id));
  if (reading.measured) measured.push(reading.measured);
  let engagement;
  if (user) {
    engagement = visible.length ? { ...reading.rows[0], ...liveDetails(user) } : undefined;
    const history = await historyReading(db, dates, excludePersonal, visible.map(row => row.id));
    measured.push(...history.measured);
    const byId = new Map(history.rows.map(row => [row.id, row]));
    for (const row of visible) {
      if (byId.has(row.id)) Object.assign(row, byId.get(row.id));
      else if (["page_view", "pdf_request"].includes(row.kind)) row.readingStatus = "untracked";
    }
  } else {
    const byUser = new Map(reading.rows.map(row => [row.id, row]));
    for (const row of visible) {
      const detail = byUser.get(row.id);
      row.pdfViewerSessions = detail?.pdfViewerSessions ?? 0;
      if (detail) {
        Object.assign(row, detail);
        if (detail.lastReadingAt >= row.lastSeen && detail.lastReadingAt < dates.until) row.lastPath = detail.lastReadingPath;
      }
      Object.assign(row, liveDetails(row.id));
    }
  }
  return { start: dates.start, end: dates.end, excludePersonal, page, live, user, offset, limit,
    ...(engagement ? { engagement } : {}),
    ...(user ? { addresses, unrecordedIpEvents, diagnostics, diagnosticsMore, diagnosticsUnavailable } : {}),
    queryUsage: queryUsage(measured), rows: visible, nextOffset: rows.results.length > limit ? offset + limit : null };
}
