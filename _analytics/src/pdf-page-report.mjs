export async function pdfPageReport(db, dates, path, excludePersonal) {
  const response = await db.prepare(`WITH timed AS MATERIALIZED (
    SELECT s.id,h.pdf_attention AS attention FROM reading_sessions s
    JOIN reading_hours h ON h.session_id = s.id AND h.hour >= ?1 AND h.hour < ?2
    WHERE s.path = ?3 AND s.kind = 'pdf_request' AND h.pdf_attention IS NOT NULL
      ${excludePersonal ? "AND s.is_personal = 0 AND s.visitor_hash NOT IN (SELECT visitor_hash FROM personal_visitors)" : ""}
  ), per_session AS (
    SELECT t.id, CAST(p.key AS INTEGER) + 1 AS page, SUM(p.value) AS seconds
    FROM timed t,json_each(t.attention,'$.seconds') p
    WHERE json_type(t.attention,'$.seconds') = 'array'
      AND (json_extract(t.attention,'$.pages[' || (CAST(p.key AS INTEGER) >> 5) || ']') & (1 << (CAST(p.key AS INTEGER) % 32))) != 0
    GROUP BY t.id,p.key
  ), totals AS (
    SELECT COALESCE(MAX(json_extract(attention,'$.total')),0) AS totalPages,
      COUNT(DISTINCT CASE WHEN json_type(attention,'$.seconds') = 'array' THEN id END) AS measuredSessions FROM timed
  ), pages AS (
    SELECT page, COUNT(*) AS sessions, SUM(seconds) AS totalSeconds, AVG(seconds) AS averageSeconds
    FROM per_session GROUP BY page
  ) SELECT totals.*,pages.* FROM totals LEFT JOIN pages ON 1=1 ORDER BY page`)
    .bind(dates.from, dates.until, path).all();
  const { totalPages = 0, measuredSessions = 0 } = response.results[0] || {};
  const pages = new Map(response.results.filter(r => r.page !== null).map(({ page, sessions, totalSeconds, averageSeconds }) => [page, { page, sessions, totalSeconds, averageSeconds }]));
  return { totalPages, measuredSessions, pdfPages: Array.from({ length: totalPages }, (_, i) => pages.get(i + 1)
    || { page: i + 1, sessions: 0, totalSeconds: 0, averageSeconds: null }), measured: ["pdfPages", response] };
}
