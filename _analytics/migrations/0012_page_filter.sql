-- Page-scoped reports and live cohorts avoid scanning unrelated history.
CREATE INDEX events_page_time ON events(CASE WHEN path IN ('/index','/index.html') THEN '/' ELSE path END, occurred_at);
CREATE INDEX reading_live ON reading_sessions(last_seen, visitor_hash) WHERE active = 1;
