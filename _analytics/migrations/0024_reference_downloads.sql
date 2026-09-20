-- Download-only measurements share the indexed engagement tables, not viewer time.
ALTER TABLE reading_sessions ADD COLUMN measurement_source TEXT NOT NULL DEFAULT 'viewer'
  CHECK (measurement_source IN ('viewer', 'reference_manager'));
