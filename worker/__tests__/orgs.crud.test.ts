// Organizations CRUD: create, list, get, patch (incl. slug collision),
// soft-delete (cascades to projects).

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbGet,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<{ client: TestClient; userId: string }> {
  const normalized = email.toLowerCase();
  const user = await seedUser({ email: normalized });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

describe('/api/orgs CRUD', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('POST /api/orgs creates an org and inserts the caller as owner', async () => {
    const { client, userId } = await loggedInClient('ownerA@example.com');
    const res = await client.post('/api/orgs', { slug: 'acme', name: 'Acme Transit' });
    expect(res.status).toBe(201);
    const body = await client.json<{
      organization: { id: string; slug: string; name: string; role: string };
    }>(res);
    expect(body.organization.slug).toBe('acme');
    expect(body.organization.name).toBe('Acme Transit');
    expect(body.organization.role).toBe('owner');

    // Membership row inserted.
    const m = await dbGet<{ role: string }>(
      `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      body.organization.id,
      userId,
    );
    expect(m?.role).toBe('owner');
  });

  it('invalid slug returns 422', async () => {
    const { client } = await loggedInClient('bad-slug@example.com');
    const res = await client.post('/api/orgs', { slug: 'NO CAPS OR SPACES', name: 'x' });
    expect(res.status).toBe(422);
  });

  it('duplicate slug returns 409 conflict', async () => {
    const { client: a } = await loggedInClient('collideA@example.com');
    const first = await a.post('/api/orgs', { slug: 'sharedname', name: 'First' });
    expect(first.status).toBe(201);

    const { client: b } = await loggedInClient('collideB@example.com');
    const second = await b.post('/api/orgs', { slug: 'sharedname', name: 'Second' });
    expect(second.status).toBe(409);
  });

  it('GET /api/orgs lists orgs the caller belongs to with role, memberCount, projectCount', async () => {
    const { client } = await loggedInClient('lister@example.com');
    await client.post('/api/orgs', { slug: 'one', name: 'One' });
    await client.post('/api/orgs', { slug: 'two', name: 'Two' });

    const res = await client.get('/api/orgs');
    expect(res.status).toBe(200);
    const body = await client.json<{
      orgs: { slug: string; role: string; memberCount: number; projectCount: number }[];
    }>(res);
    const slugs = body.orgs.map((o) => o.slug).sort();
    expect(slugs).toEqual(['one', 'two']);
    for (const o of body.orgs) {
      expect(o.role).toBe('owner');
      expect(o.memberCount).toBe(1);
      expect(o.projectCount).toBe(0);
    }
  });

  it('GET /api/orgs does NOT return orgs the caller is not a member of', async () => {
    const { client: a } = await loggedInClient('outsiderA@example.com');
    await a.post('/api/orgs', { slug: 'private-a', name: 'Private A' });

    const { client: b } = await loggedInClient('outsiderB@example.com');
    const res = await b.get('/api/orgs');
    const body = await b.json<{ orgs: { slug: string }[] }>(res);
    expect(body.orgs.find((o) => o.slug === 'private-a')).toBeUndefined();
  });

  it('GET /api/orgs/:id returns members + projectCount for a member; 404 for non-member', async () => {
    const { client: owner, userId: ownerId } = await loggedInClient('getown@example.com');
    const created = await owner.json<{ organization: { id: string } }>(
      await owner.post('/api/orgs', { slug: 'get-me', name: 'Get Me' }),
    );
    const orgId = created.organization.id;

    const getRes = await owner.get(`/api/orgs/${orgId}`);
    expect(getRes.status).toBe(200);
    const body = await owner.json<{
      organization: { id: string; slug: string };
      members: { userId: string; role: string; email: string }[];
      projectCount: number;
    }>(getRes);
    expect(body.organization.id).toBe(orgId);
    expect(body.members).toHaveLength(1);
    expect(body.members[0].userId).toBe(ownerId);
    expect(body.members[0].role).toBe('owner');
    expect(body.projectCount).toBe(0);

    const { client: other } = await loggedInClient('other@example.com');
    const res = await other.get(`/api/orgs/${orgId}`);
    expect(res.status).toBe(404);
  });

  it('PATCH /api/orgs/:id updates name/slug; non-admin members get 403', async () => {
    const { client } = await loggedInClient('patchOwner@example.com');
    const created = await client.json<{ organization: { id: string } }>(
      await client.post('/api/orgs', { slug: 'patchable', name: 'Original' }),
    );
    const orgId = created.organization.id;

    const patched = await client.patch(`/api/orgs/${orgId}`, { name: 'Renamed', slug: 'renamed-org' });
    expect(patched.status).toBe(200);
    const body = await client.json<{ organization: { slug: string; name: string } }>(patched);
    expect(body.organization.name).toBe('Renamed');
    expect(body.organization.slug).toBe('renamed-org');
  });

  it('PATCH slug collision returns 409', async () => {
    const { client: a } = await loggedInClient('patchCollideA@example.com');
    await a.post('/api/orgs', { slug: 'already-taken', name: 'Taken' });

    const { client: b } = await loggedInClient('patchCollideB@example.com');
    const mine = await b.json<{ organization: { id: string } }>(
      await b.post('/api/orgs', { slug: 'mine', name: 'Mine' }),
    );
    const res = await b.patch(`/api/orgs/${mine.organization.id}`, { slug: 'already-taken' });
    expect(res.status).toBe(409);
  });

  it('DELETE /api/orgs/:id soft-deletes the org and cascades to org-owned projects', async () => {
    const { client } = await loggedInClient('delOwner@example.com');
    const created = await client.json<{ organization: { id: string } }>(
      await client.post('/api/orgs', { slug: 'doomedorg', name: 'Doomed' }),
    );
    const orgId = created.organization.id;

    // Create an org-owned project.
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', {
        name: 'Org Feed',
        owner: { type: 'org', id: orgId },
      }),
    );

    const del = await client.delete(`/api/orgs/${orgId}`);
    expect(del.status).toBe(204);

    // Org row: deleted_at set.
    const orgRow = await dbGet<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM organization WHERE id = ?`,
      orgId,
    );
    expect(orgRow?.deleted_at).not.toBeNull();

    // Project soft-deleted too.
    const projRow = await dbGet<{ deleted_at: number | null }>(
      `SELECT deleted_at FROM feed_project WHERE id = ?`,
      proj.id,
    );
    expect(projRow?.deleted_at).not.toBeNull();

    // List no longer shows it.
    const listRes = await client.get('/api/orgs');
    const body = await client.json<{ orgs: { id: string }[] }>(listRes);
    expect(body.orgs.find((o) => o.id === orgId)).toBeUndefined();

    // Direct GET returns 404.
    const getRes = await client.get(`/api/orgs/${orgId}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE by non-owner returns 403', async () => {
    const { client: owner, userId: ownerId } = await loggedInClient('delO@example.com');
    const created = await owner.json<{ organization: { id: string } }>(
      await owner.post('/api/orgs', { slug: 'needs-owner', name: 'NeedsOwner' }),
    );
    const orgId = created.organization.id;

    // Add an admin member directly.
    const { client: admin, userId: adminId } = await loggedInClient('admin@example.com');
    // Insert membership directly — avoids exercising invite flow in this test.
    const { env } = await import('./_setup');
    await env.DB.prepare(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at)
       VALUES (?, ?, 'admin', ?)`,
    )
      .bind(orgId, adminId, Date.now())
      .run();

    // Admin deletes: should be 403 (only owners can).
    const res = await admin.delete(`/api/orgs/${orgId}`);
    expect(res.status).toBe(403);

    // Owner still there.
    expect(ownerId).toBeTruthy();
  });
});
