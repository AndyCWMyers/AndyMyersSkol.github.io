import { validAttention, summarizeAttention, ATTENTION_MONOTONIC } from "./homepage-attention.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = new Set(["page_view", "pdf_request"]);
const PERSONAL = "(s.is_personal = 1 OR s.visitor_hash IN (SELECT visitor_hash FROM personal_visitors))";

export async function startReading(db, id, visitor) {
  if (!visitor) return;
  await db.prepare(`INSERT OR IGNORE INTO reading_sessions(id, visitor_hash, path, kind, is_personal, started_at, last_seen)
    SELECT id, visitor_hash, CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END,
      kind, is_personal, occurred_at, occurred_at FROM events
    WHERE id = ? AND visitor_hash = ? AND bot = 0 AND duplicate_of = '' AND kind IN ('page_view','pdf_request')`)
    .bind(id, visitor).run();
}

export function validReading(body, now = Date.now()) {
  if (!body || !UUID.test(body.id || "") || !Number.isSafeInteger(body.seq) || body.seq < 0 || body.seq > 10000000
    || typeof body.active !== "boolean" || !Number.isSafeInteger(body.milliseconds) || body.milliseconds < 0 || body.milliseconds > 128 * 3600000
    || !Number.isSafeInteger(body.downloads) || body.downloads < 0 || body.downloads > 10000
    || !Number.isSafeInteger(body.at) || body.at > now + 60000 || body.at < now - 86400000
    || !Array.isArray(body.hours) || body.hours.length > 128) return false;
  const seen = new Set();
  let milliseconds = 0, downloads = 0;
  for (const row of body.hours) {
    if (!row || !Number.isSafeInteger(row.hour) || row.hour % 3600 || seen.has(row.hour)
      || row.hour > Math.floor((now + 60000) / 3600000) * 3600
      || !Number.isSafeInteger(row.milliseconds) || row.milliseconds < 0 || row.milliseconds > 3600000
      || !Number.isSafeInteger(row.downloads) || row.downloads < 0 || row.downloads > 10000
      || !validAttention(row.attention, row.milliseconds)) return false;
    seen.add(row.hour); milliseconds += row.milliseconds; downloads += row.downloads;
  }
  return milliseconds === body.milliseconds && downloads === body.downloads;
}

export async function saveReading(db, body, visitor, now = Date.now()) {
  if (!validReading(body, now)) return 400;
  const stored = await db.prepare(`SELECT s.*, ${PERSONAL} AS personal FROM reading_sessions s
    WHERE s.id = ? AND s.visitor_hash = ?`).bind(body.id, visitor).all();
  const session = stored.results[0];
  if (!session || !KINDS.has(session.kind)) return 404;
  // Keep viewer confirmation and historical measurements, but never add host engagement.
  if (session.personal) return 204;
  if (body.hours.some(row => row.attention !== undefined) && (session.kind !== "page_view" || session.path !== "/")) return 400;
  if (body.seq <= session.seq) return 204;
  if (body.milliseconds < session.milliseconds || body.downloads < session.downloads
    || body.milliseconds > now - session.started_at * 1000 + 60000
    || (session.kind === "page_view" && body.downloads)
    || body.hours.some(row => row.hour < Math.floor(session.started_at / 3600) * 3600 - 3600)) return 400;
  const lastSeen = Math.min(Math.floor(now / 1000), Math.floor(body.at / 1000));
  const statements = [db.prepare(`UPDATE reading_sessions SET seq = ?, milliseconds = ?, downloads = ?, last_seen = ?, active = ?
    WHERE id = ? AND visitor_hash = ? AND seq < ? AND milliseconds <= ? AND downloads <= ?
      AND NOT EXISTS (SELECT 1 FROM reading_hours h WHERE h.session_id = reading_sessions.id
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value,'$.hour') = h.hour
          AND json_extract(j.value,'$.milliseconds') >= h.milliseconds AND json_extract(j.value,'$.downloads') >= h.downloads
          AND ${ATTENTION_MONOTONIC}))`)
    .bind(body.seq, body.milliseconds, body.downloads, lastSeen, body.active && now / 1000 - lastSeen <= 315 ? 1 : 0,
      body.id, visitor, body.seq, body.milliseconds, body.downloads, JSON.stringify(body.hours))];
  // Replayed/out-of-order check-ins cannot add time or download actions twice.
  statements.push(db.prepare(`INSERT INTO reading_hours(session_id, hour, milliseconds, downloads, attention)
    SELECT s.id, json_extract(j.value, '$.hour'), json_extract(j.value, '$.milliseconds'), json_extract(j.value, '$.downloads'), json_extract(j.value, '$.attention')
    FROM reading_sessions s, json_each(?) j WHERE s.id = ? AND s.visitor_hash = ? AND s.seq = ? AND changes() = 1
    ON CONFLICT(session_id, hour) DO UPDATE SET milliseconds = MAX(milliseconds, excluded.milliseconds), downloads = MAX(downloads, excluded.downloads), attention = excluded.attention
    WHERE excluded.milliseconds > milliseconds OR excluded.downloads > downloads OR attention IS NOT excluded.attention`)
    .bind(JSON.stringify(body.hours), body.id, visitor, body.seq));
  await db.batch(statements);
  return 204;
}

