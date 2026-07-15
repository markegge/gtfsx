// /api/events/track — cookieless analytics ingestion. Asserts the gclid
// (Google Ads click identifier) and gclid-free flows both persist correctly.
// See worker/migrations/0014_gclid.sql + docs/GOOGLE_ADS_PLAN.md §2.2.

import { beforeEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import { applyMigrations, dbAll, dbGet, dbRun, resetDb } from './_setup';

interface EventRow {
  id: string;
  kind: string;
  path: string;
  ref: string | null;
  session_id: string;
  label: string | null;
  gclid: string | null;
}

describe('/api/events/track gclid persistence', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    // resetDb() in _setup.ts doesn't truncate `event` (analytics rows live
    // outside the user/project graph) — wipe it here for deterministic state.
    await dbRun(`DELETE FROM event`);
  });

  it('persists gclid when supplied', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'feed_exported',
      path: '/learn/gtfs-flex/',
      ref: null,
      sessionId: 'sess-with-gclid-12345',
      gclid: 'EAIaIQobChMItest_gclid_123',
    });
    expect(res.status).toBe(204);

    const rows = await dbAll<EventRow>(`SELECT * FROM event`);
    expect(rows).toHaveLength(1);
    expect(rows[0].gclid).toBe('EAIaIQobChMItest_gclid_123');
    expect(rows[0].kind).toBe('feed_exported');
  });

  it('stores NULL gclid when client omits the field', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'page_view',
      path: '/',
      ref: null,
      sessionId: 'sess-no-gclid-12345',
    });
    expect(res.status).toBe(204);

    const row = await dbGet<EventRow>(`SELECT * FROM event`);
    expect(row).not.toBeNull();
    expect(row!.gclid).toBeNull();
  });

  it('stores NULL gclid when client passes gclid: null', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'page_view',
      path: '/',
      ref: null,
      sessionId: 'sess-null-gclid-12345',
      gclid: null,
    });
    expect(res.status).toBe(204);

    const row = await dbGet<EventRow>(`SELECT * FROM event`);
    expect(row!.gclid).toBeNull();
  });

  it('accepts kind=demo_request (parity with the /book-demo lead-form writer)', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'demo_request',
      path: '/book-demo',
      ref: null,
      sessionId: 'sess-demo-kind-12345',
    });
    expect(res.status).toBe(204);

    const row = await dbGet<EventRow>(`SELECT * FROM event`);
    expect(row!.kind).toBe('demo_request');
  });

  it('rejects gclid longer than 256 chars', async () => {
    const client = makeClient();
    const res = await client.post('/api/events/track', {
      kind: 'page_view',
      path: '/',
      ref: null,
      sessionId: 'sess-toolong-12345',
      gclid: 'x'.repeat(257),
    });
    expect(res.status).toBe(422);
  });

  it('end-to-end: gclid captured on landing forwards to feed_exported on a later route', async () => {
    // Simulates the full Phase-1 happy path: a single session_id holds the
    // gclid across two events (page_view on landing → feed_exported later).
    const client = makeClient();
    const sessionId = 'sess-e2e-gclid-12345';
    const gclid = 'test_123';

    const pv = await client.post('/api/events/track', {
      kind: 'page_view',
      path: '/learn/gtfs-flex/',
      ref: null,
      sessionId,
      gclid,
    });
    expect(pv.status).toBe(204);

    const exp = await client.post('/api/events/track', {
      kind: 'feed_exported',
      path: '/',
      ref: null,
      sessionId,
      gclid,
    });
    expect(exp.status).toBe(204);

    const rows = await dbAll<EventRow>(
      `SELECT kind, gclid FROM event WHERE session_id = ? ORDER BY ts`,
      sessionId,
    );
    expect(rows.map((r) => r.kind)).toEqual(['page_view', 'feed_exported']);
    expect(rows.every((r) => r.gclid === 'test_123')).toBe(true);
  });
});
