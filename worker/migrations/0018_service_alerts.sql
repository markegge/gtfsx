-- GTFS-Realtime Service Alerts authoring.
--
-- Alerts are PROJECT-scoped and DECOUPLED from the schedule snapshot/publish
-- cycle: an editor posts or expires an alert without republishing the GTFS
-- schedule. Each alert is its own row (not a gzipped R2 blob) so we can do
-- per-alert CRUD and active_period filtering, and render the GTFS-RT protobuf
-- on demand from the rows at request time. See docs/ARCHITECTURE.md (BE-90..92).

CREATE TABLE service_alert (
  id                 TEXT PRIMARY KEY,                       -- ULID
  project_id         TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,

  cause              TEXT NOT NULL DEFAULT 'UNKNOWN_CAUSE',
  effect             TEXT NOT NULL DEFAULT 'UNKNOWN_EFFECT',
  severity_level     TEXT NOT NULL DEFAULT 'UNKNOWN_SEVERITY',
  header_text        TEXT NOT NULL,                          -- default-language string (v1)
  description_text   TEXT,
  url                TEXT,

  -- active periods + informed entities as JSON arrays (small, read whole):
  active_periods     TEXT NOT NULL DEFAULT '[]',             -- [{start:epochSec, end:epochSec|null}, ...]
  informed_entities  TEXT NOT NULL DEFAULT '[]',             -- [{agency_id?,route_id?,route_type?,direction_id?,trip_id?,stop_id?}, ...]

  status             TEXT NOT NULL DEFAULT 'draft',          -- 'draft' | 'active'
  created_by_user_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX service_alert_project_idx ON service_alert (project_id, status);

-- RT coexistence (Option A): when an agency authors alerts we auto-wire a
-- project_rt_feed row (kind='alerts') pointing at our served alerts.pb so the
-- existing feed_info.json forwarding advertises it. That managed row must NOT
-- behave like an externally-hosted RT feed: it is excluded from the publish-time
-- ID-stability warning (it self-renders, so it can't "break" on republish) and
-- from the external-feed editor's bulk replace. `managed=1` marks it; existing
-- external rows keep the default 0.
ALTER TABLE project_rt_feed ADD COLUMN managed INTEGER NOT NULL DEFAULT 0;
