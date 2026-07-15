// /api/admin/events/oci-status — HTML status page for the Offline Conversion
// Import uploader. Asserts: pending/uploaded/failed counts render, config
// banner reflects env state, staff-only access. /events/oci-run smoke-tests
// the manual trigger path.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulidx';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbRun,
  env as testEnv,
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
  gclid?: string | null;
  oci_uploaded_at?: number | null;
  oci_attempts?: number;
  oci_last_error?: string | null;
}) {
  const now = Date.now();
  await dbRun(
    `INSERT INTO event (id, ts, kind, path, ref, session_id, country, label, gclid, oci_uploaded_at, oci_attempts, oci_last_error)
     VALUES (?, ?, ?, '/', NULL, ?, NULL, NULL, ?, ?, ?, ?)`,
    ulid(),
    opts.ts ?? now - 1000,
    opts.kind ?? 'feed_exported',
    `sess-${ulid()}`,
    opts.gclid ?? null,
    opts.oci_uploaded_at ?? null,
    opts.oci_attempts ?? 0,
    opts.oci_last_error ?? null,
  );
}

const ADS_SECRET_KEYS = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
  'GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED',
  'GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW',
  'GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST',
];
function clearAdsSecrets() {
  for (const k of ADS_SECRET_KEYS) {
    delete (testEnv as unknown as Record<string, unknown>)[k];
  }
}

describe('/api/admin/events/oci-status', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearAdsSecrets();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
    clearAdsSecrets();
  });

  it('non-staff: 404', async () => {
    const u = await seedUser({ email: 'nonstaff@example.com', staff: false });
    const client = makeClient();
    await client.post('/auth/login', { email: u.email, password: u.password });
    const res = await client.get('/api/admin/events/oci-status');
    expect(res.status).toBe(404);
  });

  it('staff: renders config-missing banner when secrets absent + empty state', async () => {
    const { client } = await staffClient();
    const res = await client.get('/api/admin/events/oci-status');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type') ?? '').toContain('text/html');
    const body = await res.text();
    expect(body).toContain('not configured');
    expect(body).toContain('OCI status');
    // Pending/uploaded/failed cards render with zero totals.
    expect(body).toContain('Pending (≤90 days)');
    expect(body).toContain('Uploaded last 7 days');
    expect(body).toContain('Permanently failed');
  });

  it('staff: shows configured banner when every secret is present', async () => {
    const { client } = await staffClient();
    for (const k of ADS_SECRET_KEYS) {
      (testEnv as unknown as Record<string, string>)[k] = 'x';
    }
    const res = await client.get('/api/admin/events/oci-status');
    const body = await res.text();
    expect(body).toContain('OCI is configured');
    expect(body).not.toContain('not configured');
    // All actions present — no demo_request warning note.
    expect(body).not.toContain('GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST');
  });

  it('staff: core configured but demo action missing → configured banner plus demo note', async () => {
    const { client } = await staffClient();
    for (const k of ADS_SECRET_KEYS) {
      if (k === 'GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST') continue;
      (testEnv as unknown as Record<string, string>)[k] = 'x';
    }
    const res = await client.get('/api/admin/events/oci-status');
    const body = await res.text();
    // The page stays green for the two live kinds…
    expect(body).toContain('OCI is configured');
    // …but flags that demo_request uploads are off until the secret is set.
    expect(body).toContain('GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST');
    expect(body).toContain('uploads are <strong>off</strong>');
  });

  it('counts pending demo_request rows alongside the original kinds', async () => {
    const { client } = await staffClient();
    const now = Date.now();
    await seedEvent({ kind: 'feed_exported', gclid: 'gP1', ts: now - 5000 });
    await seedEvent({ kind: 'demo_request', gclid: 'gD1', ts: now - 6000 });
    await seedEvent({ kind: 'demo_request', gclid: 'gD2', ts: now - 7000 });

    const res = await client.get('/api/admin/events/oci-status');
    expect(res.status).toBe(200);
    const body = await res.text();
    // Pending: 1 feed_exported + 2 demo_request = 3 total.
    expect(body).toMatch(/Pending[^]*?>3</);
    expect(body).toContain('demo_request');
  });

  it('counts pending, uploaded, and permanently failed', async () => {
    const { client } = await staffClient();
    const now = Date.now();
    // Pending — gclid set, never uploaded, within 90 days, eligible kind.
    await seedEvent({ kind: 'feed_exported', gclid: 'gP1', ts: now - 5000 });
    await seedEvent({ kind: 'paywall_view', gclid: 'gP2', ts: now - 6000 });
    await seedEvent({ kind: 'paywall_view', gclid: 'gP3', ts: now - 7000 });
    // Uploaded within last 7 days.
    await seedEvent({ kind: 'feed_exported', gclid: 'gU1', oci_uploaded_at: now - 3600_000 });
    await seedEvent({ kind: 'feed_exported', gclid: 'gU2', oci_uploaded_at: now - 3600_000 });
    // Permanently failed — sentinel -1.
    await seedEvent({
      kind: 'feed_exported', gclid: 'gFail', oci_uploaded_at: -1, oci_attempts: 3,
      oci_last_error: 'stale gclid',
    });
    // Wrong kind — never appears in pending bucket.
    await seedEvent({ kind: 'editor_loaded', gclid: 'gIgnore' });

    const res = await client.get('/api/admin/events/oci-status');
    expect(res.status).toBe(200);
    const body = await res.text();

    // Pending: 1 feed_exported + 2 paywall_view = 3 total
    expect(body).toMatch(/Pending[^]*?>3</);
    // Uploaded last 7d: 2 feed_exported
    expect(body).toMatch(/Uploaded last 7 days[^]*?>2</);
    // Failed: 1
    expect(body).toMatch(/Permanently failed[^]*?>1</);

    // Failed-row table surfaces the error.
    expect(body).toContain('gFail');
    expect(body).toContain('stale gclid');
    // editor_loaded is not surfaced — it's not an upload kind.
    expect(body).not.toContain('gIgnore');
  });
});

describe('POST /api/admin/events/oci-run', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearAdsSecrets();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
    clearAdsSecrets();
  });

  it('non-staff: 404', async () => {
    const u = await seedUser({ email: 'nonstaff@example.com', staff: false });
    const client = makeClient();
    await client.post('/auth/login', { email: u.email, password: u.password });
    const res = await client.post('/api/admin/events/oci-run', {});
    expect(res.status).toBe(404);
  });

  it('staff: returns configured=false when secrets are missing (no-op)', async () => {
    const { client } = await staffClient();
    const res = await client.post('/api/admin/events/oci-run', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; attempted: number };
    expect(body.configured).toBe(false);
    expect(body.attempted).toBe(0);
  });

  it('staff: writes an audit entry recording the run', async () => {
    const { client, user } = await staffClient();
    await client.post('/api/admin/events/oci-run', {});

    const audit = await testEnv.DB.prepare(
      `SELECT action, metadata_json FROM audit_event WHERE actor_user_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(user.id).first<{ action: string; metadata_json: string }>();
    expect(audit?.action).toBe('admin.oci.run');
    expect(audit?.metadata_json).toContain('configured');
  });
});
