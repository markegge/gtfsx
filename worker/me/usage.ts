// Per-user quota/usage computation. Feeds into /api/me and /api/me/usage —
// small wrapper around COUNT(*) and SUM() queries against feed_project and
// feed_snapshot.

import type { Env } from '../env';

export interface UsageCounts {
  projects: number;
  snapshots: number;
  storageBytes: number;
}

/**
 * Compute per-user personal usage: projects owned directly by this user
 * (owner_type='user'), versions across those projects, and the total R2
 * storage we track for them (working state + version state + version zip).
 *
 * We rely on tracked sizes in D1 rather than R2 `list()` so this is fast
 * enough to call on every /api/me request.
 */
export async function computeUserUsage(env: Env, userId: string): Promise<UsageCounts> {
  const projectRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(working_state_size), 0) AS working_bytes
       FROM feed_project
       WHERE owner_type = 'user' AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(userId)
    .first<{ n: number; working_bytes: number }>();

  const snapshotRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(zip_size), 0) AS zip_bytes
       FROM feed_snapshot v
       JOIN feed_project p ON p.id = v.project_id
       WHERE p.owner_type = 'user' AND p.owner_id = ? AND p.deleted_at IS NULL`,
  )
    .bind(userId)
    .first<{ n: number; zip_bytes: number }>();

  return {
    projects: projectRow?.n ?? 0,
    snapshots: snapshotRow?.n ?? 0,
    storageBytes: (projectRow?.working_bytes ?? 0) + (snapshotRow?.zip_bytes ?? 0),
  };
}

/**
 * Compute org usage for a single org. Same idea but owner_type='org'.
 * Returns null if `orgId` is empty/undefined.
 */
export async function computeOrgUsage(env: Env, orgId: string): Promise<UsageCounts> {
  const projectRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(working_state_size), 0) AS working_bytes
       FROM feed_project
       WHERE owner_type = 'org' AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId)
    .first<{ n: number; working_bytes: number }>();

  const snapshotRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(zip_size), 0) AS zip_bytes
       FROM feed_snapshot v
       JOIN feed_project p ON p.id = v.project_id
       WHERE p.owner_type = 'org' AND p.owner_id = ? AND p.deleted_at IS NULL`,
  )
    .bind(orgId)
    .first<{ n: number; zip_bytes: number }>();

  return {
    projects: projectRow?.n ?? 0,
    snapshots: snapshotRow?.n ?? 0,
    storageBytes: (projectRow?.working_bytes ?? 0) + (snapshotRow?.zip_bytes ?? 0),
  };
}
