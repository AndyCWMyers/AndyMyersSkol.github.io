ALTER TABLE events ADD COLUMN referrer_status TEXT NOT NULL DEFAULT 'unknown';

-- Earlier browser events captured the collector's referrer, not the landing source.
-- Preserve those events without treating them as measured inbound sources.
UPDATE events SET referrer_status = 'known'
WHERE kind IN ('page_request', 'pdf_request') AND referrer != '';
