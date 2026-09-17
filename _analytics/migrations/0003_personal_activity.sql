ALTER TABLE events ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0 CHECK(is_personal IN (0, 1));
CREATE TABLE IF NOT EXISTS personal_visitors (
  visitor_hash TEXT PRIMARY KEY CHECK(length(visitor_hash) = 64)
);
