// worker/cron/tasks.ts → runOwnerDigest()/computeOwnerDigest(): the daily owner
// digest that replaced the per-signup BCC. Three trailing-24h numbers (new
// sign-ups, active users, new paid subs) emailed to the owner inbox.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import {
  env,
  resetDb,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { computeOwnerDigest, runOwnerDigest } from '../cron/tasks';
import type { Env } from '../env';

const DAY = 24 * 60 * 60 * 1000;

async function seedUserRow(createdAt: number): Promise<string> {
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO user (id, email, display_name, status, staff, plan, created_at, updated_at)
     VALUES (?, ?, 'X', 'active', 0, 'free', ?, ?)`,
  )
    .bind(id, `u-${id.toLowerCase()}@example.com`, createdAt, createdAt)
    .run();
  return id;
}

async function seedSession(userId: string, lastUsedAt: number): Promise<void> {
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO session (id, token_hash, user_id, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, `hash-${id}`, userId, lastUsedAt, lastUsedAt, lastUsedAt + 90 * DAY)
    .run();
}

async function seedSubscription(opts: {
  createdAt: number;
  status?: string;
  plan?: string;
}): Promise<void> {
  const id = ulid();
  const subId = `sub_${id}`;
  await env.DB.prepare(
    `INSERT INTO subscription
       (id, owner_type, owner_id, stripe_subscription_id, stripe_customer_id, stripe_price_id,
        plan, status, quantity, current_period_start, current_period_end,
        cancel_at_period_end, canceled_at, trial_end, created_at, updated_at)
     VALUES (?, 'user', ?, ?, ?, 'price_x', ?, ?, 1, ?, ?, 0, NULL, NULL, ?, ?)`,
  )
    .bind(
      id,
      ulid(),
      subId,
      `cus_${id}`,
      opts.plan ?? 'pro',
      opts.status ?? 'active',
      opts.createdAt,
      opts.createdAt + 30 * DAY,
      opts.createdAt,
      opts.createdAt,
    )
    .run();
}

describe('owner daily digest', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await resetDb();
    // resetDb() doesn't touch the billing tables; clear subscriptions so the
    // trailing-24h counts are deterministic across tests.
    await env.DB.prepare(`DELETE FROM subscription`).run();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('counts trailing-24h sign-ups, active users, and new paid subs', async () => {
    const now = Date.now();
    // Sign-ups: 2 inside the window, 1 older.
    await seedUserRow(now - 2 * 60 * 60 * 1000);
    const recentUser = await seedUserRow(now - 10 * 60 * 60 * 1000);
    const oldUser = await seedUserRow(now - 5 * DAY);

    // Active users (distinct sessions used in 24h): recentUser used twice (still
    // 1 distinct), oldUser used once → 2 distinct active users.
    await seedSession(recentUser, now - 1 * 60 * 60 * 1000);
    await seedSession(recentUser, now - 3 * 60 * 60 * 1000);
    await seedSession(oldUser, now - 6 * 60 * 60 * 1000);
    // A stale session (older than 24h) must NOT count.
    await seedSession(oldUser, now - 3 * DAY);

    // Paid subs: 1 new in window, 1 older.
    await seedSubscription({ createdAt: now - 4 * 60 * 60 * 1000, status: 'active' });
    await seedSubscription({ createdAt: now - 10 * DAY, status: 'active' });

    const m = await computeOwnerDigest(env as unknown as Env);
    expect(m.signups24h).toBe(2);
    expect(m.activeUsers24h).toBe(2);
    expect(m.newPaidSubs24h).toBe(1);
    expect(m.totalUsers).toBe(3);
    expect(m.activePaidSubs).toBe(2);
  });

  it('emails the owner inbox (falls back to OWNER_NOTIFY_EMAIL) with the headline numbers', async () => {
    const now = Date.now();
    await seedUserRow(now - 1 * 60 * 60 * 1000);
    const u = await seedUserRow(now - 2 * 60 * 60 * 1000);
    await seedSession(u, now - 30 * 60 * 1000);
    await seedSubscription({ createdAt: now - 1 * 60 * 60 * 1000, status: 'trialing' });

    const result = await runOwnerDigest(env as unknown as Env);
    expect(result.sent).toBe(true);
    expect(capture.emails).toHaveLength(1);
    const mail = capture.emails[0];
    expect(mail.to).toBe('owner@example.com'); // falls back to OWNER_NOTIFY_EMAIL
    expect(mail.subject).toContain('2 new');
    expect(mail.subject).toContain('1 active');
    expect(mail.subject).toContain('1 paid');
    expect(mail.text).toContain('New sign-ups (24h):          2');
    expect(mail.text).toContain('New paid subscriptions (24h): 1');
  });

  it('honors the OWNER_DIGEST_EMAIL override', async () => {
    const overrideEnv = { ...env, OWNER_DIGEST_EMAIL: 'digest@gtfsx.com' } as unknown as Env;
    const result = await runOwnerDigest(overrideEnv);
    expect(result.sent).toBe(true);
    expect(capture.emails[0].to).toBe('digest@gtfsx.com');
  });

  it('is a no-op when OWNER_DIGEST_ENABLED="false"', async () => {
    const offEnv = { ...env, OWNER_DIGEST_ENABLED: 'false' } as unknown as Env;
    const result = await runOwnerDigest(offEnv);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(capture.emails).toHaveLength(0);
  });

  it('is a no-op when no recipient is configured', async () => {
    const noOwnerEnv = {
      ...env,
      OWNER_NOTIFY_EMAIL: undefined,
      OWNER_DIGEST_EMAIL: undefined,
    } as unknown as Env;
    const result = await runOwnerDigest(noOwnerEnv);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('no-recipient');
    expect(capture.emails).toHaveLength(0);
  });
});
