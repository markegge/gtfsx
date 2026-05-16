-- 0012: rename feed_version → feed_snapshot.
--
-- Why: GTFS spec already has its own `feed_version` field in feed_info.txt,
-- so calling our point-in-time saves "versions" creates terminology
-- collision. "Snapshots" is unambiguous and matches the editor's mental
-- model. Done now while the project has only 4 grandfathered Free users
-- and no published feeds — no users in the world yet to migrate.
--
-- SQLite ALTER TABLE ... RENAME TO automatically updates FOREIGN KEY
-- references in other tables' CREATE TABLE statements (when the rename
-- happens at the schema level). Column renames need explicit
-- ALTER TABLE ... RENAME COLUMN.

-- Rename the table.
ALTER TABLE feed_version RENAME TO feed_snapshot;

-- Rename the FK columns on referencing tables.
ALTER TABLE draft_link          RENAME COLUMN version_id TO snapshot_id;
ALTER TABLE publication         RENAME COLUMN version_id TO snapshot_id;
ALTER TABLE publication_history RENAME COLUMN version_id TO snapshot_id;

-- The original index `feed_version_project_idx` was bound to the old name
-- and follows the rename automatically in SQLite — but we drop and
-- recreate so the index name reflects the new table name in pragma listings.
DROP INDEX IF EXISTS feed_version_project_idx;
CREATE INDEX IF NOT EXISTS feed_snapshot_project_idx
  ON feed_snapshot (project_id, created_at DESC);
