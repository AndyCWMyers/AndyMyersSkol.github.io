-- Nullable for historical events; no backfill or additional event rows.
ALTER TABLE events ADD COLUMN inbound_details TEXT;
