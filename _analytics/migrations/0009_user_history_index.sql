-- Match the private profile's public label and time range without scanning other users.
CREATE INDEX events_user_history ON events(substr(visitor_hash, 1, 24), occurred_at)
WHERE bot = 0 AND duplicate_of = '' AND visitor_hash != ''
  AND kind IN ('page_view', 'pdf_request', 'outbound_click');
