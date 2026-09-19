CREATE INDEX reading_pdf_path ON reading_sessions(path, id) WHERE kind = 'pdf_request';
