-- WITHOUT ROWID secondary indexes contain the remaining primary-key columns.
-- Including requests makes this a covering lookup for every aggregate field.
-- Queries can skip raw page requests and bots without visiting table rows.
CREATE INDEX analytics_activity_kind_time
  ON analytics_activity_hours(kind, occurred_at, requests) WHERE bot = 0;

-- Only counted, identified activity contributes to user lists/live fallback.
-- Narrow counters can skip page_request, bots, duplicates and unknown visitors.
CREATE INDEX events_activity_time
  ON events(occurred_at, visitor_hash, kind, is_personal, id, bot, duplicate_of)
  WHERE bot = 0 AND duplicate_of = '' AND visitor_hash != ''
    AND kind IN ('page_view', 'pdf_request', 'outbound_click');
