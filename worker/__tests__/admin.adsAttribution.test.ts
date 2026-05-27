// /api/admin/events/ads-attribution — the gclid reconciliation table.
// Asserts: server-rendered HTML, grouping by ISO week + kind, sample gclid
// list, gclid-less events excluded, staff-only access.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function staffClient() {
  const user = await seedUser({ email: 'staff@example.com', staff: true });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, user };
}

async function seedEvent(opts: {
  ts?: number;
  kind?: string;
  path?: string;
  sessionId?: string;
  gclid?: string | null;
}) {
  const ts = opts.ts ?? Date.now();
  await dbRun(
    `INSERT INTO event (id, ts, kind, path, ref, session_id, country, label, gclid)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
    ulid(),
    ts,
    opts.kind ?? 'page_view',
    opts.path ?? '/',
    opts.sessionId ?? `sess-${ulid()}`,
    opts.gclid ?? null,
  );
}

describe('/api/admin/events/ads-attribution', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    // resetDb() doesn't truncate `event` (analytics rows live outside the
    // user/project graph). Clear it here so each test starts clean.
    await dbRun(`DELETE FROM event`);
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('non-staff is rejected (404)', async () => {
    const user = await seedUser({ email: 'nonstaff@example.com', staff: false });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    const res = await client.get('/api/admin/events/ads-attribution');
    expect(res.status).toBe(404);
  });

  it('renders empty-state HTML when no gclid-stamped events exist', async () => {
    const { client } = await staffClient();
    // Seed a gclid-less event — it must NOT appear in the table.
    await seedEvent({ kind: 'page_view', gclid: null });

    const res = await client.get('/api/admin/events/ads-attribution');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Google Ads attribution');
    expect(body).toContain('No gclid-stamped events yet');
  });

  it('groups by ISO week + kind, lists samples, omits gclid-less events', async () => {
    const { client } = await staffClient();

    // Pick two distinct calendar weeks far enough apart that strftime('%W')
    // gives different week numbers regardless of when the test runs.
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    // Week A: 3 feed_exported events with distinct gclids + 1 paywall_view.
    await seedEvent({ ts: now, kind: 'feed_exported', gclid: 'gclid_A1' });
    await seedEvent({ ts: now - 1000, kind: 'feed_exported', gclid: 'gclid_A2' });
    await seedEvent({ ts: now - 2000, kind: 'feed_exported', gclid: 'gclid_A3' });
    await seedEvent({ ts: now - 3000, kind: 'paywall_view', gclid: 'gclid_AP1' });
    // Same week, no gclid — must be excluded.
    await seedEvent({ ts: now - 4000, kind: 'feed_exported', gclid: null });

    // Week B: 1 feed_exported event with gclid.
    await seedEvent({ ts: sevenDaysAgo, kind: 'feed_exported', gclid: 'gclid_B1' });

    const res = await client.get('/api/admin/events/ads-attribution');
    expect(res.status).toBe(200);
    const body = await res.text();

    // Aggregations: 3 for the current-week feed_exported group, 1 for the
    // paywall group, 1 for the prior-week feed_exported group.
    expect(body).toContain('gclid_A1');
    expect(body).toContain('gclid_A2');
    expect(body).toContain('gclid_A3');
    expect(body).toContain('gclid_AP1');
    expect(body).toContain('gclid_B1');

    // The current-week feed_exported group should appear before the older one
    // (week DESC) and before the smaller paywall group within the same week
    // (count DESC within week).
    const idxA = body.indexOf('gclid_A1');
    const idxAP = body.indexOf('gclid_AP1');
    const idxB = body.indexOf('gclid_B1');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxAP);
    expect(idxAP).toBeLessThan(idxB);

    // Empty-state copy must NOT appear when we have data.
    expect(body).not.toContain('No gclid-stamped events yet');

    // Sanity: HTML-escapes the gclid (no raw < or > in samples — Google
    // gclids are URL-safe so this is a defense-in-depth check).
    expect(body).not.toMatch(/<script/i);
  });

  it('caps the sample-gclid list at 5 per group', async () => {
    const { client } = await staffClient();

    const now = Date.now();
    for (let i = 0; i < 7; i++) {
      await seedEvent({ ts: now - i * 1000, kind: 'feed_exported', gclid: `gclid_${i}` });
    }

    const res = await client.get('/api/admin/events/ads-attribution');
    expect(res.status).toBe(200);
    const body = await res.text();

    // 5 most recent should appear; the 2 oldest should not.
    expect(body).toContain('gclid_0');
    expect(body).toContain('gclid_4');
    expect(body).not.toContain('gclid_5');
    expect(body).not.toContain('gclid_6');
  });
});
