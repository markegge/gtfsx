-- Phase 3/5/6: publication tracking, distribution catalog submissions,
-- GTFS-Realtime URL coordination.
--
-- Note: publication + publication_history + draft_link were declared in the
-- requirements doc's schema block but didn't get created in 0002 (which
-- stopped at feed_version). 0003 fills the gap plus adds the distribution
-- tables. draft_link IS already in 0002; we skip re-declaring it here.

CREATE TABLE publication (
  project_id            TEXT PRIMARY KEY REFERENCES feed_project(id) ON DELETE CASCADE,
  version_id            TEXT NOT NULL REFERENCES feed_version(id),
  published_by_user_id  TEXT REFERENCES user(id) ON DELETE SET NULL,
  published_at          INTEGER NOT NULL,
  canonical_slug        TEXT NOT NULL,               -- snapshot of feed_project.slug at publish time
  zip_r2_key            TEXT NOT NULL                -- rendered ZIP for this publication
);

CREATE INDEX publication_slug_idx ON publication (canonical_slug);

-- Append-only log so we can "rollback to earlier publication" and show history.
CREATE TABLE publication_history (
  id                TEXT PRIMARY KEY,               -- ULID
  project_id        TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES feed_version(id),
  action            TEXT NOT NULL,                   -- 'publish' | 'unpublish' | 'rollback'
  actor_user_id     TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX publication_history_project_idx ON publication_history (project_id, created_at DESC);

-- One-time opt-in per (project, catalog). On subsequent publishes we update the same entry.
CREATE TABLE project_catalog_submission (
  project_id         TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  catalog            TEXT NOT NULL,                  -- 'mobility_db' | 'transit_land'
  external_feed_id   TEXT,                           -- the id the catalog assigned us
  opted_in_at        INTEGER NOT NULL,
  last_submitted_at  INTEGER,
  status             TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'active' | 'error'
  last_error         TEXT,
  PRIMARY KEY (project_id, catalog)
);

-- External GTFS-Realtime feed URLs the agency already runs. Metadata only —
-- we don't proxy or serve these; we forward them in feed_info.json and surface
-- them in distribution submissions, and we warn at publish time if the
-- about-to-publish version would break RT-referenced IDs (see BE-88).
CREATE TABLE project_rt_feed (
  id           TEXT PRIMARY KEY,                     -- ULID
  project_id   TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,                         -- 'vehicle_positions' | 'trip_updates' | 'alerts'
  url          TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX project_rt_feed_project_idx ON project_rt_feed (project_id);
