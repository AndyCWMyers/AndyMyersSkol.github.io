-- Separate from the retired Cloudflare bot_score field and event-count triggers.
ALTER TABLE reading_sessions ADD COLUMN recaptcha_score REAL CHECK(recaptcha_score BETWEEN 0 AND 1);
ALTER TABLE reading_sessions ADD COLUMN recaptcha_at INTEGER;
ALTER TABLE reading_sessions ADD COLUMN recaptcha_status TEXT NOT NULL DEFAULT 'unassessed';
