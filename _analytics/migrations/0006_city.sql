-- Prospective edge-reported city; never infer missing historical cities.
ALTER TABLE events ADD COLUMN city TEXT NOT NULL DEFAULT '';
