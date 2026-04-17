-- Phase 2: feed projects, working-state pointers, versions, draft links.
-- Organizations ship in Phase 4 — we include the `organization` + membership
-- tables here so `feed_project.owner_type` already has the right references,
-- but v1 only creates projects with owner_type='user'.

CREATE TABLE organization (
  id              TEXT PRIMARY KEY,           -- ULID
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE organization_membership (
  org_id          TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,               -- 'owner' | 'admin' | 'editor' | 'viewer'
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_membership_user_idx ON organization_membership (user_id);

-- Feed projects.  Slug is unique within (owner_type, owner_id).
-- Working-state blob lives in R2 at projects/<id>/working-state.json.gz;
-- only the pointer + version token live here.
CREATE TABLE feed_project (
  id                        TEXT PRIMARY KEY,  -- ULID
  slug                      TEXT NOT NULL,
  name                      TEXT NOT NULL,
  description               TEXT,
  owner_type                TEXT NOT NULL,      -- 'user' | 'org'
  owner_id                  TEXT NOT NULL,

  working_state_r2_key      TEXT,               -- R2 object key; null until first save
  working_state_version     INTEGER NOT NULL DEFAULT 0,  -- optimistic-concurrency token; bumped per save
  working_state_size        INTEGER,            -- bytes after gzip
  working_state_updated_at  INTEGER,

  archived_at               INTEGER,
  deleted_at                INTEGER,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);

CREATE UNIQUE INDEX feed_project_slug_idx
  ON feed_project (owner_type, owner_id, slug)
  WHERE deleted_at IS NULL;
CREATE INDEX feed_project_owner_idx ON feed_project (owner_type, owner_id, archived_at, deleted_at);

-- Immutable snapshots. Each version writes TWO R2 objects:
--   state_r2_key   — the JSON store state (gzipped)
--   zip_r2_key     — the rendered GTFS ZIP
-- summary_json holds the per-version summary stats (BE-46).
CREATE TABLE feed_version (
  id                  TEXT PRIMARY KEY,        -- ULID (sortable by creation time)
  project_id          TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  label               TEXT,                     -- user-provided (e.g. 'March 2026 service change')
  created_by_user_id  TEXT REFERENCES user(id) ON DELETE SET NULL,

  state_r2_key        TEXT NOT NULL,
  zip_r2_key          TEXT NOT NULL,
  zip_size            INTEGER NOT NULL,

  summary_json        TEXT NOT NULL,            -- {routes, stops, trips, serviceDays, feedStart, feedEnd, revenueHours, files, ...}
  validation_errors   INTEGER NOT NULL DEFAULT 0,
  validation_warnings INTEGER NOT NULL DEFAULT 0,

  created_at          INTEGER NOT NULL
);

CREATE INDEX feed_version_project_idx ON feed_version (project_id, created_at DESC);

-- Draft URLs for pre-publication review. Token is a random secret; we store
-- its SHA-256 hash and the token goes in the URL only once.
CREATE TABLE draft_link (
  token_hash          TEXT PRIMARY KEY,        -- SHA-256(hex)
  project_id          TEXT NOT NULL REFERENCES feed_project(id) ON DELETE CASCADE,
  version_id          TEXT NOT NULL REFERENCES feed_version(id) ON DELETE CASCADE,
  created_by_user_id  TEXT REFERENCES user(id) ON DELETE SET NULL,
  expires_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  created_at          INTEGER NOT NULL
);

CREATE INDEX draft_link_project_idx ON draft_link (project_id, revoked_at, expires_at);
