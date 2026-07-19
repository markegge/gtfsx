// Self-serve no-credit-card Planner trial (worker/billing/trial.ts + the
// comp-grant expiry cron it reuses + the webhook conversion-safety fix).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import type Stripe from 'stripe';
import { applyMigrations, env, resetDb, seedUser, setupEmailCapture, type EmailCapture } from './_setup';
import type { Env } from '../env';
import { startOrgTrial, getUserTrialUsed, TRIAL_DAYS } from '../billing/trial';
import { expireEnterpriseGrants, runTrialEndingReminders } from '../cron/tasks';
import { syncSubscription } from '../billing/webhooks';
import { getOwnerPlan } from '../projects/quotas';
import { requireOwnerFeature } from '../billing/middleware';

const DAY = 24 * 60 * 60 * 1000;
const testEnv = env as unknown as Env;

async function seedOrg(opts: {
  plan?: 'free' | 'agency' | 'enterprise';
  ownerId?: string;
} = {}): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO organization (id, slug, name, plan, plan_status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, `org-${id.toLowerCase()}`, 'Test Org', opts.plan ?? 'free', now)
    .run();
  if (opts.ownerId) {
    await env.DB.prepare(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at)
       VALUES (?, ?, 'owner', ?)`,
    )
      .bind(id, opts.ownerId, now)
      .run();
  }
  return id;
}

interface OrgRow {
  plan: string;
  plan_status: string;
  plan_expires_at: number | null;
  trial_started_at: number | null;
  trial_ends_at: number | null;
}
function readOrg(orgId: string): Promise<OrgRow | null> {
  return env.DB.prepare(
    `SELECT plan, plan_status, plan_expires_at, trial_started_at, trial_ends_at
       FROM organization WHERE id = ?`,
  )
    .bind(orgId)
    .first<OrgRow>();
}

describe('startOrgTrial — eligibility + activation', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('elevates the org to agency for 14 days and marks both org and user', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ ownerId: user.id });
    const before = Date.now();

    const state = await startOrgTrial(testEnv, { orgId, userId: user.id });

    expect(state.plan).toBe('agency');
    expect(state.trialDaysLeft).toBe(TRIAL_DAYS);
    expect(state.trialEndsAt).toBeGreaterThan(before + 13 * DAY);
    expect(state.trialEndsAt).toBeLessThan(before + 15 * DAY);

    const org = await readOrg(orgId);
    expect(org?.plan).toBe('agency');
    expect(org?.plan_status).toBe('active');
    expect(org?.plan_expires_at).toBe(state.trialEndsAt);
    expect(org?.trial_started_at).not.toBeNull();
    expect(org?.trial_ends_at).toBe(state.trialEndsAt);

    // The user is marked eligible-consumed but their PERSONAL plan is untouched
    // (the trial elevates the org, not the user).
    const u = await env.DB.prepare(`SELECT plan, trial_started_at FROM user WHERE id = ?`)
      .bind(user.id)
      .first<{ plan: string; trial_started_at: number | null }>();
    expect(u?.plan).toBe('free');
    expect(u?.trial_started_at).not.toBeNull();
    expect(await getUserTrialUsed(testEnv, user.id)).toBe(true);
  });

  it('unlocks agency-gated features while the trial is active', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ ownerId: user.id });
    await startOrgTrial(testEnv, { orgId, userId: user.id });

    expect(await getOwnerPlan(testEnv, 'org', orgId)).toBe('agency');
    // An agency-gated feature resolves (does not throw a paywall).
    await expect(requireOwnerFeature(testEnv, 'org', orgId, 'analysis_title_vi')).resolves.toBe('agency');
  });

  it('is idempotent while live and refuses a fresh trial once the org has used one', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ ownerId: user.id });

    const first = await startOrgTrial(testEnv, { orgId, userId: user.id });
    // Repeat while the trial is still running → same state, no error.
    const again = await startOrgTrial(testEnv, { orgId, userId: user.id });
    expect(again.trialEndsAt).toBe(first.trialEndsAt);

    // Simulate the trial having reverted to free (marker persists).
    await env.DB.prepare(`UPDATE organization SET plan = 'free', plan_expires_at = NULL WHERE id = ?`)
      .bind(orgId)
      .run();
    await expect(startOrgTrial(testEnv, { orgId, userId: user.id })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
  });

  it('refuses a second trial for the same user on a different org (anti-farming)', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgA = await seedOrg({ ownerId: user.id });
    const orgB = await seedOrg({ ownerId: user.id });

    await startOrgTrial(testEnv, { orgId: orgA, userId: user.id });
    await expect(startOrgTrial(testEnv, { orgId: orgB, userId: user.id })).rejects.toMatchObject({
      status: 409,
    });

    // orgB stays free and unstarted — the user can't farm a fresh org.
    const orgB2 = await readOrg(orgB);
    expect(orgB2?.plan).toBe('free');
    expect(orgB2?.trial_started_at).toBeNull();
  });

  it('refuses a trial on an org that already has a plan', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ plan: 'agency', ownerId: user.id });
    await expect(startOrgTrial(testEnv, { orgId, userId: user.id })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('trial expiry + conversion', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('the cron reverts an expired trial to free but keeps the eligibility marker', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ ownerId: user.id });
    await startOrgTrial(testEnv, { orgId, userId: user.id });

    // Fast-forward the expiry into the past.
    const past = Date.now() - 1000;
    await env.DB.prepare(`UPDATE organization SET plan_expires_at = ?, trial_ends_at = ? WHERE id = ?`)
      .bind(past, past, orgId)
      .run();

    const summary = await expireEnterpriseGrants(testEnv);
    expect(summary.orgs).toBeGreaterThanOrEqual(1);

    const org = await readOrg(orgId);
    expect(org?.plan).toBe('free');
    expect(org?.plan_expires_at).toBeNull();
    // Marker persists so the org is not eligible again.
    expect(org?.trial_started_at).not.toBeNull();
    await expect(startOrgTrial(testEnv, { orgId, userId: user.id })).rejects.toMatchObject({ status: 409 });
  });

  it('a paid conversion clears plan_expires_at so the cron never downgrades the paying org', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ ownerId: user.id });
    await startOrgTrial(testEnv, { orgId, userId: user.id });

    // A real active subscription webhook lands for this org.
    const nowSec = Math.floor(Date.now() / 1000);
    const sub = {
      id: 'sub_test1',
      customer: 'cus_test1',
      status: 'active',
      metadata: { owner_type: 'org', owner_id: orgId, target_plan: 'agency' },
      items: {
        data: [
          {
            price: { id: 'price_agency_m' },
            quantity: 1,
            current_period_start: nowSec,
            current_period_end: nowSec + 30 * 24 * 3600,
          },
        ],
      },
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
    } as unknown as Stripe.Subscription;
    const convEnv = { ...env, STRIPE_PRICE_TEAM_MONTHLY: 'price_agency_m' } as unknown as Env;

    await syncSubscription(convEnv, sub);

    const afterConv = await readOrg(orgId);
    expect(afterConv?.plan).toBe('agency');
    expect(afterConv?.plan_status).toBe('active');
    // The fix: a paid subscriber must never carry an expiry.
    expect(afterConv?.plan_expires_at).toBeNull();

    // Even with the old trial-end now in the past, the cron leaves them alone.
    await expireEnterpriseGrants(convEnv);
    const finalOrg = await readOrg(orgId);
    expect(finalOrg?.plan).toBe('agency');
  });
});

describe('runTrialEndingReminders', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('emails the org owner once (no-card copy) when a trial ends within 3 days', async () => {
    const user = await seedUser({ plan: 'free', email: 'owner-trial@example.com' });
    const orgId = await seedOrg({ ownerId: user.id });
    await startOrgTrial(testEnv, { orgId, userId: user.id });
    // Bring the trial end to ~2 days out.
    const soon = Date.now() + 2 * DAY;
    await env.DB.prepare(`UPDATE organization SET trial_ends_at = ?, plan_expires_at = ? WHERE id = ?`)
      .bind(soon, soon, orgId)
      .run();

    const r1 = await runTrialEndingReminders(testEnv);
    expect(r1.sent).toBe(1);
    expect(capture.emails).toHaveLength(1);
    const m = capture.emails[0];
    expect(m.to).toBe('owner-trial@example.com');
    expect(m.subject).toContain('Planner trial ends');
    // No-card variant: mentions no credit card, never the Stripe "card on file
    // will be charged" copy.
    expect(m.text.toLowerCase()).toContain('no credit card on file');
    expect(m.text).not.toContain('card on file will be charged');

    // Idempotent: a second daily run does not re-send.
    const r2 = await runTrialEndingReminders(testEnv);
    expect(r2.sent).toBe(0);
    expect(capture.emails).toHaveLength(1);
  });

  it('does not remind a trial that is more than 3 days out', async () => {
    const user = await seedUser({ plan: 'free' });
    const orgId = await seedOrg({ ownerId: user.id });
    await startOrgTrial(testEnv, { orgId, userId: user.id }); // ~14 days out
    const r = await runTrialEndingReminders(testEnv);
    expect(r.sent).toBe(0);
    expect(capture.emails).toHaveLength(0);
  });
});
