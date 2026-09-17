-- Owner-requested prospective retention, private D1 only. No historic backfill.
ALTER TABLE events ADD COLUMN ip_address TEXT NOT NULL DEFAULT '';
