// /api/projects/:id/catalog-submissions — opt-in / opt-out / list, plus
// the auto-submission on publish.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

async function createVersion(client: TestClient, projectId: string): Promise<{ version: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify({}));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.json(await client.post(`/api/projects/${projectId}/versions`, undefined, { body: form }));
}

describe('/api/projects/:id/catalog-submissions', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => {
    capture.restore();
    vi.restoreAllMocks();
  });

  it('opt in to mobility_db → row created with status=pending', async () => {
    const client = await loggedInClient('cat1@example.com');
    const proj = await createProject(client, 'CatFeed');
    const res = await client.json<{ submission: { catalog: string; status: string } }>(
      await client.post(`/api/projects/${proj.id}/catalog-submissions`, { catalog: 'mobility_db' }),
    );
    expect(res.submission.catalog).toBe('mobility_db');
    expect(res.submission.status).toBe('pending');
  });

  it('list returns both current opt-ins', async () => {
    const client = await loggedInClient('cat2@example.com');
    const proj = await createProject(client, 'Cat2');
    await client.post(`/api/projects/${proj.id}/catalog-submissions`, { catalog: 'mobility_db' });
    await client.post(`/api/projects/${proj.id}/catalog-submissions`, { catalog: 'transit_land' });

    const list = await client.json<{ submissions: { catalog: string }[] }>(
      await client.get(`/api/projects/${proj.id}/catalog-submissions`),
    );
    expect(list.submissions.map((s) => s.catalog).sort()).toEqual(['mobility_db', 'transit_land']);
  });

  it('opt out → row deleted', async () => {
    const client = await loggedInClient('cat3@example.com');
    const proj = await createProject(client, 'Cat3');
    await client.post(`/api/projects/${proj.id}/catalog-submissions`, { catalog: 'mobility_db' });

    const del = await client.delete(`/api/projects/${proj.id}/catalog-submissions/mobility_db`);
    expect(del.status).toBe(204);
    const list = await client.json<{ submissions: unknown[] }>(
      await client.get(`/api/projects/${proj.id}/catalog-submissions`),
    );
    expect(list.submissions).toEqual([]);
  });

  it('auto-submits to mobility_db on publish when opted in', async () => {
    const client = await loggedInClient('cat4@example.com');
    const proj = await createProject(client, 'Cat4');
    const v = await createVersion(client, proj.id);
    await client.post(`/api/projects/${proj.id}/catalog-submissions`, { catalog: 'mobility_db' });

    // Intercept the outbound Mobility DB fetch (leave Resend capture in place).
    const mdCalls: { url: string; method: string }[] = [];
    const original = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://api.mobilitydatabase.org/v1/tokens')) {
        return new Response(JSON.stringify({ access_token: 'test-access', expires_in: 3600 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.mobilitydatabase.org/v1/gtfs_feeds')) {
        mdCalls.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
        return new Response(JSON.stringify({ id: 'mdb-feed-123' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return original(input as RequestInfo, init);
    });

    const form = new FormData();
    form.append('meta', JSON.stringify({ versionId: v.version.id }));
    form.append('zip', new Blob([new Uint8Array([1])], { type: 'application/zip' }), 'g.zip');
    const pubRes = await client.post(`/api/projects/${proj.id}/publish`, undefined, { body: form });
    expect(pubRes.status).toBe(200);

    // Poll the DB briefly for the background submission to land. The handler
    // uses ctx.waitUntil, so we retry a few times.
    let status = 'pending';
    let externalFeedId: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const list = await client.json<{
        submissions: { catalog: string; status: string; externalFeedId: string | null }[];
      }>(await client.get(`/api/projects/${proj.id}/catalog-submissions`));
      const row = list.submissions.find((s) => s.catalog === 'mobility_db');
      if (row) {
        status = row.status;
        externalFeedId = row.externalFeedId;
        if (status === 'active') break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(mdCalls.length).toBeGreaterThan(0);
    expect(mdCalls.some((c) => c.method === 'POST')).toBe(true);
    expect(status).toBe('active');
    expect(externalFeedId).toBe('mdb-feed-123');
  });
});
