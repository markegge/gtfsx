// /api/me/export — per-user ZIP download containing profile, audit, and
// owned-project blobs.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

describe('/api/me/export', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('returns a ZIP containing profile.json, audit.json, and the user\'s project data', async () => {
    const { client } = await loggedInClient('export1@example.com');

    // Create a project and a working-state blob, then a version.
    const proj = await client.json<{ id: string; slug: string }>(
      await client.post('/api/projects', { name: 'Export Me' }),
    );
    const stateBody = await gzip(JSON.stringify({ routes: [{ id: 'r1' }] }));
    const putRes = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: stateBody,
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
    });
    expect(putRes.status).toBe(200);

    // Post a version.
    const form = new FormData();
    const vBody = await gzip(JSON.stringify({ version: 'v1' }));
    form.append('state', new Blob([vBody], { type: 'application/json' }), 'state.json.gz');
    form.append(
      'meta',
      JSON.stringify({ label: 'initial', summary: { routes: 1 }, validationErrors: 0, validationWarnings: 0 }),
    );
    const snapshotRes = await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: form });
    const snapshotBody = await client.json<{ snapshot: { id: string } }>(snapshotRes);
    const snapshotId = snapshotBody.snapshot.id;

    // Now request the export.
    const res = await client.get('/api/me/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment; filename=".*\.zip"/);

    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
    const zip = await JSZip.loadAsync(buf);

    // profile.json
    const profileFile = zip.file('profile.json');
    expect(profileFile).not.toBeNull();
    const profile = JSON.parse(await profileFile!.async('string')) as {
      user: { email: string } | null;
    };
    expect(profile.user?.email).toBe('export1@example.com');

    // audit.json
    const auditFile = zip.file('audit.json');
    expect(auditFile).not.toBeNull();
    const audit = JSON.parse(await auditFile!.async('string')) as {
      events: { action: string }[];
    };
    expect(audit.events.some((e) => e.action === 'project.create')).toBe(true);

    // projects/<slug>/working-state.json — decoded (not gzipped)
    const wsFile = zip.file(`projects/${proj.slug}/working-state.json`);
    expect(wsFile).not.toBeNull();
    const ws = JSON.parse(await wsFile!.async('string')) as { routes: { id: string }[] };
    expect(ws.routes[0].id).toBe('r1');

    // projects/<slug>/snapshots/<vid>/state.json
    const vStateFile = zip.file(`projects/${proj.slug}/snapshots/${snapshotId}/state.json`);
    expect(vStateFile).not.toBeNull();
    const vState = JSON.parse(await vStateFile!.async('string')) as { version: string };
    expect(vState.version).toBe('v1');

    // projects/<slug>/snapshots/<vid>/summary.json
    const summaryFile = zip.file(`projects/${proj.slug}/snapshots/${snapshotId}/summary.json`);
    expect(summaryFile).not.toBeNull();
  });

  it('rate-limits a second export within 24h to 429', async () => {
    const { client } = await loggedInClient('export-rate@example.com');
    const first = await client.get('/api/me/export');
    expect(first.status).toBe(200);
    // Drain the body so the stream settles.
    await first.arrayBuffer();

    const second = await client.get('/api/me/export');
    expect(second.status).toBe(429);
  });

  it('writes a user.data_export audit entry after export', async () => {
    const { client } = await loggedInClient('export-audit@example.com');
    const res = await client.get('/api/me/export');
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    const audit = await client.json<{ events: { action: string }[] }>(
      await client.get('/api/me/audit'),
    );
    expect(audit.events.some((e) => e.action === 'user.data_export')).toBe(true);
  });
});
