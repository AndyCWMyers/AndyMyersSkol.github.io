-- Preserve raw requests while excluding repeated retrievals from counted activity.
ALTER TABLE events ADD COLUMN duplicate_of TEXT NOT NULL DEFAULT '';
CREATE INDEX events_pdf_retrieval ON events(visitor_hash, path, occurred_at)
  WHERE kind = 'pdf_request' AND duplicate_of = '';

-- Historical correction is deliberately narrow: a 304 immediately following a
-- matching 200 in the same second. Unknown visitors are never merged by IP.
UPDATE events AS duplicate SET duplicate_of = COALESCE((
  SELECT original.id FROM events AS original
  WHERE original.kind = 'pdf_request' AND original.status = 200
    AND original.visitor_hash = duplicate.visitor_hash AND original.path = duplicate.path
    AND original.occurred_at = duplicate.occurred_at AND original.rowid < duplicate.rowid
    AND original.referrer = duplicate.referrer AND original.referrer_status = duplicate.referrer_status
    AND original.source = duplicate.source AND original.medium = duplicate.medium AND original.campaign = duplicate.campaign
    AND original.browser = duplicate.browser AND original.device = duplicate.device AND original.bot = duplicate.bot
    AND original.country = duplicate.country AND original.region = duplicate.region AND original.city = duplicate.city
    AND original.county_fips = duplicate.county_fips AND original.ip_address = duplicate.ip_address
    AND original.is_personal = duplicate.is_personal
  ORDER BY original.rowid LIMIT 1
), '')
WHERE duplicate.kind = 'pdf_request' AND duplicate.status = 304 AND duplicate.visitor_hash != '';
