// Delete protection + trash (issue #63).
//
//   DELETE /api/projects/:id            — refuses a PUBLISHED feed (409)
//   DELETE /api/projects/:id?unpublish=1 — unpublish, then soft-delete
//   GET    /api/projects/deleted        — the trash, with purgeAt
//   POST   /api/projects/:id/restore    — undelete (suffixes the slug on collision)
//
// The published-feed guard is the point of the exercise: without it a deleted
// feed keeps serving on FEEDS_ORIGIN forever while vanishing from its owner's
// list, so nobody can ever take it down.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbGet,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

async function createSnapshot(client: TestClient, projectId: string): Promise<string> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify({ agencies: [], routes: [], stops: [] }));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  const body = await client.json<{ snapshot: { id: string } }>(
    await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }),
  );
  return body.snapshot.id;
}

/** Create + publish a feed; returns it with the snapshot and the served bytes. */
async function publishedProject(
  client: TestClient,
  name: string,
): Promise<{ id: string; slug: string; snapshotId: string; zip: Uint8Array }> {
  const proj = await createProject(client, name);
  const snapshotId = await createSnapshot(client, proj.id);
  const zip = new TextEncoder().encode('PK\x03\x04live-feed');
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId }));
  form.append('zip', new Blob([zip], { type: 'application/zip' }), 'gtfs.zip');
  const res = await client.post(`/api/projects/${proj.id}/publish`, undefined, { body: form });
  if (res.status !== 200) throw new Error(`publish failed: ${res.status}`);
  return { ...proj, snapshotId, zip };
}

const feedStatus = async (slug: string): Promise<number> =>
  (await SELF.fetch(`http://feeds.test/${slug}/gtfs.zip`)).status;

const deletedAtOf = async (id: string): Promise<number | null> =>
  (await dbGet<{ deleted_at: number | null }>(`SELECT deleted_at FROM feed_project WHERE id = ?`, id))
    ?.deleted_at ?? null;

