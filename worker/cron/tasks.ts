// Scheduled tasks run by the Worker's scheduled() handler.
//
// 1. `reapDeletedUsers` — hard-purge soft-deleted users past their 30-day
//    grace period. Order matters: R2 blobs → projects (FK cascades handle
//    versions/drafts/publications) → org memberships → credentials → audit
//    (keep subject events, drop actor-only rows) → the user row itself.
//
// 2. `summarizeWeeklyMetrics` — cache top-level counters in KV so
//    /api/admin/stats can read them cheaply.

import type { Env } from '../env';
import { deleteProjectBlobs } from '../projects/r2';

export const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Enterprise grant expiry ────────────────────────────────────────────────
//
// Manually-granted enterprise plans can have an `expires_at` end-date. Run
// once a day to downgrade anything past its window. Idempotent.
export async function expireEnterpriseGrants(env: Env): Promise<{ users: number; orgs: number }> {
  const now = Date.now();
  const expiredUsers = await env.DB.prepare(
    `UPDATE user
        SET plan = 'free', plan_status = 'active',
            plan_expires_at = NULL, plan_renewal_at = NULL, updated_at = ?
      WHERE plan = 'enterprise'
        AND plan_expires_at IS NOT NULL
        AND plan_expires_at < ?`,
  )
    .bind(now, now)
    .run();

  const expiredOrgs = await env.DB.prepare(
    `UPDATE organization
        SET plan = 'free', plan_status = 'active',
            plan_expires_at = NULL, plan_renewal_at = NULL
      WHERE plan = 'enterprise'
        AND plan_expires_at IS NOT NULL
        AND plan_expires_at < ?`,
  )
    .bind(now)
    .run();

  const userCount = expiredUsers.meta?.changes ?? 0;
  const orgCount = expiredOrgs.meta?.changes ?? 0;
  if (userCount || orgCount) {
    console.log(`[cron] expireEnterpriseGrants users=${userCount} orgs=${orgCount}`);
  }
  return { users: userCount, orgs: orgCount };
}

export interface ReapSummary {
  candidates: number;
  reaped: number;
  r2Projects: number;
  orgsDeleted: number;
  orgMembershipsRemoved: number;
  errors: number;
}

/**
 * Find every user with `status='deleted_soft'` whose deletion timestamp is
 * older than DELETE_GRACE_MS, and hard-purge them.
 */
export async function reapDeletedUsers(env: Env): Promise<ReapSummary> {
  const cutoff = Date.now() - DELETE_GRACE_MS;
  const candidates = await env.DB.prepare(
    `SELECT id, email FROM user
       WHERE status = 'deleted_soft'
         AND deleted_at IS NOT NULL
         AND deleted_at < ?`,
  )
    .bind(cutoff)
    .all<{ id: string; email: string }>();

  const rows = candidates.results ?? [];
  const summary: ReapSummary = {
    candidates: rows.length,
    reaped: 0,
    r2Projects: 0,
    orgsDeleted: 0,
    orgMembershipsRemoved: 0,
    errors: 0,
  };

  for (const row of rows) {
    try {
      const result = await reapOne(env, row.id);
      summary.reaped += 1;
      summary.r2Projects += result.r2Projects;
      summary.orgsDeleted += result.orgsDeleted;
      summary.orgMembershipsRemoved += result.orgMembershipsRemoved;
      console.log(
        `[reaper] purged user ${row.id} (${row.email}): ${result.r2Projects} projects, ` +
          `${result.orgMembershipsRemoved} org memberships, ${result.orgsDeleted} orgs`,
      );
    } catch (err) {
      summary.errors += 1;
      console.error(`[reaper] failed to purge user ${row.id}`, err);
    }
  }

  console.log(
    `[reaper] ${summary.reaped}/${summary.candidates} users reaped, ` +
      `${summary.r2Projects} project blob sets removed, ${summary.errors} errors`,
  );
  return summary;
}

interface PerUserReap {
  r2Projects: number;
  orgsDeleted: number;
  orgMembershipsRemoved: number;
}

