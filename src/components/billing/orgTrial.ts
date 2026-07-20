// Shared client-side model of the no-credit-card Planner trial, kept in one
// place so every surface that reads or starts a trial agrees:
//   - TrialBanner (in-editor "N days left")
//   - AccountBillingPage (personal billing surfaces any org on a trial)
//   - PricingPage (starting a trial: which org hosts it)
// The server (worker/billing/trial.ts) remains authoritative; these helpers
// only drive UI + the pre-flight org resolution.

import type { OrgSummary } from '../../services/orgsApi';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The minimal org shape the trial predicates need. */
export type TrialOrg = Pick<OrgSummary, 'plan' | 'planExpiresAt' | 'trialEndsAt'>;

/**
 * A live no-card Planner trial: the org is on `agency` with the trial markers
 * present and not yet expired. Mirrors the server model — a comp grant leaves
 * `trialEndsAt` null, and a paid conversion clears `planExpiresAt`, so neither
 * matches here.
 */
export function isOrgOnTrial(org: TrialOrg, now: number): boolean {
  if (org.plan !== 'agency') return false;
  if (org.trialEndsAt == null || org.planExpiresAt == null) return false;
  return org.trialEndsAt > now;
}

/** Whole days remaining, rounded up; at least 1 while the trial is still live. */
export function trialDaysLeft(endsAt: number, now: number): number {
  return Math.max(1, Math.ceil((endsAt - now) / DAY_MS));
}

/** Every org in the list that is currently on a live trial. */
export function orgsOnTrial<T extends TrialOrg>(orgs: T[], now: number): T[] {
  return orgs.filter((o) => isOrgOnTrial(o, now));
}

/** An org that could HOST a new trial: no existing paid/granted plan. */
export function canHostTrial(org: Pick<OrgSummary, 'plan'>): boolean {
  return !org.plan || org.plan === 'free';
}

/**
 * Slugify an org name down to lowercase ASCII + dashes within the server's
 * constraint (3-63 chars, must start with a letter/digit). Falls back to a
 * safe default when the name slugifies to something too short.
 */
export function slugifyOrgName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (cleaned.length >= 3) return cleaned;
  return (cleaned || 'team') + '-org';
}

/**
 * Default name for a workspace auto-created when a solo user starts a trial and
 * has no org yet. Derived from their display name (or email local part) so the
 * slug is reasonably unique and the org is instantly recognizable. Always
 * renameable later from org settings.
 */
export function deriveTrialOrgName(user: { displayName?: string | null; email: string }): string {
  const base = (user.displayName ?? '').trim() || user.email.split('@')[0] || 'My';
  return `${base}'s Workspace`;
}

/**
 * Slug candidate for the Nth auto-create attempt: the clean slug first, then a
 * short random suffix so a common default name (many "My Workspace"s) can't
 * dead-end the one-click trial on a slug collision. Lives here (not in the
 * component) so the randomness stays out of React's render purity rules.
 */
export function trialWorkspaceSlug(baseSlug: string, attempt: number): string {
  if (attempt <= 0) return baseSlug;
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${baseSlug.slice(0, 58)}-${suffix}`;
}

/**
 * Decide what happens when a user clicks "Start free trial", given the org they
 * pinned (org-scoped entry, may be null) and the admin orgs that could host a
 * trial. Pure so it can be unit-tested without mounting the pricing page.
 *   - 'blocked' → the pinned org already has a plan; can't trial it.
 *   - 'use'     → exactly one host; start immediately (one click).
 *   - 'create'  → no host org; auto-create one silently, then start.
 *   - 'pick'    → 2+ eligible hosts; ask which one (rare).
 */
export type TrialStartAction<T> =
  | { kind: 'blocked' }
  | { kind: 'use'; org: T }
  | { kind: 'create' }
  | { kind: 'pick'; orgs: T[] };

export function resolveTrialStart<T extends Pick<OrgSummary, 'plan'>>(
  presetOrg: T | null,
  eligibleOrgs: T[],
): TrialStartAction<T> {
  if (presetOrg) {
    return canHostTrial(presetOrg) ? { kind: 'use', org: presetOrg } : { kind: 'blocked' };
  }
  if (eligibleOrgs.length === 0) return { kind: 'create' };
  if (eligibleOrgs.length === 1) return { kind: 'use', org: eligibleOrgs[0] };
  return { kind: 'pick', orgs: eligibleOrgs };
}
