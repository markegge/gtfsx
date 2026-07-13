// Scheduled tasks run by the Worker's scheduled() handler.
//
// 1. `reapDeletedUsers` — hard-purge soft-deleted users past their 30-day
//    grace period. Order matters: projects (purgeProject: R2 blobs + every
//    project-scoped row) → org memberships → credentials → audit (keep subject
//    events, drop actor-only rows) → the user row itself.
//
// 2. `reapDeletedProjects` — hard-purge individually-deleted projects (feeds in
//    the trash) past their own 30-day grace period. Shares purgeProject() with
//    the user reaper so "purge a project" has exactly one definition.
//
// 3. `summarizeWeeklyMetrics` — cache top-level counters in KV so
//    /api/admin/stats can read them cheaply.

import type { Env } from '../env';
import { purgeProject } from '../projects/purge';
import { performPublish } from '../publication/performPublish';
import { requirePublishAccess } from '../billing/middleware';
import type { OwnerType } from '../projects/quotas';
import { sendOwnerDigest, type OwnerDigestMetrics } from '../email';

export const DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * How long a soft-deleted PROJECT sits in the trash before it is purged for
 * good. Deliberately the same 30 days as the account grace period above: a
 * deleted feed is recoverable (GET /api/projects/deleted → POST /:id/restore)
 * for a month, then reapDeletedProjects() erases it permanently.
 */