export async function readingItems(db, dates, excludePersonal, path = "") {
  const response = await db.prepare(`SELECT s.path AS name, SUM(h.milliseconds) / 1000.0 AS readingSeconds,
      SUM(h.downloads) AS downloads, COUNT(DISTINCT s.id) AS measuredViews
    FROM reading_hours h JOIN reading_sessions s ON s.id = h.session_id
    WHERE h.hour >= ? AND h.hour < ? ${excludePersonal ? `AND NOT ${PERSONAL}` : ""} ${path ? "AND s.path = ?" : ""}
    GROUP BY s.path`).bind(dates.from, dates.until, ...(path ? [path] : [])).all();
  return { rows: response.results, measured: ["readingItems", response] };
}

export function addReadingItems(items, rows) {
  const data = new Map(rows.map(row => [row.name, row]));
  const merged = items.map(item => {
    const row = item.section === "main" && data.get(item.name);
    if (row) data.delete(item.name);
    return row ? { ...item, ...row } : item;
  });
  // A session can continue into a day that has no new page/PDF open.
  for (const row of data.values()) merged.push({ section: "main", count: 0, visitors: 0,
    identifiedRequests: 0, unidentifiedRequests: 0, ...row });
  return merged;
}

export async function userReading(db, dates, excludePersonal, labels) {
  if (!labels.length) return { rows: [], measured: null };
  const response = await db.prepare(`WITH sessions AS (
      SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.visitor_hash ORDER BY s.last_seen DESC, s.id) AS recent
      FROM reading_sessions s WHERE substr(s.visitor_hash,1,24) IN (${labels.map(() => "?").join(",")})
        AND s.started_at < ? ${excludePersonal ? `AND NOT ${PERSONAL}` : ""}
    ) SELECT substr(s.visitor_hash,1,24) AS id,
      SUM(CASE WHEN s.kind = 'pdf_request' THEN COALESCE(h.milliseconds,0) ELSE 0 END) / 1000.0 AS readingSeconds,
      SUM(CASE WHEN s.kind = 'page_view' THEN COALESCE(h.milliseconds,0) ELSE 0 END) / 1000.0 AS homepageSeconds,
      SUM(COALESCE(h.downloads,0)) AS downloads, COUNT(DISTINCT CASE WHEN h.session_id IS NOT NULL THEN s.id END) AS measuredViews,
      COUNT(DISTINCT CASE WHEN h.session_id IS NOT NULL AND s.kind = 'pdf_request' THEN s.id END) AS measuredPdfViews,
      COUNT(DISTINCT CASE WHEN s.kind = 'pdf_request' AND (s.started_at >= ? OR h.session_id IS NOT NULL) THEN s.id END) AS pdfViewerSessions,
      COUNT(DISTINCT CASE WHEN h.session_id IS NOT NULL AND s.kind = 'page_view' THEN s.id END) AS measuredHomepageViews,
      MAX(CASE WHEN s.active = 1 AND s.last_seen >= ? AND s.last_seen < ? THEN s.last_seen ELSE 0 END) AS liveAt,
      MAX(CASE WHEN s.recent = 1 THEN s.last_seen END) AS lastReadingAt,
      MAX(CASE WHEN s.recent = 1 THEN s.path END) AS lastReadingPath
    FROM sessions s LEFT JOIN reading_hours h ON h.session_id = s.id AND h.hour >= ? AND h.hour < ?
    GROUP BY substr(s.visitor_hash,1,24)`)
    .bind(...labels, dates.until, dates.from, dates.from, dates.until, dates.from, dates.until).all();
  return { rows: response.results, measured: ["userReading", response] };
}

export async function historyReading(db, dates, excludePersonal, ids) {
  const rows = [], measured = [];
  // D1 allows at most 100 bound parameters per statement.
  for (let offset = 0; offset < ids.length; offset += 90) {
    const batch = ids.slice(offset, offset + 90);
    const response = await db.prepare(`SELECT s.id,
    CASE WHEN COUNT(h.session_id) > 0 THEN 'tracked' WHEN s.seq < 0 THEN 'no_updates' ELSE 'outside_period' END AS readingStatus,
    SUM(h.milliseconds) / 1000.0 AS readingSeconds, SUM(h.downloads) AS downloads,
    json_group_array(json(h.attention)) AS attentionHours FROM reading_sessions s
    LEFT JOIN reading_hours h ON h.session_id = s.id AND h.hour >= ? AND h.hour < ?
    WHERE s.id IN (${batch.map(() => "?").join(",")}) ${excludePersonal ? `AND NOT ${PERSONAL}` : ""} GROUP BY s.id`)
      .bind(dates.from, dates.until, ...batch).all();
    rows.push(...response.results.map(({ readingSeconds, downloads, attentionHours, ...row }) => {
      const homepageAttention = summarizeAttention(JSON.parse(attentionHours));
      return { ...row, ...(readingSeconds === null ? {} : { readingSeconds, downloads }), ...(homepageAttention ? { homepageAttention } : {}) };
    }));
    measured.push(["historyReading", response]);
  }
  return { rows, measured };
}
