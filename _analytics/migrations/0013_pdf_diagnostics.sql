-- Diagnostics never enter event counts, reading totals, or GA4.
CREATE TABLE pdf_diagnostics (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  visitor_hash TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  route TEXT NOT NULL,
  reason TEXT NOT NULL,
  status INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  accept_header TEXT NOT NULL DEFAULT '',
  fetch_dest TEXT NOT NULL DEFAULT '',
  fetch_mode TEXT NOT NULL DEFAULT '',
  range_header TEXT NOT NULL DEFAULT '',
  is_personal INTEGER NOT NULL DEFAULT 0,
  bot INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT 0,
  rendered_at INTEGER NOT NULL DEFAULT 0,
  error_code TEXT NOT NULL DEFAULT '',
  error_status INTEGER NOT NULL DEFAULT 0,
  error_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pdf_diagnostics_time ON pdf_diagnostics(occurred_at DESC);
CREATE INDEX pdf_diagnostics_user_time ON pdf_diagnostics(substr(visitor_hash,1,24), occurred_at DESC);
