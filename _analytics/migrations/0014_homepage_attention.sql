-- Unindexed, bounded hourly summaries reuse the existing reading checkpoint write.
-- NULL means not collected, not zero attention.
ALTER TABLE reading_hours ADD COLUMN attention TEXT;
