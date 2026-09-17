-- Client engagement is separate from retrieval logs and never creates views.
-- Keep personal sessions; the personal_visitors registry is applied at read time.
CREATE TABLE reading_sessions (
  id TEXT PRIMARY KEY,
  visitor_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('page_view','pdf_request')),
  is_personal INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT -1,
  milliseconds INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX reading_session_user ON reading_sessions(substr(visitor_hash,1,24));
CREATE TABLE reading_hours (
  session_id TEXT NOT NULL REFERENCES reading_sessions(id),
  hour INTEGER NOT NULL,
  milliseconds INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, hour)
) WITHOUT ROWID;
CREATE INDEX reading_hours_time ON reading_hours(hour);