export const PROJECT_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Comp grant expiry ──────────────────────────────────────────────────────
//
// Manually-granted comp plans (agency or enterprise) can have an `expires_at`
// end-date. Run once a day to downgrade anything past its window. Idempotent.
//
// Guarded on `plan_expires_at IS NOT NULL`, which only ever matches comp
// grants: the Stripe webhook for paid subs sets plan/plan_status/
// plan_renewal_at but NEVER plan_expires_at (it stays NULL), so a paying
// Agency/Enterprise customer is never caught here. (Verified against
// worker/billing/webhooks.ts.)
export async function expireEnterpriseGrants(env: Env): Promise<{ users: number; orgs: number }> {
  const now = Date.now();
  const expiredUsers = await env.DB.prepare(
    `UPDATE user
        SET plan = 'free', plan_status = 'active',
            plan_expires_at = NULL, plan_renewal_at = NULL, updated_at = ?
      WHERE plan IN ('enterprise', 'agency')
        AND plan_expires_at IS NOT NULL
        AND plan_expires_at < ?`,
  )
    .bind(now, now)
    .run();

  const expiredOrgs = await env.DB.prepare(
    `UPDATE organization
        SET plan = 'free', plan_status = 'active',
            plan_expires_at = NULL, plan_renewal_at = NULL
      WHERE plan IN ('enterprise', 'agency')
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

  // 1) Personally-owned projects — purgeProject() erases the R2 blobs AND every
  //    project-scoped row (see worker/projects/purge.ts). Same helper the trash
  //    reaper uses, so the two paths can never diverge.
  const projects = await env.DB.prepare(
    `SELECT id FROM feed_project WHERE owner_type = 'user' AND owner_id = ?`,
  )
    .bind(userId)
    .all<{ id: string }>();

  for (const p of projects.results ?? []) {
    await purgeProject(env, p.id);
    stats.r2Projects += 1;
  }

  // 2) Org memberships. If the user was the last remaining member of an org,
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
      // Last member — drop the org. Purge its feeds the same way (blobs + rows)
      // rather than leaning on the organization → project FK cascade.
      const orgProjects = await env.DB.prepare(
        `SELECT id FROM feed_project WHERE owner_type = 'org' AND owner_id = ?`,
      )
        .bind(o.org_id)
        .all<{ id: string }>();
      for (const p of orgProjects.results ?? []) {
        await purgeProject(env, p.id);
        stats.r2Projects += 1;
      }
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

  // 3) Credentials. The FK cascades via `credential.user_id ON DELETE CASCADE`
  //    but we clear explicitly for defence-in-depth.
  await env.DB.prepare(`DELETE FROM credential WHERE user_id = ?`).bind(userId).run();

  // 4) Audit events: drop rows where this user is the actor, but KEEP events
  //    where they're the subject — those may matter for orgs/admins later.
  await env.DB.prepare(`DELETE FROM audit_event WHERE actor_user_id = ?`).bind(userId).run();

  // 5) The user row itself. Sessions, auth tokens etc. cascade via FK.
  await env.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();

  return stats;
}

// ─── Trash reaper: individually-deleted projects ────────────────────────────
//
// DELETE /api/projects/:id only sets feed_project.deleted_at — the feed drops
// out of the owner's list but stays fully recoverable (POST /:id/restore) for
// PROJECT_DELETE_GRACE_MS. This is what finally erases it. Without it, a deleted
// feed sat in D1 forever: unreachable to its owner AND never purged.
//
// A project whose OWNER is also being reaped gets purged by reapDeletedUsers
// instead; purgeProject is idempotent, so a project caught by both is harmless.

export interface ProjectReapSummary {
  candidates: number;
  purged: number;
  errors: number;
}

export async function reapDeletedProjects(env: Env): Promise<ProjectReapSummary> {
  const cutoff = Date.now() - PROJECT_DELETE_GRACE_MS;
  const candidates = await env.DB.prepare(
    `SELECT id, slug, owner_type, owner_id FROM feed_project
       WHERE deleted_at IS NOT NULL AND deleted_at < ?`,
  )
    .bind(cutoff)
    .all<{ id: string; slug: string; owner_type: string; owner_id: string }>();

  const rows = candidates.results ?? [];
  const summary: ProjectReapSummary = { candidates: rows.length, purged: 0, errors: 0 };

  for (const row of rows) {
    try {
      await purgeProject(env, row.id);
      summary.purged += 1;
      console.log(
        `[reaper] purged project ${row.id} (${row.slug}, ${row.owner_type}:${row.owner_id})`,
      );
    } catch (err) {
      summary.errors += 1;
      console.error(`[reaper] failed to purge project ${row.id}`, err);
    }
  }

  if (summary.candidates > 0) {
    console.log(
      `[reaper] ${summary.purged}/${summary.candidates} deleted projects purged, ` +
        `${summary.errors} errors`,
    );
  }
  return summary;
}

// ─── Weekly metrics rollup ──────────────────────────────────────────────────

export interface WeeklyMetrics {
  users: number;
  orgs: number;
  projects: number;
  snapshots: number;
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

  const [users, orgs, projects, snapshots, publications, signups7d, signups30d] = await Promise.all([
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE deleted_at IS NULL`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM organization WHERE deleted_at IS NULL`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM feed_project WHERE deleted_at IS NULL`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM feed_snapshot`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM publication`),
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`, d7),
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`, d30),
  ]);

  const metrics: WeeklyMetrics = {
    users,
    orgs,
    projects,
    snapshots,
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
      `snapshots=${metrics.snapshots} publications=${metrics.publications} ` +
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

// ─── Daily owner digest ─────────────────────────────────────────────────────
//
// Replaces the per-signup owner BCC with a once-a-day summary email. Fired by a
// dedicated daily cron (see worker/cron/index.ts). Three headline numbers over
// the trailing 24h, chosen to match the Admin dashboard's definitions exactly so
// the digest and the dashboard never disagree:
//
//   a) new sign-ups   = user rows with created_at >= now-24h
//                       (Admin computeStats → `signups`).
//   b) active users   = COUNT(DISTINCT session.user_id) with last_used_at >=
//                       now-24h (Admin `activeUsers.last24h`).
//   c) new paid subs  = subscription rows with created_at >= now-24h. The
//                       subscription table only ever holds Stripe-backed paid
//                       plans; created_at is stamped once on first insert and is
//                       NOT touched on later webhook upserts (verified against
//                       worker/billing/webhooks.ts ON CONFLICT clause).
//
// Plus two cheap running totals (all-time users, currently active/trialing paid
// subs) for at-a-glance context.

/** Format the trailing-24h window in UTC, e.g. "Jun 26 → Jun 27, 2026 (UTC)". */
function digestWindowLabel(now: number): string {
  const fmt = (t: number) =>
    new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const year = new Date(now).getUTCFullYear();
  return `${fmt(now - 24 * 60 * 60 * 1000)} → ${fmt(now)}, ${year} (UTC)`;
}

export async function computeOwnerDigest(env: Env): Promise<OwnerDigestMetrics> {
  const now = Date.now();
  const d24h = now - 24 * 60 * 60 * 1000;

  const [signups24h, activeUsers24h, newPaidSubs24h, totalUsers, activePaidSubs] = await Promise.all([
    scalarCount(env, `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`, d24h),
    scalarCount(env, `SELECT COUNT(DISTINCT user_id) AS n FROM session WHERE last_used_at >= ?`, d24h),
    scalarCount(env, `SELECT COUNT(*) AS n FROM subscription WHERE created_at >= ?`, d24h),
    scalarCount(env, `SELECT COUNT(*) AS n FROM user`),
    scalarCount(
      env,
      `SELECT COUNT(*) AS n FROM subscription WHERE status IN ('active', 'trialing')`,
    ),
  ]);

  return {
    signups24h,
    activeUsers24h,
    newPaidSubs24h,
    totalUsers,
    activePaidSubs,
    windowLabel: digestWindowLabel(now),
  };
}

export interface OwnerDigestResult {
  sent: boolean;
  reason?: string;
  metrics?: OwnerDigestMetrics;
}

/**
 * Compute the trailing-24h metrics and email them to the owner. Gated by
 * `OWNER_DIGEST_ENABLED` (kill switch; any value other than the literal
 * "false" leaves it on) and the recipient `OWNER_DIGEST_EMAIL`, which falls
 * back to `OWNER_NOTIFY_EMAIL` (the same inbox the paid-upgrade notice uses).
 * Best-effort: the caller logs but never rethrows.
 */
export async function runOwnerDigest(env: Env): Promise<OwnerDigestResult> {
  if (env.OWNER_DIGEST_ENABLED === 'false') {
    return { sent: false, reason: 'disabled' };
  }
  const to = env.OWNER_DIGEST_EMAIL || env.OWNER_NOTIFY_EMAIL;
  if (!to) {
    return { sent: false, reason: 'no-recipient' };
  }

  const metrics = await computeOwnerDigest(env);
  await sendOwnerDigest(env, to, metrics);
  console.log(
    `[cron:owner-digest] sent to ${to} — signups=${metrics.signups24h} ` +
      `active=${metrics.activeUsers24h} newPaid=${metrics.newPaidSubs24h} ` +
      `(totals: users=${metrics.totalUsers} activePaid=${metrics.activePaidSubs})`,
  );
  return { sent: true, metrics };
}

// ─── Scheduled publish (BE-77) ──────────────────────────────────────────────
//
// Fired by the */15 cron. Publishes any pending scheduled_publish rows whose
// time has arrived, via the same performPublish() core the interactive route
// uses. Each row is isolated — a failure marks just that row 'failed' (with a
// reason) and never blocks the others. Access is re-checked at execution time
// because the owner's plan/quota can change after scheduling.
export async function publishDueSchedules(env: Env): Promise<{ published: number; failed: number }> {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT id, project_id, snapshot_id, ignore_warnings
       FROM scheduled_publish
      WHERE status = 'pending' AND scheduled_for <= ?
      ORDER BY scheduled_for ASC
      LIMIT 100`,
  )
    .bind(now)
    .all<{ id: string; project_id: string; snapshot_id: string; ignore_warnings: number }>();

  let published = 0;
  let failed = 0;
  for (const row of due.results ?? []) {
    try {
      await runOneScheduledPublish(env, row);
      await env.DB.prepare(
        `UPDATE scheduled_publish SET status = 'executed', executed_at = ? WHERE id = ?`,
      ).bind(Date.now(), row.id).run();
      published += 1;
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[scheduled-publish] ${row.id} failed:`, reason);
      await env.DB.prepare(
        `UPDATE scheduled_publish SET status = 'failed', failure_reason = ?, executed_at = ? WHERE id = ?`,
      ).bind(reason.slice(0, 500), Date.now(), row.id).run();
    }
  }
  return { published, failed };
}

