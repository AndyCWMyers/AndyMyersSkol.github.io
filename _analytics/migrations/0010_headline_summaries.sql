-- Raw events remain the source of truth. Each counted event updates compact
-- counters atomically; duplicate PDF retrievals do not contribute.
CREATE TABLE analytics_hour_totals (
  hour INTEGER NOT NULL,
  kind TEXT NOT NULL,
  bot INTEGER NOT NULL,
  is_personal INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK(requests >= 0),
  identified_requests INTEGER NOT NULL CHECK(identified_requests >= 0 AND identified_requests <= requests),
  PRIMARY KEY(hour, kind, bot, is_personal)
) WITHOUT ROWID;

CREATE TABLE analytics_hour_visitors (
  hour INTEGER NOT NULL,
  kind TEXT NOT NULL,
  bot INTEGER NOT NULL,
  is_personal INTEGER NOT NULL,
  visitor_hash TEXT NOT NULL CHECK(visitor_hash != ''),
  requests INTEGER NOT NULL CHECK(requests >= 0),
  PRIMARY KEY(hour, kind, bot, is_personal, visitor_hash)
) WITHOUT ROWID;

CREATE TRIGGER analytics_summary_insert AFTER INSERT ON events
WHEN NEW.duplicate_of = ''
BEGIN
  INSERT INTO analytics_hour_totals VALUES (
    NEW.occurred_at - NEW.occurred_at % 3600, NEW.kind, NEW.bot, NEW.is_personal, 1, NEW.visitor_hash != ''
  ) ON CONFLICT(hour, kind, bot, is_personal) DO UPDATE SET
    requests = requests + 1, identified_requests = identified_requests + excluded.identified_requests;
  INSERT INTO analytics_hour_visitors
    SELECT NEW.occurred_at - NEW.occurred_at % 3600, NEW.kind, NEW.bot, NEW.is_personal, NEW.visitor_hash, 1
    WHERE NEW.visitor_hash != ''
    ON CONFLICT(hour, kind, bot, is_personal, visitor_hash) DO UPDATE SET requests = requests + 1;
END;

CREATE TRIGGER analytics_summary_delete AFTER DELETE ON events
WHEN OLD.duplicate_of = ''
BEGIN
  UPDATE analytics_hour_totals SET requests = requests - 1,
    identified_requests = identified_requests - (OLD.visitor_hash != '')
    WHERE hour = OLD.occurred_at - OLD.occurred_at % 3600 AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal;
  DELETE FROM analytics_hour_totals WHERE hour = OLD.occurred_at - OLD.occurred_at % 3600
    AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal AND requests = 0;
  UPDATE analytics_hour_visitors SET requests = requests - 1
    WHERE hour = OLD.occurred_at - OLD.occurred_at % 3600 AND kind = OLD.kind AND bot = OLD.bot
      AND is_personal = OLD.is_personal AND visitor_hash = OLD.visitor_hash;
  DELETE FROM analytics_hour_visitors WHERE hour = OLD.occurred_at - OLD.occurred_at % 3600
    AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal AND visitor_hash = OLD.visitor_hash AND requests = 0;
END;

-- Corrections to an event remove its old contribution before adding its new one.
CREATE TRIGGER analytics_summary_update AFTER UPDATE OF occurred_at, kind, bot, is_personal, visitor_hash, duplicate_of ON events
BEGIN
  UPDATE analytics_hour_totals SET requests = requests - 1,
    identified_requests = identified_requests - (OLD.visitor_hash != '')
    WHERE OLD.duplicate_of = '' AND hour = OLD.occurred_at - OLD.occurred_at % 3600
      AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal;
  DELETE FROM analytics_hour_totals WHERE OLD.duplicate_of = '' AND hour = OLD.occurred_at - OLD.occurred_at % 3600
    AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal AND requests = 0;
  UPDATE analytics_hour_visitors SET requests = requests - 1
    WHERE OLD.duplicate_of = '' AND hour = OLD.occurred_at - OLD.occurred_at % 3600 AND kind = OLD.kind AND bot = OLD.bot
      AND is_personal = OLD.is_personal AND visitor_hash = OLD.visitor_hash;
  DELETE FROM analytics_hour_visitors WHERE OLD.duplicate_of = '' AND hour = OLD.occurred_at - OLD.occurred_at % 3600
    AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal AND visitor_hash = OLD.visitor_hash AND requests = 0;
  INSERT INTO analytics_hour_totals
    SELECT NEW.occurred_at - NEW.occurred_at % 3600, NEW.kind, NEW.bot, NEW.is_personal, 1, NEW.visitor_hash != ''
    WHERE NEW.duplicate_of = ''
    ON CONFLICT(hour, kind, bot, is_personal) DO UPDATE SET
      requests = requests + 1, identified_requests = identified_requests + excluded.identified_requests;
  INSERT INTO analytics_hour_visitors
    SELECT NEW.occurred_at - NEW.occurred_at % 3600, NEW.kind, NEW.bot, NEW.is_personal, NEW.visitor_hash, 1
    WHERE NEW.duplicate_of = '' AND NEW.visitor_hash != ''
    ON CONFLICT(hour, kind, bot, is_personal, visitor_hash) DO UPDATE SET requests = requests + 1;
END;

-- Install triggers first. Backfill replaces bucket counts from a consistent
-- snapshot, rather than adding to any counts already captured by the triggers.
INSERT INTO analytics_hour_totals
  SELECT occurred_at - occurred_at % 3600, kind, bot, is_personal, COUNT(*), COUNT(NULLIF(visitor_hash, ''))
  FROM events WHERE duplicate_of = '' GROUP BY occurred_at - occurred_at % 3600, kind, bot, is_personal
  ON CONFLICT(hour, kind, bot, is_personal) DO UPDATE SET
    requests = excluded.requests, identified_requests = excluded.identified_requests;
INSERT INTO analytics_hour_visitors
  SELECT occurred_at - occurred_at % 3600, kind, bot, is_personal, visitor_hash, COUNT(*)
  FROM events WHERE duplicate_of = '' AND visitor_hash != ''
  GROUP BY occurred_at - occurred_at % 3600, kind, bot, is_personal, visitor_hash
  ON CONFLICT(hour, kind, bot, is_personal, visitor_hash) DO UPDATE SET requests = excluded.requests;
