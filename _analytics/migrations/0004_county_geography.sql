-- Prospective IP-derived county estimates. Historic locations remain unknown.
ALTER TABLE events ADD COLUMN county TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN county_fips TEXT NOT NULL DEFAULT '';
