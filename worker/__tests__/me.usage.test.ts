// /api/me/usage — quota counter sanity.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

describe('/api/me/usage', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('reflects the number of projects and versions', async () => {
    const client = await loggedInClient('usage1@example.com');

    // Start: all zero.
    const initial = await client.json<{
      user: { projects: number; versions: number; storageBytes: number };
    }>(await client.get('/api/me/usage'));
    expect(initial.user.projects).toBe(0);
    expect(initial.user.versions).toBe(0);
    expect(initial.user.storageBytes).toBe(0);

    // Create two projects, push a working-state blob into one, and add a version.
    const a = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Feed A' }),
    );
    await client.post('/api/projects', { name: 'Feed B' });

    const wsBody = await gzip(JSON.stringify({ routes: [] }));
    const put = await client.put(`/api/projects/${a.id}/working-state`, undefined, {
      body: wsBody,
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
    });
    expect(put.status).toBe(200);

    const form = new FormData();
    const vBody = await gzip(JSON.stringify({ v: 1 }));
    form.append('state', new Blob([vBody], { type: 'application/json' }), 'state.json.gz');
    form.append(
      'meta',
      JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }),
    );
    const vRes = await client.post(`/api/projects/${a.id}/versions`, undefined, { body: form });
    expect(vRes.status).toBe(200);

    const after = await client.json<{
      user: { projects: number; versions: number; storageBytes: number };
    }>(await client.get('/api/me/usage'));
    expect(after.user.projects).toBe(2);
    expect(after.user.versions).toBe(1);
    expect(after.user.storageBytes).toBeGreaterThan(0);
  });

  it('GET /api/me includes a usage field', async () => {
    const client = await loggedInClient('usage-me@example.com');
    await client.post('/api/projects', { name: 'Feed X' });

    const me = await client.json<{ usage: { user: { projects: number } } | null }>(
      await client.get('/api/me'),
    );
    expect(me.usage).not.toBeNull();
    expect(me.usage?.user.projects).toBe(1);
  });
});
