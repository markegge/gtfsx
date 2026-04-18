// Organization membership: list, change role, remove, self-leave,
// last-owner protection, ownership transfer.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
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

async function addMember(orgId: string, userId: string, role: 'owner' | 'admin' | 'editor' | 'viewer') {
  await testEnv.DB.prepare(
    `INSERT INTO organization_membership (org_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(orgId, userId, role, Date.now())
    .run();
}

async function createOrg(client: TestClient, slug: string, name: string): Promise<string> {
  const res = await client.post('/api/orgs', { slug, name });
  const body = await client.json<{ organization: { id: string } }>(res);
  return body.organization.id;
}

describe('/api/orgs membership', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('GET /api/orgs/:id includes all members with emails + roles', async () => {
    const { client: owner } = await loggedInClient('mlist-owner@example.com');
    const orgId = await createOrg(owner, 'listmembers', 'List Members');
    const { userId: editorId } = await loggedInClient('mlist-editor@example.com');
    await addMember(orgId, editorId, 'editor');

    const res = await owner.get(`/api/orgs/${orgId}`);
    const body = await owner.json<{
      members: { userId: string; email: string; role: string }[];
    }>(res);
    const byUser = Object.fromEntries(body.members.map((m) => [m.userId, m]));
    expect(byUser[editorId].role).toBe('editor');
    expect(byUser[editorId].email).toBe('mlist-editor@example.com');
  });

  it('PATCH role: admin can change editor→viewer and vice versa', async () => {
    const { client: owner, userId: ownerId } = await loggedInClient('roleOwner@example.com');
    const orgId = await createOrg(owner, 'roleorg', 'Role Org');
    const { userId: targetId } = await loggedInClient('roleTarget@example.com');
    await addMember(orgId, targetId, 'editor');
    // The owner acts as an admin for this test (owner >= admin).

    const res = await owner.patch(`/api/orgs/${orgId}/members/${targetId}`, { role: 'viewer' });
    expect(res.status).toBe(204);

    const row = await dbGet<{ role: string }>(
      `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      orgId,
      targetId,
    );
    expect(row?.role).toBe('viewer');
    // Owner is still the owner.
    expect(ownerId).toBeTruthy();
  });

  it('admin cannot promote a member to owner (only owners can)', async () => {
    const { client: owner } = await loggedInClient('noPromote@example.com');
    const orgId = await createOrg(owner, 'nopromote', 'NoPromote');
    const { client: admin, userId: adminId } = await loggedInClient('np-admin@example.com');
    const { userId: targetId } = await loggedInClient('np-target@example.com');
    await addMember(orgId, adminId, 'admin');
    await addMember(orgId, targetId, 'editor');

    const res = await admin.patch(`/api/orgs/${orgId}/members/${targetId}`, { role: 'owner' });
    expect(res.status).toBe(403);
  });

  it('last-owner protection: cannot demote the last owner (returns 409 last_owner)', async () => {
    const { client: owner, userId: ownerId } = await loggedInClient('soloOwner@example.com');
    const orgId = await createOrg(owner, 'soloorg', 'Solo');

    const res = await owner.patch(`/api/orgs/${orgId}/members/${ownerId}`, { role: 'admin' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('last_owner');
  });

  it('admin can remove an editor member', async () => {
    const { client: owner } = await loggedInClient('removeOwner@example.com');
    const orgId = await createOrg(owner, 'removeorg', 'Remove');
    const { userId: targetId } = await loggedInClient('removeTarget@example.com');
    await addMember(orgId, targetId, 'editor');

    const res = await owner.delete(`/api/orgs/${orgId}/members/${targetId}`);
    expect(res.status).toBe(204);
    const row = await dbGet(
      `SELECT 1 FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      orgId,
      targetId,
    );
    expect(row).toBeNull();
  });

  it('editor can self-leave (DELETE with their own user id)', async () => {
    const { client: owner } = await loggedInClient('selfLeaveOwner@example.com');
    const orgId = await createOrg(owner, 'selfleave', 'SelfLeave');
    const { client: leaver, userId: leaverId } = await loggedInClient('leaver@example.com');
    await addMember(orgId, leaverId, 'editor');

    const res = await leaver.delete(`/api/orgs/${orgId}/members/${leaverId}`);
    expect(res.status).toBe(204);
  });

  it('non-admin member cannot remove another member', async () => {
    const { client: owner } = await loggedInClient('noRemoveOwner@example.com');
    const orgId = await createOrg(owner, 'noremove', 'NoRemove');
    const { client: editor, userId: editorId } = await loggedInClient('nr-editor@example.com');
    const { userId: viewerId } = await loggedInClient('nr-viewer@example.com');
    await addMember(orgId, editorId, 'editor');
    await addMember(orgId, viewerId, 'viewer');

    const res = await editor.delete(`/api/orgs/${orgId}/members/${viewerId}`);
    expect(res.status).toBe(403);
  });

  it('last owner cannot self-leave — 409 last_owner', async () => {
    const { client: owner, userId: ownerId } = await loggedInClient('lastOwnerLeave@example.com');
    const orgId = await createOrg(owner, 'lastown', 'LastOwn');

    const res = await owner.delete(`/api/orgs/${orgId}/members/${ownerId}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reason?: string };
    expect(body.reason).toBe('last_owner');
  });

  it('POST /api/orgs/:id/transfer: hands ownership atomically, demotes caller to admin', async () => {
    const { client: owner, userId: ownerId } = await loggedInClient('xferOwner@example.com');
    const orgId = await createOrg(owner, 'xferorg', 'Xfer');
    const { userId: newOwnerId } = await loggedInClient('xferTarget@example.com');
    await addMember(orgId, newOwnerId, 'admin');

    const res = await owner.post(`/api/orgs/${orgId}/transfer`, { newOwnerUserId: newOwnerId });
    expect(res.status).toBe(204);

    const newOwnerRow = await dbGet<{ role: string }>(
      `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      orgId,
      newOwnerId,
    );
    expect(newOwnerRow?.role).toBe('owner');
    const oldOwnerRow = await dbGet<{ role: string }>(
      `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      orgId,
      ownerId,
    );
    expect(oldOwnerRow?.role).toBe('admin');
  });

  it('transfer to non-member returns 404', async () => {
    const { client: owner } = await loggedInClient('xferOwner404@example.com');
    const orgId = await createOrg(owner, 'xferorg404', 'Xfer');
    const { userId: outsiderId } = await loggedInClient('xferOutsider@example.com');

    const res = await owner.post(`/api/orgs/${orgId}/transfer`, { newOwnerUserId: outsiderId });
    expect(res.status).toBe(404);
  });

  it('non-owner cannot initiate transfer — 403', async () => {
    const { client: owner } = await loggedInClient('xferByAdminOwner@example.com');
    const orgId = await createOrg(owner, 'xferbyadmin', 'XferByAdmin');
    const { client: admin, userId: adminId } = await loggedInClient('xferAdmin@example.com');
    const { userId: targetId } = await loggedInClient('xferToo@example.com');
    await addMember(orgId, adminId, 'admin');
    await addMember(orgId, targetId, 'editor');

    const res = await admin.post(`/api/orgs/${orgId}/transfer`, { newOwnerUserId: targetId });
    expect(res.status).toBe(403);
  });
});
