-- 0030: capture gbraid / wbraid alongside gclid.
--
-- gbraid and wbraid are Google Ads' privacy-preserving click identifiers, used
-- when a plain gclid isn't available: gbraid on iOS app→web journeys, wbraid on
-- web→web under consent/ATT limits. An increasing share of ad clicks (notably
-- iOS) arrive with ONLY a braid, so capturing just `?gclid=` (migration 0014)
-- silently drops them — that is exactly why demo_request never had anything to
-- upload. Same treatment as gclid: per-session, captured once on the inbound
-- URL, forwarded with every event, uploaded as an offline conversion. The
-- Google Ads Data Manager API accepts gclid OR gbraid OR wbraid.
--
-- Additive; forward-only. (SQLite ADD COLUMN has no IF NOT EXISTS — the
-- migration runner only applies each file once, same as 0014_gclid.)

ALTER TABLE event ADD COLUMN gbraid TEXT;
ALTER TABLE event ADD COLUMN wbraid TEXT;

-- Mirror the gclid partial index (0014) so the OCI uploader can cheaply find
-- rows that carry ONLY a braid identifier.
CREATE INDEX IF NOT EXISTS event_gbraid_ts_idx ON event (ts) WHERE gbraid IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_wbraid_ts_idx ON event (ts) WHERE wbraid IS NOT NULL;

-- Lead records carry them too, for attribution parity with gclid.
ALTER TABLE demo_leads ADD COLUMN gbraid TEXT;
ALTER TABLE demo_leads ADD COLUMN wbraid TEXT;
