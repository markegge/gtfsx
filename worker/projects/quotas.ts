import type { Env } from '../env';
import { quotaExceeded } from '../util/errors';

// ─── Plan model ─────────────────────────────────────────────────────────────
//
// Cached on user.plan / organization.plan; authoritative source is the
// subscription table synced from Stripe webhooks. See docs/FREEMIUM_PLAN.md.

export type Plan =
  | 'free'
  | 'pro'
  | 'team'
  | 'consultant'
  | 'consultant_firm'
  | 'enterprise';

export type OwnerType = 'user' | 'org';

export interface PlanQuotas {
  projects: number;
  versionsPerProject: number;
  blobBytes: number;
  publishedFeeds: number;
}

const MB = 1024 * 1024;

export const PLAN_QUOTAS: Record<Plan, PlanQuotas> = {
  free:            { projects: 3,     versionsPerProject: 5,   blobBytes:  20 * MB, publishedFeeds: 0 },
  pro:             { projects: 10,    versionsPerProject: 25,  blobBytes:  50 * MB, publishedFeeds: 1 },
  team:            { projects: 500,   versionsPerProject: 50,  blobBytes: 100 * MB, publishedFeeds: 5 },
  consultant:      { projects: 500,   versionsPerProject: 50,  blobBytes: 100 * MB, publishedFeeds: 5 },
  consultant_firm: { projects: 500,   versionsPerProject: 50,  blobBytes: 100 * MB, publishedFeeds: 5 },
  enterprise:      { projects: 99999, versionsPerProject: 200, blobBytes: 200 * MB, publishedFeeds: 99999 },
};

export const PLANS: readonly Plan[] = Object.keys(PLAN_QUOTAS) as Plan[];

export function isPlan(s: string | null | undefined): s is Plan {
  return typeof s === 'string' && (PLANS as readonly string[]).includes(s);
}

// Legacy defaults — kept for the small number of call sites that don't yet
// thread an owner through. New code should resolve via getOwnerQuotas().
export const MAX_PROJECTS_PER_OWNER = PLAN_QUOTAS.team.projects;
export const MAX_VERSIONS_PER_PROJECT = PLAN_QUOTAS.team.versionsPerProject;
export const MAX_BLOB_BYTES = PLAN_QUOTAS.team.blobBytes;

// ─── Plan resolution ────────────────────────────────────────────────────────

export async function getOwnerPlan(
  env: Env,
  ownerType: OwnerType,
  ownerId: string,
): Promise<Plan> {
  if (ownerType === 'user') {
    const row = await env.DB.prepare(`SELECT plan FROM user WHERE id = ?`)
      .bind(ownerId)
      .first<{ plan: string | null }>();
    return isPlan(row?.plan) ? (row!.plan as Plan) : 'free';
  }
  const row = await env.DB.prepare(`SELECT plan FROM organization WHERE id = ?`)
    .bind(ownerId)
    .first<{ plan: string | null }>();
  return isPlan(row?.plan) ? (row!.plan as Plan) : 'free';
}

export async function getOwnerQuotas(
  env: Env,
  ownerType: OwnerType,
  ownerId: string,
): Promise<PlanQuotas & { plan: Plan }> {
  const plan = await getOwnerPlan(env, ownerType, ownerId);
  return { plan, ...PLAN_QUOTAS[plan] };
}

// ─── Counters ───────────────────────────────────────────────────────────────

export async function countProjects(env: Env, ownerType: string, ownerId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feed_project WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(ownerType, ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countVersions(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feed_version WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// A "published" feed = a publication row pointing at a feed_version for a
// non-deleted project owned by this principal. Free tier publishedFeeds=0.
export async function countPublishedFeeds(
  env: Env,
  ownerType: string,
  ownerId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT p.project_id) AS n
       FROM publication p
       JOIN feed_project fp ON fp.id = p.project_id
      WHERE fp.owner_type = ? AND fp.owner_id = ? AND fp.deleted_at IS NULL`,
  )
    .bind(ownerType, ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── Enforcement ────────────────────────────────────────────────────────────

export type QuotaKind = 'projects' | 'versions' | 'blob' | 'published';

export interface EnforceResult {
  warning: string | null;
}

function isHard(env: Env): boolean {
  return env.HARD_LIMITS === 'true';
}

export function enforceQuota(
  env: Env,
  kind: QuotaKind,
  used: number,
  limit: number,
): EnforceResult {
  if (used >= limit) {
    if (isHard(env)) {
      throw quotaExceeded(quotaMessage(kind, used, limit), { kind, used, limit });
    }
    return { warning: `${used}/${limit}` };
  }
  const warnAt = Math.floor(limit * 0.9);
  if (used >= warnAt) {
    return { warning: `${used}/${limit}` };
  }
  return { warning: null };
}

export function enforceBlobSize(size: number, limit: number = MAX_BLOB_BYTES): void {
  if (size > limit) {
    throw quotaExceeded(
      `Feed state exceeds the ${Math.floor(limit / MB)} MB limit`,
      { kind: 'blob', used: size, limit },
    );
  }
}

function quotaMessage(kind: QuotaKind, used: number, limit: number): string {
  switch (kind) {
    case 'projects':
      return `Project limit reached (${used}/${limit}). Upgrade your plan or delete a project to free space.`;
    case 'versions':
      return `Version limit reached for this project (${used}/${limit}). Delete older versions or upgrade your plan.`;
    case 'blob':
      return `Feed state size exceeds the allowed limit (${used}/${limit} bytes).`;
    case 'published':
      return `Published-feed limit reached (${used}/${limit}). Upgrade your plan to publish more feeds.`;
  }
}
