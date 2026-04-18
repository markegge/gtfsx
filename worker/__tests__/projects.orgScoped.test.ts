// Org-scoped projects: create, role-based access (viewer/editor/admin),
// scope=org:<id> listing, quota accounting per org vs personal.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { ulid } from 'ulidx';

async function loggedInClient(email: string): Promise<{ client: TestClient; userId: string }> {
  const normalized = email.toLowerCase();
  const user = await seedUser({ email: normalized });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

async function addMember(orgId: string, userId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await testEnv.DB.prepare(
    `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(orgId, userId, role, Date.now())
    .run();
}

async function createOrg(client: TestClient, slug: string, name: string): Promise<string> {
  const res = await client.post('/api/orgs', { slug, name });
  const body = await client.json<{ organization: { id: string } }>(res);
  return body.organization.id;
}

describe('org-scoped projects', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('POST /api/projects with owner={type:org, id} creates an org-owned project', async () => {
    const { client: owner } = await loggedInClient('opo1@example.com');
    const orgId = await createOrg(owner, 'orgproj1', 'OrgProj1');

    const res = await owner.post('/api/projects', {
      name: 'OrgFeed',
      owner: { type: 'org', id: orgId },
    });
    expect(res.status).toBe(201);
    const body = await owner.json<{ id: string; ownerType: string; ownerId: string }>(res);
    expect(body.ownerType).toBe('org');
    expect(body.ownerId).toBe(orgId);
  });

  it('non-member of the org cannot create a project owned by it (404)', async () => {
    const { client: owner } = await loggedInClient('opo2-owner@example.com');
    const orgId = await createOrg(owner, 'orgproj2', 'OrgProj2');

    const { client: outsider } = await loggedInClient('opo2-outsider@example.com');
    const res = await outsider.post('/api/projects', {
      name: 'Sneaky',
      owner: { type: 'org', id: orgId },
    });
    expect(res.status).toBe(404);
  });

  it('viewer cannot create in the org (403) but can GET project', async () => {
    const { client: owner } = await loggedInClient('viewerCase-owner@example.com');
    const orgId = await createOrg(owner, 'viewercase', 'ViewerCase');
    const proj = await owner.json<{ id: string }>(
      await owner.post('/api/projects', { name: 'Feed', owner: { type: 'org', id: orgId } }),
    );

    const { client: viewer, userId: viewerId } = await loggedInClient('viewerCase@example.com');
    await addMember(orgId, viewerId, 'viewer');

    const create = await viewer.post('/api/projects', {
      name: 'ViewerWrite',
      owner: { type: 'org', id: orgId },
    });
    expect(create.status).toBe(403);

    const get = await viewer.get(`/api/projects/${proj.id}`);
    expect(get.status).toBe(200);
    const body = await viewer.json<{ access: string }>(get);
    expect(body.access).toBe('org:viewer');
  });

  it('viewer gets 403 on PATCH; editor can PATCH', async () => {
    const { client: owner } = await loggedInClient('editorCase-owner@example.com');
    const orgId = await createOrg(owner, 'editorcase', 'EditorCase');
    const proj = await owner.json<{ id: string }>(
      await owner.post('/api/projects', { name: 'EditMe', owner: { type: 'org', id: orgId } }),
    );

    const { client: viewer, userId: viewerId } = await loggedInClient('ec-viewer@example.com');
    const { client: editor, userId: editorId } = await loggedInClient('ec-editor@example.com');
    await addMember(orgId, viewerId, 'viewer');
    await addMember(orgId, editorId, 'editor');

    const viewPatch = await viewer.patch(`/api/projects/${proj.id}`, { name: 'NopeViewer' });
    expect(viewPatch.status).toBe(403);

    const editPatch = await editor.patch(`/api/projects/${proj.id}`, { name: 'EditedByEditor' });
    expect(editPatch.status).toBe(200);
    const body = await editor.json<{ name: string }>(editPatch);
    expect(body.name).toBe('EditedByEditor');
  });

  it('editor cannot DELETE (403); admin can DELETE', async () => {
    const { client: owner } = await loggedInClient('dc-owner@example.com');
    const orgId = await createOrg(owner, 'delcase', 'DelCase');
    const proj = await owner.json<{ id: string }>(
      await owner.post('/api/projects', { name: 'Doomed', owner: { type: 'org', id: orgId } }),
    );

    const { client: editor, userId: editorId } = await loggedInClient('dc-editor@example.com');
    const { client: admin, userId: adminId } = await loggedInClient('dc-admin@example.com');
    await addMember(orgId, editorId, 'editor');
    await addMember(orgId, adminId, 'admin');

    const byEd = await editor.delete(`/api/projects/${proj.id}`);
    expect(byEd.status).toBe(403);

    const byAdmin = await admin.delete(`/api/projects/${proj.id}`);
    expect(byAdmin.status).toBe(204);
  });

  it('GET /api/projects?scope=org:<id> lists only that org\'s projects', async () => {
    const { client: owner } = await loggedInClient('scope-owner@example.com');
    const orgId = await createOrg(owner, 'scopeorg', 'ScopeOrg');

    // One org-owned project
    await owner.post('/api/projects', { name: 'InOrg1', owner: { type: 'org', id: orgId } });
    await owner.post('/api/projects', { name: 'InOrg2', owner: { type: 'org', id: orgId } });
    // One personal project (shouldn't appear in org scope)
    await owner.post('/api/projects', { name: 'Personal' });

    const orgList = await owner.json<{ projects: { name: string; ownerType: string }[] }>(
      await owner.get(`/api/projects?scope=org:${orgId}`),
    );
    const names = orgList.projects.map((p) => p.name).sort();
    expect(names).toEqual(['InOrg1', 'InOrg2']);
    for (const p of orgList.projects) {
      expect(p.ownerType).toBe('org');
    }

    const personalList = await owner.json<{ projects: { name: string }[] }>(
      await owner.get('/api/projects'),
    );
    expect(personalList.projects.map((p) => p.name)).toEqual(['Personal']);
  });

  it('non-member GET scope=org:<id> returns 404', async () => {
    const { client: owner } = await loggedInClient('scope-n-owner@example.com');
    const orgId = await createOrg(owner, 'scopenonmember', 'ScopeNM');

    const { client: outsider } = await loggedInClient('scope-outsider@example.com');
    const res = await outsider.get(`/api/projects?scope=org:${orgId}`);
    expect(res.status).toBe(404);
  });

  it('quota counts org projects separately from personal', async () => {
    const { client: owner, userId } = await loggedInClient('quota-owner@example.com');
    const orgId = await createOrg(owner, 'quotaorg', 'QuotaOrg');

    // Seed 18 personal projects + 18 org projects via SQL.
    const now = Date.now();
    for (let i = 0; i < 18; i += 1) {
      await dbRun(
        `INSERT INTO feed_project (id, slug, name, description, owner_type, owner_id,
           working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
           archived_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'user', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
        ulid(),
        `p-${i}`,
        `P${i}`,
        userId,
        now,
        now,
      );
    }
    for (let i = 0; i < 18; i += 1) {
      await dbRun(
        `INSERT INTO feed_project (id, slug, name, description, owner_type, owner_id,
           working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
           archived_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'org', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
        ulid(),
        `o-${i}`,
        `O${i}`,
        orgId,
        now,
        now,
      );
    }

    // Personal list reports 18 used (not 36).
    const personalList = await owner.json<{ quota: { projects: { used: number; limit: number } } }>(
      await owner.get('/api/projects'),
    );
    expect(personalList.quota.projects.used).toBe(18);

    // Org-scoped list reports 18 used (independent count).
    const orgList = await owner.json<{ quota: { projects: { used: number; limit: number } } }>(
      await owner.get(`/api/projects?scope=org:${orgId}`),
    );
    expect(orgList.quota.projects.used).toBe(18);
    // Both counts below 20 — the warn threshold is 18, so we expect warning headers.
  });
});