async function reapOne(env: Env, userId: string): Promise<PerUserReap> {
  const stats: PerUserReap = { r2Projects: 0, orgsDeleted: 0, orgMembershipsRemoved: 0 };

  // 1) R2 blobs — all personally-owned project prefixes + their publication zips.
  const projects = await env.DB.prepare(
    `SELECT id FROM feed_project WHERE owner_type = 'user' AND owner_id = ?`,
  )
    .bind(userId)
    .all<{ id: string }>();
  const projectIds = (projects.results ?? []).map((p) => p.id);

  for (const pid of projectIds) {
    // projects/<id>/** covers working-state + versions/<vid>/state + versions/<vid>/gtfs.zip
    await deleteProjectBlobs(env, pid);
    // publications/<id>/** covers published + rolled-back ZIPs
    await deletePrefixedBlobs(env, `publications/${pid}/`);
    // draft-links/<id>/** covers any draft preview ZIPs
    await deletePrefixedBlobs(env, `draft-links/${pid}/`);
    stats.r2Projects += 1;
  }

  // 2) Delete project rows — FK cascades take care of feed_version, draft_link,
  //    publication, publication_history, project_catalog_submission, project_rt_feed.
  await env.DB.prepare(
    `DELETE FROM feed_project WHERE owner_type = 'user' AND owner_id = ?`,
  )
    .bind(userId)
    .run();

  // 3) Org memberships. If the user was the last remaining member of an org,
  //    drop the org too (orphan cleanup). Otherwise just remove their row.
  const orgs = await env.DB.prepare(
    `SELECT org_id FROM organization_membership WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ org_id: string }>();
  for (const o of orgs.results ?? []) {
    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM organization_membership
        WHERE org_id = ? AND user_id != ?`,
    )
      .bind(o.org_id, userId)
      .first<{ n: number }>();
    if ((remaining?.n ?? 0) === 0) {
      // Last member — drop the org (its memberships and projects cascade via FKs).
      // Scrub any org-owned project blobs first so we don't leave R2 orphans.
      const orgProjects = await env.DB.prepare(
        `SELECT id FROM feed_project WHERE owner_type = 'org' AND owner_id = ?`,
      )
        .bind(o.org_id)
        .all<{ id: string }>();
      for (const p of orgProjects.results ?? []) {
        await deleteProjectBlobs(env, p.id);
        await deletePrefixedBlobs(env, `publications/${p.id}/`);
        await deletePrefixedBlobs(env, `draft-links/${p.id}/`);
      }
      await env.DB.prepare(`DELETE FROM feed_project WHERE owner_type = 'org' AND owner_id = ?`)
        .bind(o.org_id)
        .run();
      await env.DB.prepare(`DELETE FROM organization_membership WHERE org_id = ?`)
        .bind(o.org_id)
        .run();
      await env.DB.prepare(`DELETE FROM organization WHERE id = ?`).bind(o.org_id).run();
      stats.orgsDeleted += 1;
    } else {
      await env.DB.prepare(
        `DELETE FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      )
        .bind(o.org_id, userId)
        .run();
      stats.orgMembershipsRemoved += 1;
    }
  }

  // 4) Credentials. The FK cascades via `credential.user_id ON DELETE CASCADE`
  //    but we clear explicitly for defence-in-depth.
  await env.DB.prepare(`DELETE FROM credential WHERE user_id = ?`).bind(userId).run();

  // 5) Audit events: drop rows where this user is the actor, but KEEP events
  //    where they're the subject — those may matter for orgs/admins later.
  await env.DB.prepare(`DELETE FROM audit_event WHERE actor_user_id = ?`).bind(userId).run();

  // 6) The user row itself. Sessions, auth tokens etc. cascade via FK.
  await env.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();

  return stats;
}

async function deletePrefixedBlobs(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined = undefined;
  while (true) {
    const listed: R2Objects = await env.FEEDS.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await env.FEEDS.delete(listed.objects.map((o) => o.key));
    }
    if (!listed.truncated) break;
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor) break;
  }
}

// ─── Weekly metrics rollup ──────────────────────────────────────────────────

export interface WeeklyMetrics {
  users: number;
  orgs: number;
  projects: number;
  versions: number;
  publications: number;
  signups7d: number;
  signups30d: number;
  computedAt: number;
}

/**
 * Compute a snapshot of platform-wide counters and cache it in KV. The admin
 * /api/admin/stats endpoint (built by the admin agent) can read this key
 * instead of running a dozen COUNT queries on each request.
 */
export async function summarizeWeeklyMetrics(env: Env): Promise<WeeklyMetrics> {
  const now = Date.now();
  const d7 = now - 7 * 24 * 60 * 60 * 1000;
  const d30 = now - 30 * 24 * 60 * 60 * 1000;

  const [users, orgs, projects, versions, publications, signups7d, signups30d] = await Promise.all([
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE deleted_at IS NULL`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM organization WHERE deleted_at IS NULL`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM feed_project WHERE deleted_at IS NULL`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM feed_version`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM publication`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`, d7),
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`, d30),
  ]);

  const metrics: WeeklyMetrics = {
    users,
    orgs,
    projects,
    versions,
    publications,
    signups7d,
    signups30d,
    computedAt: now,
  };

  await env.KV.put('metrics:weekly', JSON.stringify(metrics), {
    expirationTtl: 24 * 60 * 60, // 24h
  });

  console.log(
    `[metrics] users=${metrics.users} orgs=${metrics.orgs} projects=${metrics.projects} ` +
      `versions=${metrics.versions} publications=${metrics.publications} ` +
      `signups(7d/30d)=${metrics.signups7d}/${metrics.signups30d}`,
  );
  return metrics;
}

async function scalarCount(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return row?.n ?? 0;
  } catch (err) {
    // A table that doesn't exist yet (e.g. publication pre-Phase 5) shouldn't
    // abort the rollup — return 0 for that counter.
    console.warn(`[metrics] scalar count failed for ${sql.slice(0, 60)}:`, err);
    return 0;
  }
}
