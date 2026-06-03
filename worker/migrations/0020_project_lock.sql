-- Lockable feeds (issue #36). A locked feed is protected from accidental
-- edit/delete: Rename + Delete are refused, the working-state save endpoint
-- refuses writes (returns 409), and the editor opens it as a detached draft
-- (Save becomes Save As). Locking is purely a guard rail — it does not change
-- ownership or visibility.
--
-- locked : 0 = normal (default), 1 = locked. Same permission that can already
--   delete/rename the project may toggle the lock (org admin+ or the personal
--   owner) — enforced in worker/projects/routes.ts.

ALTER TABLE feed_project ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- Reversible: ALTER TABLE feed_project DROP COLUMN locked;
