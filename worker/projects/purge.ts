// Permanent (hard) purge of a single feed project: its R2 blobs plus every D1
// row that references it.
//
// This is the ONE definition of "purge a project". Both reaper paths call it —
// the deleted-USER reaper (a purged account takes its feeds with it) and the
// deleted-PROJECT reaper (trash past its retention window) — so the two cannot
// drift. See worker/cron/tasks.ts.
//
// There is no soft-delete check here on purpose: the caller decides *which*
// projects are eligible (grace window, owner reap, …); this function only knows
// how to erase one completely.

import type { Env } from '../env';
import { deleteProjectBlobs } from './r2';

/**
 * Hard-delete one project. Irreversible — callers must have already decided the
 * project is past saving.
 *
 * D1 ROWS: every table carrying a `project_id` FK declares
 * `REFERENCES feed_project(id) ON DELETE CASCADE`, so the single DELETE below
 * takes all nine with it — verified against the migrations and exercised by
 * cron.reaper.test.ts ("leaves no orphan rows in ANY project_id table"):
 *
 *   feed_snapshot, draft_link              (0002)
 *   publication, publication_history,
 *   project_catalog_submission,
 *   project_rt_feed                        (0003)
 *   service_alert                          (0018)
 *   scheduled_publish                      (0019)
 *   embed_impression                       (0021)
 *
 * Nothing is deleted by hand: a table hand-listed here would silently rot the
 * day someone adds a tenth one. The orphan test is what enforces the property —
 * add a new project-scoped table to its list, not to this function.
 *
 * The one subtlety worth naming: `publication.snapshot_id`,
 * `publication_history.snapshot_id` and `scheduled_publish.snapshot_id` point at
 * `feed_snapshot(id)` with NO `ON DELETE` clause (NO ACTION — migrations 0003 /
 * 0019), which is what makes `DELETE /projects/:id/snapshots/:vid` refuse to drop
 * a published snapshot. It does NOT block this cascade: SQLite runs the cascaded
 * child deletes before it enforces the immediate constraints, so the publication
 * rows are gone by the time the snapshot rows go.
 *
 * `audit_event` rows for the project are deliberately kept: they carry no FK,
 * and the account reaper takes the same line (keep subject rows, drop actor
 * rows) so the record of what happened to a feed outlives the feed.
 */
export async function purgeProject(env: Env, projectId: string): Promise<void> {
  // R2 first. Dying between the two steps this way round leaves a project row
  // pointing at missing blobs — recoverable, and visible. The other way round
  // leaves orphaned blobs that nothing references and nobody can ever find.
  await deleteProjectBlobs(env, projectId);

  await env.DB.prepare(`DELETE FROM feed_project WHERE id = ?`).bind(projectId).run();
}
