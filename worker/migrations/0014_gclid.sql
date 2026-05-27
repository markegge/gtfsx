-- Capture Google Ads click identifier for attribution reconciliation.
-- Mirrors the existing `ref` field: per-session, captured once on inbound
-- URL, forwarded with every event. Server-side reconciliation against
-- Google Ads click reports happens manually weekly; Phase 2 will add
-- nightly Offline Conversion Import push.
--
-- No PII — gclid is an opaque Google identifier, not a user id.

ALTER TABLE event ADD COLUMN gclid TEXT;

-- We expect "gclid IS NOT NULL" queries grouped by kind+ts in the
-- reconciliation view. Partial index keeps the index small (most events
-- won't have a gclid; only the small fraction from ad clicks).
CREATE INDEX event_gclid_ts_idx ON event (ts) WHERE gclid IS NOT NULL;
