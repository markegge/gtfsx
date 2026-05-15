-- Phase 10: forum image uploads (R2-backed).
--
-- Track every upload so we can enforce per-user quotas, expose a deletion
-- flow, and run abuse audits. R2 is the blob store; this table is the
-- index. Soft-delete (deleted_at) keeps a record even after the object is
-- purged.

CREATE TABLE forum_image (
  id              TEXT PRIMARY KEY,           -- ULID; also the basename of the R2 key
  user_id         TEXT NOT NULL REFERENCES user(id),
  r2_key          TEXT NOT NULL UNIQUE,       -- e.g. images/<userId>/<ulid>.png
  content_type    TEXT NOT NULL,              -- 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  bytes           INTEGER NOT NULL,
  width           INTEGER,                    -- decoded dimensions (nullable for legacy rows)
  height          INTEGER,
  sha256          TEXT,                       -- hex; for dedupe + abuse-list lookups
  source_post_id  TEXT,                       -- optional; populated when used in a post
  created_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE INDEX forum_image_user_idx ON forum_image (user_id, created_at DESC);
CREATE INDEX forum_image_sha_idx ON forum_image (sha256) WHERE sha256 IS NOT NULL;
