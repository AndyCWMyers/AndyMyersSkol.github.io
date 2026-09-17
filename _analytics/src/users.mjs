// Labels are truncated random-cookie hashes, never cookie values or identities.
// Called only after the report endpoint's bearer, date and personal-filter checks.
export async function userReport(db, url, dates, where, personal, excludePersonal) {
  const user = url.searchParams.get("user") || "";
  const offsetText = url.searchParams.get("offset") || "0";
  if ((user && !/^[a-f0-9]{24}$/.test(user)) || !/^\d{1,7}$/.test(offsetText)) return { error: "Invalid user or offset" };
  const offset = Number(offsetText), limit = 100;
  const base = `FROM events WHERE ${where} AND bot = 0 AND visitor_hash != '' AND kind IN ('page_view', 'pdf_request', 'outbound_click')`;
  let rows;
  if (user) {
    rows = await db.prepare(`SELECT occurred_at AS time, kind,
      CASE WHEN path IN ('/index.html', '/index') THEN '/' ELSE path END AS path,
      target, country, region, browser, device,
      CASE WHEN referrer_status = 'known' THEN referrer WHEN referrer_status = 'direct' THEN '__direct__' ELSE '__unknown__' END AS referrer,
      source, medium, campaign, ${personal} AS personal
      ${base} AND substr(visitor_hash, 1, 24) = ? ORDER BY occurred_at, rowid LIMIT ? OFFSET ?`)
      .bind(dates.from, dates.until, user, limit + 1, offset).all();
  } else {
    rows = await db.prepare(`WITH activity AS (
      SELECT *, ${personal} AS personal, ROW_NUMBER() OVER (PARTITION BY visitor_hash ORDER BY occurred_at DESC, rowid DESC) AS recent ${base}
    ) SELECT substr(visitor_hash, 1, 24) AS id, COUNT(*) AS events,
      SUM(kind != 'outbound_click') AS views, SUM(kind = 'outbound_click') AS clicks,
      MIN(occurred_at) AS firstSeen, MAX(occurred_at) AS lastSeen, MAX(personal) AS personal,
      MAX(CASE WHEN recent = 1 THEN country END) AS country, MAX(CASE WHEN recent = 1 THEN region END) AS region,
      MAX(CASE WHEN recent = 1 THEN browser END) AS browser, MAX(CASE WHEN recent = 1 THEN device END) AS device
      FROM activity GROUP BY visitor_hash ORDER BY lastSeen DESC, id LIMIT ? OFFSET ?`)
      .bind(dates.from, dates.until, limit + 1, offset).all();
  }
  return { start: dates.start, end: dates.end, excludePersonal, user, offset,
    rows: rows.results.slice(0, limit), nextOffset: rows.results.length > limit ? offset + limit : null };
}
