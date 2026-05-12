// Plan + feature gating used by both auth-protected route middleware and
// inline calls (`requirePublishAccess`, etc.) where ownership is already
// resolved.

import type { Env } from '../env';
import { paymentRequired, quotaExceeded } from '../util/errors';
import {
  countPublishedFeeds,
  getOwnerPlan,
  getOwnerQuotas,
  PLAN_QUOTAS,
  type OwnerType,
  type Plan,
} from '../projects/quotas';
import { cheapestPlanFor, planHasFeature, type FeatureKey } from './plans';

interface PaywallContext {
  feature: FeatureKey;
  currentPlan: Plan;
  upgradeTo: Plan;
}

function paywall(ctx: PaywallContext, msg?: string) {
  return paymentRequired(msg ?? `This feature requires the ${ctx.upgradeTo} plan or higher.`, {
    feature: ctx.feature,
    currentPlan: ctx.currentPlan,
    upgradeTo: ctx.upgradeTo,
  });
}

// ─── Feature gate (no quota) ────────────────────────────────────────────────
//
// Used for binary access checks: a free user calling /analysis/title-vi gets
// 402 with structured upgrade context. A pro user calling the same endpoint
// passes through.

export async function requireOwnerFeature(
  env: Env,
  ownerType: OwnerType,
  ownerId: string,
  feature: FeatureKey,
): Promise<Plan> {
  const plan = await getOwnerPlan(env, ownerType, ownerId);
  if (!planHasFeature(plan, feature)) {
    throw paywall({ feature, currentPlan: plan, upgradeTo: cheapestPlanFor(feature) });
  }
  return plan;
}

// Feature gate that operates against the authenticated user's personal plan
// (for routes whose subject isn't tied to a project — e.g. /api/me-scoped
// analysis on local-only data).
export async function requireUserFeature(env: Env, userId: string, feature: FeatureKey): Promise<Plan> {
  return requireOwnerFeature(env, 'user', userId, feature);
}

// ─── Combined feature + quota gates for managed publishing ──────────────────

// Publishing a NEW feed: must have managed_publishing AND have headroom on
// the publishedFeeds quota for this owner. Re-publishing an existing
// publication (same project_id) skips the count check.
export async function requirePublishAccess(
  env: Env,
  ownerType: OwnerType,
  ownerId: string,
  opts?: { isNewPublication?: boolean },
): Promise<Plan> {
  const plan = await requireOwnerFeature(env, ownerType, ownerId, 'managed_publishing');
  // Always check headroom — re-publish vs first-publish is decided by the
  // caller via opts.isNewPublication. The publish route does the lookup itself
  // and only passes isNewPublication=true if no existing publication exists,
  // which avoids a double DB roundtrip for the common re-publish path.
  if (opts?.isNewPublication) {
    const used = await countPublishedFeeds(env, ownerType, ownerId);
    const limit = PLAN_QUOTAS[plan].publishedFeeds;
    if (used >= limit) {
      throw quotaExceeded(
        `Published-feed limit reached (${used}/${limit}). Upgrade your plan to publish more feeds.`,
        { kind: 'published', used, limit, currentPlan: plan },
      );
    }
  }
  return plan;
}

export async function requireDraftLinkAccess(
  env: Env,
  ownerType: OwnerType,
  ownerId: string,
): Promise<Plan> {
  return requireOwnerFeature(env, ownerType, ownerId, 'draft_links');
}

// ─── Seat enforcement for org memberships (consultant capability) ───────────

// Used by POST /api/orgs/:id/invitations and /api/orgs/:id/members. The
// invitee must be a plan that can be a member of orgs they don't own.
export async function requireMemberCanJoin(env: Env, userId: string): Promise<Plan> {
  const plan = await getOwnerPlan(env, 'user', userId);
  if (plan === 'free') {
    throw paywall({
      feature: 'cross_org_member',
      currentPlan: plan,
      upgradeTo: 'pro',
    }, 'This user must upgrade to Pro or Consultant before joining an organization.');
  }
  return plan;
}

// Used by POST /api/orgs/:id/invitations and /api/orgs/:id/members. The org's
// plan + paid seat count must have headroom for one more member.
export async function requireOrgSeatAvailable(env: Env, orgId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT plan, plan_seat_count FROM organization WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId)
    .first<{ plan: string; plan_seat_count: number }>();
  if (!row) return;
  const plan = (row.plan ?? 'free') as Plan;
  if (plan === 'free') {
    throw paywall({
      feature: 'org_workspace',
      currentPlan: plan,
      upgradeTo: 'team',
    }, 'This organization needs a paid plan before adding members.');
  }
  const membersRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM organization_membership WHERE org_id = ?`,
  )
    .bind(orgId)
    .first<{ n: number }>();
  const currentMembers = membersRow?.n ?? 0;
  const seats = row.plan_seat_count ?? 1;
  if (currentMembers >= seats) {
    throw quotaExceeded(
      `Seat limit reached (${currentMembers}/${seats}). Add a seat in billing settings, then invite the new member.`,
      { kind: 'seats', used: currentMembers, limit: seats },
    );
  }
}

// Exported convenience for endpoints/UI that want to know what a paywall
// would say without throwing.
export async function describeFeatureAccess(
  env: Env,
  ownerType: OwnerType,
  ownerId: string,
  feature: FeatureKey,
): Promise<{ plan: Plan; hasAccess: boolean; upgradeTo: Plan }> {
  const plan = await getOwnerPlan(env, ownerType, ownerId);
  return {
    plan,
    hasAccess: planHasFeature(plan, feature),
    upgradeTo: cheapestPlanFor(feature),
  };
}

// Quota helpers re-exported for the routes that already have plan context.
export { countPublishedFeeds, getOwnerPlan, getOwnerQuotas };
