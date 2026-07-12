// GH #68 — recordCheckoutStarted(): the server-side upgrade-path-start signal.
// The full POST /checkout route can't run in the worker test pool (no
// STRIPE_SECRET_KEY, fixed at pool boot, so billingReady() is false), so we
// unit-test the extracted helper directly: it writes a `checkout_started`
// pro_intent row, and it swallows DB errors so a logging failure can never
// break checkout.

import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../env';
import { recordCheckoutStarted } from '../billing/routes';
import { applyMigrations, dbAll, resetDb, seedUser } from './_setup';

interface ProIntentRow {
  id: string;
  user_id: string;
  ts: number;
  action: string;
  source: string | null;
}

describe('recordCheckoutStarted (GH #68 funnel signal)', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('writes one checkout_started row with plan_interval as source', async () => {
    const user = await seedUser({ email: 'checkout1@example.com', plan: 'free' });

    const before = Date.now();
    await recordCheckoutStarted(env as unknown as Env, user.id, 'agency', 'month');
    const after = Date.now();

    const rows = await dbAll<ProIntentRow>(`SELECT * FROM pro_intent`);
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('checkout_started');
    expect(rows[0].source).toBe('agency_month');
    expect(rows[0].user_id).toBe(user.id);
    expect(rows[0].ts).toBeGreaterThanOrEqual(before);
    expect(rows[0].ts).toBeLessThanOrEqual(after);
    expect(rows[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
  });

  it('encodes the agency/year combination in source', async () => {
    const user = await seedUser({ email: 'checkout2@example.com', plan: 'free' });
    await recordCheckoutStarted(env as unknown as Env, user.id, 'agency', 'year');
    const rows = await dbAll<ProIntentRow>(`SELECT source FROM pro_intent`);
    expect(rows[0].source).toBe('agency_year');
  });

  it('swallows DB errors — never throws so checkout is never blocked', async () => {
    const badEnv = {
      DB: {
        prepare() {
          throw new Error('database unavailable');
        },
      },
    } as unknown as Env;

    await expect(
      recordCheckoutStarted(badEnv, 'someuser', 'agency', 'month'),
    ).resolves.toBeUndefined();
  });
});
