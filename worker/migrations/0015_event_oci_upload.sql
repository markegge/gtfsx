-- Track which `event` rows have been pushed to Google Ads via the Offline
-- Conversion Import (OCI) API, so we never double-count a conversion and
-- can retry transient failures.
--
-- See worker/marketing/ads/oci.ts (the daily uploader) and
-- docs/GOOGLE_ADS_PLAN.md §3.2.
--
--   oci_uploaded_at   NULL  = never tried / still pending
--                     > 0   = unix ms of the successful POST  (idempotency)
--                     -1    = permanently failed after 3 attempts (do not retry)
--   oci_attempts      number of upload attempts so far (incremented on failure)
--   oci_last_error    last per-row error returned by Google Ads (for debugging)

ALTER TABLE event ADD COLUMN oci_uploaded_at INTEGER;
ALTER TABLE event ADD COLUMN oci_attempts INTEGER DEFAULT 0;
ALTER TABLE event ADD COLUMN oci_last_error TEXT;

-- The cron query is:
--   WHERE gclid IS NOT NULL
--     AND oci_uploaded_at IS NULL
--     AND kind IN ('feed_exported', 'paywall_view')
--     AND ts > (now - 90 days)
-- Partial index keeps the table small — only pending ad-stamped rows match.
CREATE INDEX event_oci_pending_idx
  ON event (kind, ts)
  WHERE gclid IS NOT NULL AND oci_uploaded_at IS NULL;
