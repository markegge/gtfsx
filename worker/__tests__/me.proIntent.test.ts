// POST /api/me/pro-intent — the authed warm-lead signal recorder.
// FROZEN CONTRACT: { action: enum, source?: string<=64 } → 204, one row inserted.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string, plan: 'free' | 'agency' = 'free'): Promise<TestClient> {
  const user = await seedUser({ email, plan });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return client;
}

interface ProIntentRow {
  id: string;
  user_id: string;
  ts: number;
  action: string;
  source: string | null;
}

describe('POST /api/me/pro-intent', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('inserts one row and returns 204 (with source)', async () => {
    const client = await loggedInClient('intent1@example.com');

    const before = Date.now();
    const res = await client.post('/api/me/pro-intent', { action: 'feed_cap', source: 'projects_panel' });
    expect(res.status).toBe(204);
    const after = Date.now();

    const rows = await dbAll<ProIntentRow>(`SELECT * FROM pro_intent`);
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('feed_cap');
    expect(rows[0].source).toBe('projects_panel');
    expect(rows[0].ts).toBeGreaterThanOrEqual(before);
    expect(rows[0].ts).toBeLessThanOrEqual(after);
    expect(rows[0].user_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(rows[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('source is optional (omitted → NULL)', async () => {
    const client = await loggedInClient('intent2@example.com');
    const res = await client.post('/api/me/pro-intent', { action: 'publish_intent' });
    expect(res.status).toBe(204);

    const rows = await dbAll<ProIntentRow>(`SELECT * FROM pro_intent`);
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('publish_intent');
    expect(rows[0].source).toBeNull();
  });

  it('accepts every contract action and is non-idempotent (multiple fires accumulate)', async () => {
    const client = await loggedInClient('intent3@example.com');
    const actions = ['publish_intent', 'feed_cap', 'mini_site', 'mdb_submit', 'checkout_started'];
    for (const action of actions) {
      const res = await client.post('/api/me/pro-intent', { action });
      expect(res.status, action).toBe(204);
    }
    // Fire one twice — both should persist (no idempotency).
    await client.post('/api/me/pro-intent', { action: 'checkout_started' });

    const rows = await dbAll<ProIntentRow>(`SELECT action FROM pro_intent`);
    expect(rows.length).toBe(actions.length + 1);
  });

  it('rejects an unknown action (422 validation_failed) and writes nothing', async () => {
    const client = await loggedInClient('intent4@example.com');
    const res = await client.post('/api/me/pro-intent', { action: 'free_money' });
    expect(res.status).toBe(422); // shared validationFailed() helper

    const rows = await dbAll<ProIntentRow>(`SELECT * FROM pro_intent`);
    expect(rows.length).toBe(0);
  });

  it('rejects an over-long source (>64) with 422', async () => {
    const client = await loggedInClient('intent5@example.com');
    const res = await client.post('/api/me/pro-intent', { action: 'feed_cap', source: 'x'.repeat(65) });
    expect(res.status).toBe(422);
    const rows = await dbAll<ProIntentRow>(`SELECT * FROM pro_intent`);
    expect(rows.length).toBe(0);
  });

  it('requires authentication (401 when logged out)', async () => {
    const client = makeClient();
    const res = await client.post('/api/me/pro-intent', { action: 'feed_cap' });
    expect(res.status).toBe(401);
  });
});
