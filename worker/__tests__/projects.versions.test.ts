// /api/projects/:id/versions — create via multipart, list, fetch state,
// restore to working state, delete.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  ungzip,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string) {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function postVersion(
  client: ReturnType<typeof makeClient>,
  projectId: string,
  state: unknown,
  meta: Record<string, unknown>,
): Promise<{ version: { id: string; label: string | null } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify(meta));
  const res = await client.post(`/api/projects/${projectId}/versions`, undefined, { body: form });
  return client.json(res);
}

describe('/api/projects/:id/versions', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('POST version with multipart + list returns the new version', async () => {
    const client = await loggedInClient('ver1@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Feed' }),
    );
    const created = await postVersion(
      client,
      proj.id,
      { routes: [{ id: 'r1' }] },
      { label: 'First cut', summary: { routes: 1 }, validationErrors: 0, validationWarnings: 0 },
    );
    expect(created.version.id).toBeTruthy();
    expect(created.version.label).toBe('First cut');

    const list = await client.json<{ versions: { id: string; label: string | null }[] }>(
      await client.get(`/api/projects/${proj.id}/versions`),
    );
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0].label).toBe('First cut');
  });

  it('GET version state returns the stored blob (gzipped)', async () => {
    const client = await loggedInClient('ver2@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Feed' }),
    );
    const v = await postVersion(
      client,
      proj.id,
      { message: 'hello versions' },
      { summary: {}, validationErrors: 0, validationWarnings: 0 },
    );

    const state = await client.get(`/api/projects/${proj.id}/versions/${v.version.id}/state`);
    expect(state.status).toBe(200);
    expect(state.headers.get('Content-Encoding')).toBe('gzip');
    const decoded = await ungzip(await state.arrayBuffer());
    expect(JSON.parse(decoded)).toEqual({ message: 'hello versions' });
  });

  it('restore copies a version\'s state into working state and bumps the version counter', async () => {
    const client = await loggedInClient('ver3@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Restore' }),
    );
    const v = await postVersion(
      client,
      proj.id,
      { from: 'version' },
      { summary: {}, validationErrors: 0, validationWarnings: 0 },
    );

    const restore = await client.post(`/api/projects/${proj.id}/versions/${v.version.id}/restore`);
    const body = await client.json<{ workingStateVersion: number }>(restore);
    expect(body.workingStateVersion).toBeGreaterThanOrEqual(1);

    const ws = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(ws.status).toBe(200);
    const decoded = await ungzip(await ws.arrayBuffer());
    expect(JSON.parse(decoded)).toEqual({ from: 'version' });
  });

  it('DELETE removes the version from listing and from R2', async () => {
    const client = await loggedInClient('ver4@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'DelVer' }),
    );
    const v = await postVersion(
      client,
      proj.id,
      { keep: false },
      { summary: {}, validationErrors: 0, validationWarnings: 0 },
    );

    // Sanity: the R2 blob exists.
    const r2before = await testEnv.FEEDS.get(`projects/${proj.id}/versions/${v.version.id}/state.json.gz`);
    expect(r2before).not.toBeNull();

    const del = await client.delete(`/api/projects/${proj.id}/versions/${v.version.id}`);
    expect(del.status).toBe(204);

    const list = await client.json<{ versions: unknown[] }>(
      await client.get(`/api/projects/${proj.id}/versions`),
    );
    expect(list.versions).toHaveLength(0);

    const r2after = await testEnv.FEEDS.get(`projects/${proj.id}/versions/${v.version.id}/state.json.gz`);
    expect(r2after).toBeNull();
  });

  it('POST version with missing meta returns 422', async () => {
    const client = await loggedInClient('ver5@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Invalid' }),
    );
    const form = new FormData();
    form.append('state', new Blob([await gzip('{}')], { type: 'application/json' }), 'state.json.gz');
    // no meta part
    const res = await client.post(`/api/projects/${proj.id}/versions`, undefined, { body: form });
    expect(res.status).toBe(422);
  });
});
