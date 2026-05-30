// /api/projects CRUD: create (with slug auto-gen), list, get, patch (incl.
// slug collision), soft-delete, and cross-user isolation.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
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

describe('/api/projects CRUD', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('POST creates a project with an auto-generated slug', async () => {
    const { client } = await loggedInClient('crud1@example.com');
    const res = await client.post('/api/projects', { name: 'My Feed' });
    expect(res.status).toBe(201);
    const body = await client.json<{ slug: string; name: string }>(res);
    expect(body.slug).toBe('my-feed');
    expect(body.name).toBe('My Feed');
  });

  it('GET /api/projects lists the user\'s projects with quota metadata', async () => {
    const { client } = await loggedInClient('crud2@example.com');
    await client.post('/api/projects', { name: 'Feed A' });
    await client.post('/api/projects', { name: 'Feed B' });
    const listRes = await client.get('/api/projects');
    const list = await client.json<{
      projects: { name: string }[];
      quota: { projects: { used: number; limit: number } };
    }>(listRes);
    expect(list.projects.map((p) => p.name).sort()).toEqual(['Feed A', 'Feed B']);
    expect(list.quota.projects.used).toBe(2);
    expect(list.quota.projects.limit).toBe(99999); // team tier default in tests (unlimited sentinel)
  });

  it('GET /api/projects/:id returns the project plus an empty snapshots array', async () => {
    const { client } = await loggedInClient('crud3@example.com');
    const created = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Solo' }),
    );
    const getRes = await client.get(`/api/projects/${created.id}`);
    const body = await client.json<{ id: string; snapshots: unknown[] }>(getRes);
    expect(body.id).toBe(created.id);
    expect(body.snapshots).toEqual([]);
  });

  it('PATCH updates name and slug; slug collisions return 409', async () => {
    const { client } = await loggedInClient('crud4@example.com');
    const a = await client.json<{ id: string; slug: string }>(
      await client.post('/api/projects', { name: 'Alpha' }),
    );
    const b = await client.json<{ id: string; slug: string }>(
      await client.post('/api/projects', { name: 'Beta' }),
    );

    const patched = await client.json<{ name: string; slug: string }>(
      await client.patch(`/api/projects/${a.id}`, { name: 'Alphabet', slug: 'alphabet' }),
    );
    expect(patched.name).toBe('Alphabet');
    expect(patched.slug).toBe('alphabet');

    // Collide b.slug into a.slug.
    const collide = await client.patch(`/api/projects/${b.id}`, { slug: 'alphabet' });
    expect(collide.status).toBe(409);
  });

  it('DELETE soft-deletes and removes from the list', async () => {
    const { client } = await loggedInClient('crud5@example.com');
    const created = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Doomed' }),
    );

    const del = await client.delete(`/api/projects/${created.id}`);
    expect(del.status).toBe(204);

    const list = await client.json<{ projects: { id: string }[] }>(await client.get('/api/projects'));
    expect(list.projects.find((p) => p.id === created.id)).toBeUndefined();

    // Fetching directly returns 404.
    const getRes = await client.get(`/api/projects/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it('cross-user isolation: user B cannot access user A\'s project (404, not 403)', async () => {
    const { client: clientA } = await loggedInClient('alice-crud@example.com');
    const proj = await clientA.json<{ id: string }>(
      await clientA.post('/api/projects', { name: 'Alice Feed' }),
    );

    const { client: clientB } = await loggedInClient('bob-crud@example.com');
    const res = await clientB.get(`/api/projects/${proj.id}`);
    expect(res.status).toBe(404);
  });
});
