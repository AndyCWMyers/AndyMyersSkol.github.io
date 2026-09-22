-- Startup diagnostics remain separate from confirmed views and reading sessions.
ALTER TABLE pdf_diagnostics ADD COLUMN recaptcha_score REAL;
ALTER TABLE pdf_diagnostics ADD COLUMN recaptcha_at INTEGER;
ALTER TABLE pdf_diagnostics ADD COLUMN recaptcha_status TEXT NOT NULL DEFAULT 'unassessed';
ALTER TABLE pdf_diagnostics ADD COLUMN error_detail TEXT NOT NULL DEFAULT '';
