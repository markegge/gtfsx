// Organization invitations: invite → email capture → accept → mismatched
// email → 403, expired/consumed token, rescind pending.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  env as testEnv,
  dbGet,
  dbRun,
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

async function createOrg(client: TestClient, slug: string, name: string): Promise<string> {
  const res = await client.post('/api/orgs', { slug, name });
  const body = await client.json<{ organization: { id: string } }>(res);
  // Tests bypass the Stripe-driven upgrade flow: promote new orgs to team so
  // feature-gated endpoints (invitations, logo, publish) are reachable.
  await testEnv.DB.prepare('UPDATE organization SET plan = ? WHERE id = ?')
    .bind('team', body.organization.id)
    .run();
  return body.organization.id;
}

describe('/api/orgs invitations', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('owner invites an editor; invitee accepts via the email link and joins the org', async () => {
    const { client: owner } = await loggedInClient('invOwner@example.com');
    const orgId = await createOrg(owner, 'inviteorg', 'Invite Org');

    const invRes = await owner.post(`/api/orgs/${orgId}/invitations`, {
      email: 'invitee@example.com',
      role: 'editor',
    });
    expect(invRes.status).toBe(204);
    expect(capture.emails).toHaveLength(1);
    expect(capture.emails[0].to).toBe('invitee@example.com');

    const token = capture.tokenFor('invitee@example.com');
    expect(token).toBeTruthy();

    // Invitee signs up / is seeded then logs in.
    const { client: invitee, userId: inviteeId } = await loggedInClient('invitee@example.com');

    const accept = await invitee.post('/api/orgs/invitations/accept', { token });
    expect(accept.status).toBe(200);
    const body = await invitee.json<{ organization: { id: string }; role: string }>(accept);
    expect(body.organization.id).toBe(orgId);
    expect(body.role).toBe('editor');

    // Verify membership row.
    const m = await dbGet<{ role: string }>(
      `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
      orgId,
      inviteeId,
    );
    expect(m?.role).toBe('editor');

    // Token consumed — second accept returns 422.
    const again = await invitee.post('/api/orgs/invitations/accept', { token });
    expect(again.status).toBe(422);
  });

  it('accepting with a different email address returns 403 forbidden', async () => {
    const { client: owner } = await loggedInClient('mismatchOwner@example.com');
    const orgId = await createOrg(owner, 'mismatchorg', 'Mismatch');

    await owner.post(`/api/orgs/${orgId}/invitations`, {
      email: 'intended@example.com',
      role: 'viewer',
    });
    const token = capture.tokenFor('intended@example.com');
    expect(token).toBeTruthy();

    // A different user tries to accept.
    const { client: wrongUser } = await loggedInClient('someone-else@example.com');
    const res = await wrongUser.post('/api/orgs/invitations/accept', { token });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/different email/i);
  });

  it('expired invitation is rejected with 422', async () => {
    const { client: owner } = await loggedInClient('expOwner@example.com');
    const orgId = await createOrg(owner, 'exporg', 'Exp');

    await owner.post(`/api/orgs/${orgId}/invitations`, {
      email: 'expired@example.com',
      role: 'editor',
    });
    const token = capture.tokenFor('expired@example.com');
    expect(token).toBeTruthy();

    // Backdate expiry.
    await dbRun(`UPDATE auth_token SET expires_at = ? WHERE kind = 'invitation'`, 1);

    const { client: invitee } = await loggedInClient('expired@example.com');
    const res = await invitee.post('/api/orgs/invitations/accept', { token });
    expect(res.status).toBe(422);
  });

  it('admin can invite editor/viewer but NOT admin (403)', async () => {
    const { client: owner } = await loggedInClient('adminInvOwner@example.com');
    const orgId = await createOrg(owner, 'admininvorg', 'AdminInv');
    const { client: admin, userId: adminId } = await loggedInClient('anAdmin@example.com');
    await testEnv.DB.prepare(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)`,
    )
      .bind(orgId, adminId, Date.now())
      .run();

    const ok = await admin.post(`/api/orgs/${orgId}/invitations`, {
      email: 'junior@example.com',
      role: 'editor',
    });
    expect(ok.status).toBe(204);

    const bad = await admin.post(`/api/orgs/${orgId}/invitations`, {
      email: 'another-admin@example.com',
      role: 'admin',
    });
    expect(bad.status).toBe(403);
  });

  it('invitation to unknown email still returns 204 (no enumeration)', async () => {
    const { client: owner } = await loggedInClient('enumOwner@example.com');
    const orgId = await createOrg(owner, 'enumorg', 'Enum');

    const res = await owner.post(`/api/orgs/${orgId}/invitations`, {
      email: 'no-such-user@example.com',
      role: 'viewer',
    });
    expect(res.status).toBe(204);
    // Email still sent (target might sign up later).
    expect(capture.emails).toHaveLength(1);
  });

  it('GET /api/orgs/:id/invitations lists pending invitations for admins', async () => {
    const { client: owner } = await loggedInClient('listInvOwner@example.com');
    const orgId = await createOrg(owner, 'listinvorg', 'ListInv');
    await owner.post(`/api/orgs/${orgId}/invitations`, { email: 'p1@example.com', role: 'editor' });
    await owner.post(`/api/orgs/${orgId}/invitations`, { email: 'p2@example.com', role: 'viewer' });

    const res = await owner.get(`/api/orgs/${orgId}/invitations`);
    expect(res.status).toBe(200);
    const body = await owner.json<{
      invitations: { email: string; role: string; tokenHash: string }[];
    }>(res);
    const emails = body.invitations.map((i) => i.email).sort();
    expect(emails).toEqual(['p1@example.com', 'p2@example.com']);
    // Tokens are represented by their hashes (no cleartext).
    for (const inv of body.invitations) {
      expect(inv.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('DELETE /api/orgs/:id/invitations/:tokenHash rescinds a pending invitation', async () => {
    const { client: owner } = await loggedInClient('rescindOwner@example.com');
    const orgId = await createOrg(owner, 'rescindorg', 'Rescind');
    await owner.post(`/api/orgs/${orgId}/invitations`, { email: 'rescind@example.com', role: 'viewer' });

    // Pull the token hash.
    const list = await owner.json<{ invitations: { tokenHash: string }[] }>(
      await owner.get(`/api/orgs/${orgId}/invitations`),
    );
    const tokenHash = list.invitations[0].tokenHash;

    const del = await owner.delete(`/api/orgs/${orgId}/invitations/${tokenHash}`);
    expect(del.status).toBe(204);

    // Try to accept — rescinded.
    const token = capture.tokenFor('rescind@example.com');
    const { client: invitee } = await loggedInClient('rescind@example.com');
    const res = await invitee.post('/api/orgs/invitations/accept', { token });
    expect(res.status).toBe(422); // consumed

    // List no longer includes it.
    const after = await owner.json<{ invitations: { tokenHash: string }[] }>(
      await owner.get(`/api/orgs/${orgId}/invitations`),
    );
    expect(after.invitations.find((i) => i.tokenHash === tokenHash)).toBeUndefined();
  });

  it('non-admin cannot view or rescind invitations', async () => {
    const { client: owner } = await loggedInClient('nrOwner@example.com');
    const orgId = await createOrg(owner, 'nrlistorg', 'NRList');
    const { client: editor, userId: editorId } = await loggedInClient('nrEditor@example.com');
    await testEnv.DB.prepare(
      `INSERT INTO organization_membership (org_id, user_id, role, created_at) VALUES (?, ?, 'editor', ?)`,
    )
      .bind(orgId, editorId, Date.now())
      .run();

    const list = await editor.get(`/api/orgs/${orgId}/invitations`);
    expect(list.status).toBe(403);
  });

  it('pending invitations for the current user are surfaced at /api/orgs/invitations/pending', async () => {
    const { client: owner } = await loggedInClient('pendOwner@example.com');
    const orgId = await createOrg(owner, 'pendorg', 'Pend');
    await owner.post(`/api/orgs/${orgId}/invitations`, { email: 'pending@example.com', role: 'editor' });

    const { client: invitee } = await loggedInClient('pending@example.com');
    const res = await invitee.get('/api/orgs/invitations/pending');
    expect(res.status).toBe(200);
    const body = await invitee.json<{
      invitations: { orgId: string; orgName: string; role: string; expiresAt: number }[];
    }>(res);
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].orgId).toBe(orgId);
    expect(body.invitations[0].orgName).toBe('Pend');
    expect(body.invitations[0].role).toBe('editor');
  });
});