async function runOneScheduledPublish(
  env: Env,
  row: { id: string; project_id: string; snapshot_id: string; ignore_warnings: number },
): Promise<void> {
  const project = await env.DB.prepare(
    `SELECT id, slug, name, owner_type, owner_id FROM feed_project WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(row.project_id)
    .first<{ id: string; slug: string; name: string; owner_type: string; owner_id: string }>();
  if (!project) throw new Error('project not found or deleted');

  const snapshot = await env.DB.prepare(
    `SELECT id, state_r2_key, zip_r2_key, validation_errors, validation_warnings
       FROM feed_snapshot WHERE id = ? AND project_id = ?`,
  )
    .bind(row.snapshot_id, row.project_id)
    .first<{
      id: string; state_r2_key: string; zip_r2_key: string | null;
      validation_errors: number; validation_warnings: number;
    }>();
  if (!snapshot) throw new Error('snapshot not found');

  const existingPublication = await env.DB.prepare(
    `SELECT snapshot_id FROM publication WHERE project_id = ?`,
  )
    .bind(row.project_id)
    .first<{ snapshot_id: string }>();

  // Re-check publish access — plan/quota may have changed since scheduling.
  // A throw here bubbles up and marks the schedule 'failed'.
  await requirePublishAccess(env, project.owner_type as OwnerType, project.owner_id, {
    isNewPublication: !existingPublication,
  });

  // Run catalog + thumbnail work inline (await it) — a cron isn't latency-
  // sensitive and the worker may be torn down right after we return.
  const background: Promise<unknown>[] = [];
  await performPublish(env, {
    project: { id: project.id, slug: project.slug, name: project.name },
    snapshot,
    existingPublication,
    ignoreWarnings: row.ignore_warnings === 1,
    actorUserId: null, // system-initiated
    feedsOrigin: env.FEEDS_ORIGIN,
    runBackground: (p) => background.push(p),
  });
  await Promise.allSettled(background);
}
