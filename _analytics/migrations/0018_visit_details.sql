ALTER TABLE events ADD COLUMN network_asn INTEGER;
ALTER TABLE events ADD COLUMN network_org TEXT;
ALTER TABLE reading_sessions ADD COLUMN client_details TEXT;
ALTER TABLE reading_hours ADD COLUMN interactions TEXT;
