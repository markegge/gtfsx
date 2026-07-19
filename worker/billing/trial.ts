// Self-serve, no-credit-card Planner trial.
//
// A 14-day trial of the Planner plan (internal id 'agency') that a user starts
// in-app with ZERO Stripe involvement. It reuses the comp-grant mechanism for
// gating: the org's cached `plan` is set to 'agency' with `plan_expires_at` at
// the trial end, and the nightly `expireEnterpriseGrants` cron downgrades it
// back to 'free' at expiry exactly as it does for comp grants. See migration
// 0029 for the eligibility markers that outlive the plan columns.
//
// Eligibility is one trial per ORG and one per USER (a user who already burned a
// trial can't farm fresh orgs for more). Enforcement is SERVER-SIDE ONLY — the
// client hides the CTA, the server refuses. The endpoint is idempotent: a
// double-submit re-reads and returns the existing trial state rather than
// erroring or double-granting.

import type { Env } from '../env';
import { conflict, notFound, validationFailed } from '../util/errors';

export const TRIAL_DAYS = 14;
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialState {
  orgId: string;
  plan: 'agency';
  trialEndsAt: number;
  /** Whole days remaining, rounded up; 0 once expired. */
  trialDaysLeft: number;
}

function daysLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
}

interface OrgTrialRow {
  id: string;
  name: string;
  plan: string | null;
  trial_started_at: number | null;
  trial_ends_at: number | null;
  plan_expires_at: number | null;
}

/**
 * Start (or idempotently re-return) an org's Planner trial. Throws an ApiError
 * when the org/user is ineligible:
 *   - 404 org not found
 *   - 422 org already on a (paid or granted) plan  { code: 'org_has_plan' }
 *   - 409 org already used its trial               { code: 'org_trial_used' }
 *   - 409 user already used their trial            { code: 'user_trial_used' }
 *
 * Does NOT write the audit/analytics rows — the route owns those so this stays a
 * pure state transition the worker tests can drive directly (mirrors how
 * expireEnterpriseGrants is tested).
 */
export async function startOrgTrial(
  env: Env,
  opts: { orgId: string; userId: string },
): Promise<TrialState> {
  const { orgId, userId } = opts;
  const now = Date.now();

  const org = await env.DB.prepare(
    `SELECT id, name, plan, trial_started_at, trial_ends_at, plan_expires_at
       FROM organization WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId)
    .first<OrgTrialRow>();
  if (!org) throw notFound('Organization not found');

  // Already on a plan (paid subscription, comp grant, or a live trial).
  if (org.plan && org.plan !== 'free') {
    // If it's THIS org's own still-running trial, treat as idempotent success
    // so a retried request lands the user in the editor instead of erroring.
    if (
      org.plan === 'agency' &&
      org.trial_ends_at != null &&
      org.plan_expires_at != null &&
      org.plan_expires_at > now
    ) {
      return {
        orgId,
        plan: 'agency',
        trialEndsAt: org.plan_expires_at,
        trialDaysLeft: daysLeft(org.plan_expires_at, now),
      };
    }
    throw validationFailed('This organization already has a plan.', { code: 'org_has_plan' });
  }

  // One trial per org.
  if (org.trial_started_at != null) {
    throw conflict('This organization has already used its free trial.', { code: 'org_trial_used' });
  }

  // One trial per user — the anti-farming gate (a burned user can't spin up a
  // fresh org for another trial).
  const u = await env.DB.prepare(`SELECT trial_started_at FROM user WHERE id = ?`)
    .bind(userId)
    .first<{ trial_started_at: number | null }>();
  if (u?.trial_started_at != null) {
    throw conflict("You've already used your free trial.", { code: 'user_trial_used' });
  }

  const endsAt = now + TRIAL_MS;

  // Guarded UPDATE — only fires while the org is still free + untrialed, so two
  // concurrent submits can't double-grant. A lost race re-reads and returns the
  // winner's state (idempotent).
  const orgUpd = await env.DB.prepare(
    `UPDATE organization
        SET plan = 'agency', plan_status = 'active',
            plan_expires_at = ?, plan_renewal_at = ?,
            trial_started_at = ?, trial_ends_at = ?
      WHERE id = ? AND plan = 'free' AND trial_started_at IS NULL`,
  )
    .bind(endsAt, endsAt, now, endsAt, orgId)
    .run();

  if ((orgUpd.meta?.changes ?? 0) === 0) {
    const fresh = await env.DB.prepare(
      `SELECT plan_expires_at FROM organization WHERE id = ?`,
    )
      .bind(orgId)
      .first<{ plan_expires_at: number | null }>();
    const ends = fresh?.plan_expires_at ?? endsAt;
    return { orgId, plan: 'agency', trialEndsAt: ends, trialDaysLeft: daysLeft(ends, now) };
  }

  // Consume the user's one trial (guarded so we never stomp an earlier stamp).
  await env.DB.prepare(
    `UPDATE user SET trial_started_at = ?, updated_at = ? WHERE id = ? AND trial_started_at IS NULL`,
  )
    .bind(now, now, userId)
    .run();

  return { orgId, plan: 'agency', trialEndsAt: endsAt, trialDaysLeft: TRIAL_DAYS };
}

/** Whether a user has already consumed their one self-serve trial. */
export async function getUserTrialUsed(env: Env, userId: string): Promise<boolean> {
  const u = await env.DB.prepare(`SELECT trial_started_at FROM user WHERE id = ?`)
    .bind(userId)
    .first<{ trial_started_at: number | null }>();
  return u?.trial_started_at != null;
}
