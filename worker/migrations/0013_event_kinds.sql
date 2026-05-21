-- Extend the cookieless analytics `event` table beyond page views.
--
-- The marketing funnel needs three more signals alongside page views:
--   editor_loaded  — an editor/session actually opened (vs. a marketing-page
--                    visit that bounced); distinct session_ids = editor sessions
--   feed_exported  — a valid GTFS zip was downloaded (the "value delivered" proxy)
--   paywall_view   — a Pro/Team paywall was shown (the intent signal)
--
-- `label` is an optional sub-type — e.g. the feature key behind a paywall
-- (`managed_publishing`, `analysis_title_vi`, …). Still no PII: no IP, no UA,
-- no user id. The kind+ts index backs the per-kind aggregation in
-- /admin/events/summary.

ALTER TABLE event ADD COLUMN label TEXT;  -- optional sub-type (e.g. paywall feature key)

CREATE INDEX event_kind_ts_idx ON event (kind, ts);
