// POST /api/projects/:id/duplicate — independent copy in the same workspace:
// copies the working-state blob, dedupes name/slug, never born locked, copy is
// independent of the source, enforces project quota (soft-warn in tests), and
// enforces editor+ permission on org feeds.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
  dbRun,
  gzip,
  ungzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { ulid } from 'ulidx';

async function loggedInClient(
  email: string,
  plan: 'free' | 'agency' | 'enterprise' = 'agency',
): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email: email.toLowerCase(), plan });
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
  await testEnv.DB.prepare('UPDATE organization SET plan = ? WHERE id = ?')
    .bind('agency', body.organization.id)
    .run();
  return body.organization.id;
}

// Save working state via the API so the blob + version bookkeeping match prod.
async function saveState(client: TestClient, projectId: string, state: unknown, ifMatch: number) {
  const res = await client.put(`/api/projects/${projectId}/working-state`, undefined, {
    body: await gzip(JSON.stringify(state)),
    headers: { 'Content-Encoding': 'gzip', 'If-Match': String(ifMatch) },
  });
  if (res.status !== 200) throw new Error(`save failed: ${res.status}`);
}

describe('POST /api/projects/:id/duplicate', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('copies the working state into an independent project (name/slug deduped, unlocked)', async () => {
    const { client } = await loggedInClient('dup1@example.com');
    const src = await client.json<{ id: string; slug: string }>(
      await client.post('/api/projects', { name: 'Route Map', description: 'My feed' }),
    );
    const state = { routes: [{ route_id: 'R1', route_short_name: '1' }], stops: [] };
    await saveState(client, src.id, state, 0);

    const res = await client.post(`/api/projects/${src.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = await client.json<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      locked: boolean;
      workingStateVersion: number;
      workingStateSize: number | null;
      workingStateUpdatedAt: number | null;
    }>(res);

    expect(copy.id).not.toBe(src.id);
    expect(copy.name).toBe('Route Map (copy)');
    expect(copy.slug).not.toBe(src.slug);
    expect(copy.slug).toContain('route-map-copy');
    expect(copy.description).toBe('My feed'); // description carried over
    expect(copy.locked).toBe(false);
    expect(copy.workingStateVersion).toBe(1);
    expect(copy.workingStateSize).toBeGreaterThan(0);
    expect(copy.workingStateUpdatedAt).not.toBeNull();

    // The copy's working state matches the source.
    const fetched = await client.get(`/api/projects/${copy.id}/working-state`);
    expect(fetched.status).toBe(200);
    const copiedState = JSON.parse(await fetched.text());
    expect(copiedState).toEqual(state);

    // Both appear in the list now.
    const list = await client.json<{ projects: { id: string }[] }>(await client.get('/api/projects'));
    expect(list.projects.map((p) => p.id).sort()).toEqual([src.id, copy.id].sort());
  });

  it('the copy is independent: editing it does not change the source', async () => {
    const { client } = await loggedInClient('dup2@example.com');
    const src = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Independent' }),
    );
    await saveState(client, src.id, { routes: [{ route_id: 'ORIG' }] }, 0);

    const copy = await client.json<{ id: string }>(
      await client.post(`/api/projects/${src.id}/duplicate`),
    );

    // Edit the copy (version starts at 1 because the blob was copied).
    await saveState(client, copy.id, { routes: [{ route_id: 'EDITED' }] }, 1);

    const srcState = JSON.parse(
      await ungzip((await testEnv.FEEDS.get(`projects/${src.id}/working-state.json.gz`))!.body),
    );
    const copyState = JSON.parse(
      await ungzip((await testEnv.FEEDS.get(`projects/${copy.id}/working-state.json.gz`))!.body),
    );
    expect(srcState).toEqual({ routes: [{ route_id: 'ORIG' }] });
    expect(copyState).toEqual({ routes: [{ route_id: 'EDITED' }] });
  });

  it('duplicating a feed with no working state yields an empty copy (version 0)', async () => {
    const { client } = await loggedInClient('dup3@example.com');
    const src = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Empty Feed' }),
    );

    const copy = await client.json<{
      id: string;
      workingStateVersion: number;
      workingStateSize: number | null;
    }>(await client.post(`/api/projects/${src.id}/duplicate`));

    expect(copy.workingStateVersion).toBe(0);
    expect(copy.workingStateSize).toBeNull();
    // No blob written for an empty copy.
    const blob = await testEnv.FEEDS.get(`projects/${copy.id}/working-state.json.gz`);
    expect(blob).toBeNull();
    // Fetching working state 404s (same as a fresh create).
    const ws = await client.get(`/api/projects/${copy.id}/working-state`);
    expect(ws.status).toBe(404);
  });

  it('does not copy snapshots — the copy starts with none', async () => {
    const { client, userId } = await loggedInClient('dup4@example.com');
    const src = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'HasSnapshots' }),
    );
    // Seed a snapshot directly on the source.
    await dbRun(
      `INSERT INTO feed_snapshot
         (id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
          summary_json, validation_errors, validation_warnings, created_at)
       VALUES (?, ?, 'v0', ?, ?, '', 0, '{}', 0, 0, ?)`,
      ulid(),
      src.id,
      userId,
      `projects/${src.id}/snapshots/fake/state.json.gz`,
      Date.now(),
    );

    const copy = await client.json<{ id: string }>(
      await client.post(`/api/projects/${src.id}/duplicate`),
    );
    const detail = await client.json<{ snapshots: unknown[] }>(
      await client.get(`/api/projects/${copy.id}`),
    );
    expect(detail.snapshots).toEqual([]);
  });

  it('duplicate is owned by the same org as the source', async () => {
    const { client: owner } = await loggedInClient('duporg-owner@example.com');
    const orgId = await createOrg(owner, 'dup-org', 'Dup Org');
    const src = await owner.json<{ id: string }>(
      await owner.post('/api/projects', { name: 'OrgFeed', owner: { type: 'org', id: orgId } }),
    );

    const copy = await owner.json<{ ownerType: string; ownerId: string; name: string }>(
      await owner.post(`/api/projects/${src.id}/duplicate`),
    );
    expect(copy.ownerType).toBe('org');
    expect(copy.ownerId).toBe(orgId);
    expect(copy.name).toBe('OrgFeed (copy)');

    // It shows up under the org scope.
    const orgList = await owner.json<{ projects: { name: string }[] }>(
      await owner.get(`/api/projects?scope=org:${orgId}`),
    );
    expect(orgList.projects.map((p) => p.name).sort()).toEqual(['OrgFeed', 'OrgFeed (copy)']);
  });

  it('org viewer cannot duplicate (403); editor can', async () => {
    const { client: owner } = await loggedInClient('dupperm-owner@example.com');
    const orgId = await createOrg(owner, 'dup-perm', 'Dup Perm');
    const src = await owner.json<{ id: string }>(
      await owner.post('/api/projects', { name: 'Gated', owner: { type: 'org', id: orgId } }),
    );

    const { client: viewer, userId: viewerId } = await loggedInClient('dup-viewer@example.com');
    const { client: editor, userId: editorId } = await loggedInClient('dup-editor@example.com');
    await addMember(orgId, viewerId, 'viewer');
    await addMember(orgId, editorId, 'editor');

    const byViewer = await viewer.post(`/api/projects/${src.id}/duplicate`);
    expect(byViewer.status).toBe(403);

    const byEditor = await editor.post(`/api/projects/${src.id}/duplicate`);
    expect(byEditor.status).toBe(201);
  });

  it('cross-user isolation: cannot duplicate another user\'s feed (404)', async () => {
    const { client: alice } = await loggedInClient('dup-alice@example.com');
    const proj = await alice.json<{ id: string }>(
      await alice.post('/api/projects', { name: 'AliceFeed' }),
    );
    const { client: bob } = await loggedInClient('dup-bob@example.com');
    const res = await bob.post(`/api/projects/${proj.id}/duplicate`);
    expect(res.status).toBe(404);
  });

  it('enforces project quota: at the warn threshold the duplicate sets X-Quota-Warning (soft mode)', async () => {
    // Free tier projects=3, warnAt=floor(3*0.9)=2. Seed 1, create source =2,
    // duplicate observes used=2 >= warnAt and emits the warning header.
    const { client, userId } = await loggedInClient('dup-quota@example.com', 'free');
    const now = Date.now();
    for (let i = 0; i < 1; i += 1) {
      await dbRun(
        `INSERT INTO feed_project (id, slug, name, description, owner_type, owner_id,
           working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
           archived_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'user', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
        ulid(),
        `pre-${i}`,
        `Pre ${i}`,
        userId,
        now,
        now,
      );
    }
    const src = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'QuotaSrc' }),
    );

    const res = await client.post(`/api/projects/${src.id}/duplicate`);
    expect(res.status).toBe(201); // soft mode: still creates
    expect(res.headers.get('X-Quota-Warning')).toMatch(/^\d+\/3$/);
  });
});