describe('DELETE /api/projects/:id — publish guard', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('refuses to delete a PUBLISHED feed: 409, feed still live, project not deleted', async () => {
    const client = await loggedInClient('del-pub@example.com');
    const proj = await publishedProject(client, 'Live Feed');
    expect(await feedStatus(proj.slug)).toBe(200);

    const res = await client.delete(`/api/projects/${proj.id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string; reason: string; canonicalSlug: string };
    expect(body.error).toBe('conflict');
    expect(body.reason).toBe('published');
    expect(body.canonicalSlug).toBe(proj.slug);
    expect(body.message).toContain(`/${proj.slug}`);
    expect(body.message).toContain('Unpublish it before deleting');

    // NOT deleted…
    expect(await deletedAtOf(proj.id)).toBeNull();
    const list = await client.json<{ projects: { id: string }[] }>(await client.get('/api/projects'));
    expect(list.projects.find((p) => p.id === proj.id)).toBeDefined();

    // …and the feed is STILL being served.
    expect(await feedStatus(proj.slug)).toBe(200);
    const stillPublished = await dbGet(`SELECT project_id FROM publication WHERE project_id = ?`, proj.id);
    expect(stillPublished).not.toBeNull();
  });

  it('?unpublish=1 unpublishes then soft-deletes: feed stops serving, feed is in the trash', async () => {
    const client = await loggedInClient('del-unpub@example.com');
    const proj = await publishedProject(client, 'Retire Me');
    expect(await feedStatus(proj.slug)).toBe(200);

    const res = await client.delete(`/api/projects/${proj.id}?unpublish=1`);
    expect(res.status).toBe(204);

    // Public feed is gone.
    expect(await feedStatus(proj.slug)).toBe(404);
    expect(await dbGet(`SELECT project_id FROM publication WHERE project_id = ?`, proj.id)).toBeNull();

    // Project is soft-deleted (not purged).
    expect(await deletedAtOf(proj.id)).toBeGreaterThan(0);
    const list = await client.json<{ projects: { id: string }[] }>(await client.get('/api/projects'));
    expect(list.projects.find((p) => p.id === proj.id)).toBeUndefined();

    // BOTH audit events fired, and the unpublish went through the shared path
    // (so it left a publication_history row exactly like POST /unpublish does).
    const actions = (
      await dbAll<{ action: string }>(
        `SELECT action FROM audit_event WHERE subject_id = ? ORDER BY id`,
        proj.id,
      )
    ).map((r) => r.action);
    expect(actions).toContain('project.unpublish');
    expect(actions).toContain('project.delete');

    const history = await dbAll<{ action: string }>(
      `SELECT action FROM publication_history WHERE project_id = ? ORDER BY created_at`,
      proj.id,
    );
    expect(history.map((h) => h.action)).toEqual(['publish', 'unpublish']);
  });

  it('deletes an UNPUBLISHED feed with 204 + deleted_at set (existing behaviour)', async () => {
    const client = await loggedInClient('del-plain@example.com');
    const proj = await createProject(client, 'Just A Draft');

    const res = await client.delete(`/api/projects/${proj.id}`);
    expect(res.status).toBe(204);
    expect(await deletedAtOf(proj.id)).toBeGreaterThan(0);
    expect(await client.get(`/api/projects/${proj.id}`).then((r) => r.status)).toBe(404);
  });

  it('a LOCKED feed still 409s — and the lock outranks ?unpublish=1', async () => {
    const client = await loggedInClient('del-locked@example.com');
    const proj = await publishedProject(client, 'Locked And Live');
    await client.patch(`/api/projects/${proj.id}`, { locked: true });

    for (const path of [`/api/projects/${proj.id}`, `/api/projects/${proj.id}?unpublish=1`]) {
      const res = await client.delete(path);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe('conflict');
      expect(body.message).toContain('locked');
    }

    // Neither attempt took the feed down or deleted it.
    expect(await feedStatus(proj.slug)).toBe(200);
    expect(await deletedAtOf(proj.id)).toBeNull();
  });

  it('an unpublished LOCKED feed still 409s (no regression)', async () => {
    const client = await loggedInClient('del-locked2@example.com');
    const proj = await createProject(client, 'Locked Draft');
    await client.patch(`/api/projects/${proj.id}`, { locked: true });

    const res = await client.delete(`/api/projects/${proj.id}`);
    expect(res.status).toBe(409);
    expect(await deletedAtOf(proj.id)).toBeNull();
  });
});

describe('GET /api/projects/deleted + POST /api/projects/:id/restore', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('the trash lists deleted feeds with deletedAt + purgeAt, and nothing else', async () => {
    const client = await loggedInClient('trash1@example.com');
    const gone = await createProject(client, 'Gone');
    const kept = await createProject(client, 'Kept');
    await client.delete(`/api/projects/${gone.id}`);

    const trash = await client.json<{
      projects: { id: string; name: string; deletedAt: number; purgeAt: number }[];
      retentionMs: number;
    }>(await client.get('/api/projects/deleted'));

    expect(trash.projects.map((p) => p.id)).toEqual([gone.id]);
    expect(trash.projects.find((p) => p.id === kept.id)).toBeUndefined();

    const row = trash.projects[0];
    expect(row.name).toBe('Gone');
    expect(row.deletedAt).toBeGreaterThan(0);
    expect(row.purgeAt).toBe(row.deletedAt + trash.retentionMs);
    expect(trash.retentionMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('restore clears deleted_at and the feed reappears in the list', async () => {
    const client = await loggedInClient('trash2@example.com');
    const proj = await createProject(client, 'Oops');
    await client.delete(`/api/projects/${proj.id}`);

    const restored = await client.json<{
      project: { id: string; name: string };
      slug: string;
      slugChanged: boolean;
    }>(await client.post(`/api/projects/${proj.id}/restore`));
    expect(restored.slugChanged).toBe(false);
    expect(restored.slug).toBe(proj.slug);
    expect(restored.project.id).toBe(proj.id);

    expect(await deletedAtOf(proj.id)).toBeNull();
    const list = await client.json<{ projects: { id: string }[] }>(await client.get('/api/projects'));
    expect(list.projects.find((p) => p.id === proj.id)).toBeDefined();

    // Out of the trash, and reachable again.
    const trash = await client.json<{ projects: unknown[] }>(await client.get('/api/projects/deleted'));
    expect(trash.projects).toEqual([]);
    expect(await client.get(`/api/projects/${proj.id}`).then((r) => r.status)).toBe(200);

    const audit = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event WHERE subject_id = ? AND action = 'project.restore'`,
      proj.id,
    );
    expect(audit.length).toBe(1);
  });

  it('restore SUCCEEDS with a suffixed slug when the old slug was taken while it sat in the trash', async () => {
    const client = await loggedInClient('trash3@example.com');
    const original = await createProject(client, 'Route Atlas');
    expect(original.slug).toBe('route-atlas');
    await client.delete(`/api/projects/${original.id}`);

    // The partial unique index ignores soft-deleted rows, so the slug is free —
    // the user makes a NEW feed that grabs it.
    const replacement = await createProject(client, 'Route Atlas');
    expect(replacement.slug).toBe('route-atlas');

    // …then changes their mind and restores the old one.
    const res = await client.post(`/api/projects/${original.id}/restore`);
    expect(res.status).toBe(200);
    const restored = await client.json<{
      project: { id: string; slug: string };
      slug: string;
      slugChanged: boolean;
      previousSlug: string;
    }>(res);

    expect(restored.slugChanged).toBe(true);
    expect(restored.slug).toBe('route-atlas-2');
    expect(restored.previousSlug).toBe('route-atlas');
    expect(restored.project.slug).toBe('route-atlas-2');

    // Both feeds are live, with distinct slugs — the unique index holds.
    const list = await client.json<{ projects: { id: string; slug: string }[] }>(
      await client.get('/api/projects'),
    );
    const slugs = new Map(list.projects.map((p) => [p.id, p.slug]));
    expect(slugs.get(original.id)).toBe('route-atlas-2');
    expect(slugs.get(replacement.id)).toBe('route-atlas');
  });

  it('restore is scoped to the owner: another user gets 404, and the trash is per-user', async () => {
    const alice = await loggedInClient('trash-alice@example.com');
    const proj = await createProject(alice, 'Alice Feed');
    await alice.delete(`/api/projects/${proj.id}`);

    const bob = await loggedInClient('trash-bob@example.com');
    expect(await bob.post(`/api/projects/${proj.id}/restore`).then((r) => r.status)).toBe(404);
    const bobTrash = await bob.json<{ projects: unknown[] }>(await bob.get('/api/projects/deleted'));
    expect(bobTrash.projects).toEqual([]);

    // Still recoverable by Alice.
    expect(await alice.post(`/api/projects/${proj.id}/restore`).then((r) => r.status)).toBe(200);
  });

  it('restore 404s for a project that is not deleted', async () => {
    const client = await loggedInClient('trash4@example.com');
    const proj = await createProject(client, 'Alive');
    expect(await client.post(`/api/projects/${proj.id}/restore`).then((r) => r.status)).toBe(404);
  });

  it('a restored feed is NOT re-published', async () => {
    const client = await loggedInClient('trash5@example.com');
    const proj = await publishedProject(client, 'Down For Good');
    await client.delete(`/api/projects/${proj.id}?unpublish=1`);
    await client.post(`/api/projects/${proj.id}/restore`);

    expect(await feedStatus(proj.slug)).toBe(404);
    expect(await dbGet(`SELECT project_id FROM publication WHERE project_id = ?`, proj.id)).toBeNull();
  });
});
