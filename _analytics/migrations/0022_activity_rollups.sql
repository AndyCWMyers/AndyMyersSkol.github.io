-- Exact hourly memberships, not summed daily distinct counts. All dimensions
-- used by aggregate reports are retained; raw events remain the source of truth.
-- WITHOUT ROWID lets the hour range read the complete row without table lookups.
CREATE TABLE analytics_activity_hours (
  occurred_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  bot INTEGER NOT NULL,
  is_personal INTEGER NOT NULL,
  visitor_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  target TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT NOT NULL,
  city TEXT NOT NULL,
  county TEXT NOT NULL,
  county_fips TEXT NOT NULL,
  browser TEXT NOT NULL,
  device TEXT NOT NULL,
  os TEXT NOT NULL,
  referrer TEXT NOT NULL,
  referrer_status TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  campaign TEXT NOT NULL,
  requests INTEGER NOT NULL CHECK(requests >= 0),
  PRIMARY KEY(occurred_at, kind, bot, is_personal, visitor_hash, path, target,
    country, region, city, county, county_fips, browser, device, os,
    referrer, referrer_status, source, medium, campaign)
) WITHOUT ROWID;

CREATE TRIGGER analytics_activity_insert AFTER INSERT ON events
WHEN NEW.duplicate_of = ''
BEGIN
  INSERT INTO analytics_activity_hours VALUES (
    NEW.occurred_at - NEW.occurred_at % 3600, NEW.kind, NEW.bot, NEW.is_personal,
    NEW.visitor_hash, NEW.path, NEW.target, NEW.country, NEW.region, NEW.city,
    NEW.county, NEW.county_fips, NEW.browser, NEW.device, NEW.os, NEW.referrer,
    NEW.referrer_status, NEW.source, NEW.medium, NEW.campaign, 1
  ) ON CONFLICT DO UPDATE SET requests = requests + 1;
END;

CREATE TRIGGER analytics_activity_delete AFTER DELETE ON events
WHEN OLD.duplicate_of = ''
BEGIN
  UPDATE analytics_activity_hours SET requests = requests - 1
    WHERE occurred_at = OLD.occurred_at - OLD.occurred_at % 3600
      AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal
      AND visitor_hash = OLD.visitor_hash AND path = OLD.path AND target = OLD.target
      AND country = OLD.country AND region = OLD.region AND city = OLD.city
      AND county = OLD.county AND county_fips = OLD.county_fips
      AND browser = OLD.browser AND device = OLD.device AND os = OLD.os
      AND referrer = OLD.referrer AND referrer_status = OLD.referrer_status
      AND source = OLD.source AND medium = OLD.medium AND campaign = OLD.campaign;
  DELETE FROM analytics_activity_hours
    WHERE occurred_at = OLD.occurred_at - OLD.occurred_at % 3600 AND requests = 0;
END;

CREATE TRIGGER analytics_activity_update AFTER UPDATE OF occurred_at, kind, bot,
  is_personal, visitor_hash, path, target, country, region, city, county, county_fips,
  browser, device, os, referrer, referrer_status, source, medium, campaign, duplicate_of ON events
BEGIN
  UPDATE analytics_activity_hours SET requests = requests - 1
    WHERE OLD.duplicate_of = '' AND occurred_at = OLD.occurred_at - OLD.occurred_at % 3600
      AND kind = OLD.kind AND bot = OLD.bot AND is_personal = OLD.is_personal
      AND visitor_hash = OLD.visitor_hash AND path = OLD.path AND target = OLD.target
      AND country = OLD.country AND region = OLD.region AND city = OLD.city
      AND county = OLD.county AND county_fips = OLD.county_fips
      AND browser = OLD.browser AND device = OLD.device AND os = OLD.os
      AND referrer = OLD.referrer AND referrer_status = OLD.referrer_status
      AND source = OLD.source AND medium = OLD.medium AND campaign = OLD.campaign;
  DELETE FROM analytics_activity_hours
    WHERE occurred_at = OLD.occurred_at - OLD.occurred_at % 3600 AND requests = 0;
  INSERT INTO analytics_activity_hours
    SELECT NEW.occurred_at - NEW.occurred_at % 3600, NEW.kind, NEW.bot, NEW.is_personal,
      NEW.visitor_hash, NEW.path, NEW.target, NEW.country, NEW.region, NEW.city,
      NEW.county, NEW.county_fips, NEW.browser, NEW.device, NEW.os, NEW.referrer,
      NEW.referrer_status, NEW.source, NEW.medium, NEW.campaign, 1
    WHERE NEW.duplicate_of = ''
    ON CONFLICT DO UPDATE SET requests = requests + 1;
END;

-- Replace each bucket from a statement-consistent snapshot. A repeat backfill
-- does not add its events twice, including events received during installation.
INSERT INTO analytics_activity_hours
  SELECT occurred_at - occurred_at % 3600, kind, bot, is_personal, visitor_hash,
    path, target, country, region, city, county, county_fips, browser, device, os,
    referrer, referrer_status, source, medium, campaign, COUNT(*)
  FROM events WHERE duplicate_of = ''
  GROUP BY occurred_at - occurred_at % 3600, kind, bot, is_personal, visitor_hash,
    path, target, country, region, city, county, county_fips, browser, device, os,
    referrer, referrer_status, source, medium, campaign
  ON CONFLICT DO UPDATE SET requests = excluded.requests;
