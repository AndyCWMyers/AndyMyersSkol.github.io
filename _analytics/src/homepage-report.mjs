import { HOMEPAGE_ITEMS } from "./homepage-attention.mjs";

export async function homepageReport(db, dates, excludePersonal) {
  const response = await db.prepare(`WITH timed AS MATERIALIZED (
    SELECT s.id,h.attention FROM reading_sessions s
    JOIN reading_hours h ON h.session_id = s.id AND h.hour >= ?1 AND h.hour < ?2
    WHERE s.path = '/' AND s.kind = 'page_view' AND h.attention IS NOT NULL
      ${excludePersonal ? "AND s.is_personal = 0 AND s.visitor_hash NOT IN (SELECT visitor_hash FROM personal_visitors)" : ""}
  ), per_session AS (
    SELECT t.id,json_extract(i.value,'$[0]') AS item,
      SUM(json_extract(i.value,'$[1]')) / 1000.0 AS seconds
    FROM timed t,json_each(t.attention,'$.items') i GROUP BY t.id,item
  ), totals AS (
    SELECT COUNT(DISTINCT id) AS measuredSessions FROM timed
  ), entries AS (
    SELECT item,COUNT(*) AS sessions,SUM(seconds) AS totalSeconds,AVG(seconds) AS averageSeconds
    FROM per_session GROUP BY item
  ) SELECT totals.*,entries.* FROM totals LEFT JOIN entries ON 1=1 ORDER BY item`)
    .bind(dates.from, dates.until).all();
  const rows = new Map(response.results.filter(row => row.item !== null).map(row => [row.item, row]));
  return { measuredSessions: response.results[0]?.measuredSessions || 0,
    homepageItems: HOMEPAGE_ITEMS.map(item => {
      const row = rows.get(item.id);
      return { ...item, sessions: row?.sessions || 0, totalSeconds: row?.totalSeconds || 0, averageSeconds: row?.averageSeconds ?? null };
    }), measured: ["homepageItems", response] };
}
