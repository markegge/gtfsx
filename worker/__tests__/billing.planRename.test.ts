// Guards the May-2026 internal rename of the plan identifier 'team' -> 'agency'.
//
//   1. The Stripe webhook reverse-lookup (planFromPriceId) must resolve the
//      Agency price IDs to the NEW internal value 'agency'. The env var NAMES
//      (STRIPE_PRICE_TEAM_*) intentionally stayed; only the returned plan moved.
//   2. The 0017 data migration must rewrite every persisted plan='team' row on
//      user / organization / subscription to 'agency' (clean cutover — there is
//      no read-time fallback, so the data migration is the only correctness
//      mechanism). Non-'team' plans must be left untouched.

import { describe, expect, it, beforeEach } from 'vitest';
import { ulid } from 'ulidx';
import type { Env } from '../env';
import { planFromPriceId } from '../billing/stripe';
import { applyMigrations, dbGet, dbRun, env as testEnv, resetDb } from './_setup';

describe('planFromPriceId returns the renamed internal plan', () => {
  // planFromPriceId only reads price-ID env vars, so a hand-built env suffices.
  const env = {
    STRIPE_PRICE_TEAM_MONTHLY: 'price_agency_m',
    STRIPE_PRICE_TEAM_ANNUAL: 'price_agency_a',
  } as unknown as Env;

  it('maps the Agency (team-named env var) price IDs to "agency"', () => {
    expect(planFromPriceId(env, 'price_agency_m')).toBe('agency');
    expect(planFromPriceId(env, 'price_agency_a')).toBe('agency');
  });

  it('maps unknown IDs (incl. the retired Pro prices) to null, never throws', () => {
    expect(planFromPriceId(env, 'price_pro_m')).toBeNull();
    expect(planFromPriceId(env, 'price_unknown')).toBeNull();
  });
});

describe('0017 migration rewrites persisted team plans to agency', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Re-run the actual 0017 migration SQL against freshly-seeded 'team' rows.
  // applyMigrations() already ran every migration at file setup (idempotent —
  // the tables were empty then), so we replay 0017's queries here to exercise
  // its effect on a pre-existing 'team' row, exactly as a deploy would.
  async function runRenameMigration(): Promise<void> {
    await applyMigrations();
    const migration = testEnv.TEST_MIGRATIONS.find((m) => m.name.includes('0017'));
    if (!migration) throw new Error('0017 rename migration not found in TEST_MIGRATIONS');
    for (const query of migration.queries) {
      await testEnv.DB.prepare(query).run();
    }
  }

  it('updates a pre-existing plan="team" row to "agency" on all three tables', async () => {
    const now = Date.now();
    const userId = ulid();
    const orgId = ulid();
    const subId = ulid();

    await dbRun(
      `INSERT INTO user (id, email, display_name, status, staff, plan, created_at, updated_at)
       VALUES (?, ?, 'Legacy Agency', 'active', 0, 'team', ?, ?)`,
      userId, `legacy-${userId}@example.com`, now, now,
    );
    await dbRun(
      `INSERT INTO organization (id, slug, name, created_at, plan, plan_status)
       VALUES (?, ?, 'Legacy Org', ?, 'team', 'active')`,
      orgId, `legacy-${orgId}`, now,
    );
    await dbRun(
      `INSERT INTO subscription
         (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id,
          stripe_price_id, plan, status, current_period_start, current_period_end,
          created_at, updated_at)
       VALUES (?, 'org', ?, ?, ?, 'price_agency_m', 'team', 'active', ?, ?, ?, ?)`,
      subId, orgId, `sub_${subId}`, `cus_${orgId}`, now, now + 1, now, now,
    );

    await runRenameMigration();

    const user = await dbGet<{ plan: string }>(`SELECT plan FROM user WHERE id = ?`, userId);
    const org = await dbGet<{ plan: string }>(`SELECT plan FROM organization WHERE id = ?`, orgId);
    const sub = await dbGet<{ plan: string }>(`SELECT plan FROM subscription WHERE id = ?`, subId);

    expect(user?.plan).toBe('agency');
    expect(org?.plan).toBe('agency');
    expect(sub?.plan).toBe('agency');
  });

  it('leaves non-team plans untouched', async () => {
    const now = Date.now();
    const entId = ulid();
    const freeId = ulid();
    await dbRun(
      `INSERT INTO user (id, email, display_name, status, staff, plan, created_at, updated_at)
       VALUES (?, ?, 'Ent', 'active', 0, 'enterprise', ?, ?)`,
      entId, `ent-${entId}@example.com`, now, now,
    );
    await dbRun(
      `INSERT INTO user (id, email, display_name, status, staff, plan, created_at, updated_at)
       VALUES (?, ?, 'Free', 'active', 0, 'free', ?, ?)`,
      freeId, `free-${freeId}@example.com`, now, now,
    );

    await runRenameMigration();

    const ent = await dbGet<{ plan: string }>(`SELECT plan FROM user WHERE id = ?`, entId);
    const free = await dbGet<{ plan: string }>(`SELECT plan FROM user WHERE id = ?`, freeId);
    expect(ent?.plan).toBe('enterprise');
    expect(free?.plan).toBe('free');
  });
});
