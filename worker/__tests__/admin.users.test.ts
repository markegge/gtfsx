// /api/admin/users — list/filter/paginate, detail, patch, resend verification,
// soft-delete.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbGet,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function staffClient(email = 'admin@example.com'): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email, staff: true });
  const client = makeClient();
  const res = await client.post('/auth/login', { email: user.email, password: user.password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { client, userId: user.id };
}

interface UserListResp {
  users: Array<{
    id: string;
    email: string;
    status: string;
    staff: boolean;
    createdAt: number;
    lastSessionAt: number | null;
    projectCount: number;
  }>;
  nextCursor: string | null;
}

describe('/api/admin/users list + filter + pagination', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('lists users newest first with lastSessionAt and projectCount', async () => {
    const { client } = await staffClient();
    const u1 = await seedUser({ email: 'user1@example.com' });
    await seedUser({ email: 'user2@example.com' });

    const res = await client.get('/api/admin/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserListResp;
    expect(body.users.length).toBe(3); // staff + 2 users
    // Newest first — the last-seeded user comes first.
    expect(body.users[0].email).toBe('user2@example.com');

    // Ensure shape is complete.
    const staffEntry = body.users.find((u) => u.staff);
    expect(staffEntry).toBeTruthy();
    expect(typeof staffEntry!.createdAt).toBe('number');
    expect(staffEntry!.projectCount).toBe(0);
    // The staff user logged in, so they should have a lastSessionAt.
    expect(staffEntry!.lastSessionAt).not.toBeNull();

    // u1 never logged in: lastSessionAt is null.
    const u1Entry = body.users.find((u) => u.id === u1.id);
    expect(u1Entry!.lastSessionAt).toBeNull();
  });

  it('filters by email substring (case-insensitive)', async () => {
    const { client } = await staffClient();
    await seedUser({ email: 'alice@Acme.co' });
    await seedUser({ email: 'bob@example.com' });

    const res = await client.get('/api/admin/users?q=ACME');
    const body = (await res.json()) as UserListResp;
    expect(body.users.length).toBe(1);
    expect(body.users[0].email.toLowerCase()).toContain('acme');
  });

  it('filters by status', async () => {
    const { client } = await staffClient();
    await seedUser({ email: 'pending@example.com', status: 'pending_verification' });
    await seedUser({ email: 'disabled@example.com', status: 'disabled' });
    await seedUser({ email: 'active@example.com', status: 'active' });

    const p = await client.get('/api/admin/users?status=pending_verification');
    const pBody = (await p.json()) as UserListResp;
    expect(pBody.users.length).toBe(1);
    expect(pBody.users[0].status).toBe('pending_verification');

    const d = await client.get('/api/admin/users?status=disabled');
    const dBody = (await d.json()) as UserListResp;
    expect(dBody.users.length).toBe(1);
    expect(dBody.users[0].status).toBe('disabled');
  });

  it('paginates via page / pageSize, returns nextCursor when more available', async () => {
    const { client } = await staffClient();
    for (let i = 0; i < 5; i++) await seedUser({ email: `p-${i}@example.com` });

    const page1 = await client.get('/api/admin/users?pageSize=2&page=1');
    const body1 = (await page1.json()) as UserListResp;
    expect(body1.users.length).toBe(2);
    expect(body1.nextCursor).not.toBeNull();

    const page3 = await client.get('/api/admin/users?pageSize=2&page=3');
    const body3 = (await page3.json()) as UserListResp;
    // 6 total (1 staff + 5 users) → page 3 has 2 entries, nextCursor null.
    expect(body3.users.length).toBe(2);
    expect(body3.nextCursor).toBeNull();
  });
});

describe('/api/admin/users/:id detail', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('returns user detail + memberships + audit', async () => {
    const { client, userId: staffId } = await staffClient();
    const target = await seedUser({ email: 'target@example.com' });

    // Trigger an admin action that writes an audit entry against target.
    await client.post(`/api/admin/users/${target.id}/delete`);

    const res = await client.get(`/api/admin/users/${target.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; status: string };
      memberships: unknown[];
      auditEvents: Array<{ action: string; actorUserId: string | null }>;
    };
    expect(body.user.id).toBe(target.id);
    expect(body.user.status).toBe('deleted_soft');
    expect(body.memberships).toEqual([]);
    const admin = body.auditEvents.find((e) => e.action === 'admin.user.delete');
    expect(admin).toBeTruthy();
    expect(admin!.actorUserId).toBe(staffId);
  });

  it('404 for unknown id', async () => {
    const { client } = await staffClient();
    const res = await client.get('/api/admin/users/doesnotexist');
    expect(res.status).toBe(404);
  });
});

describe('/api/admin/users/:id PATCH', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('flips status active ↔ disabled and revokes sessions on disable', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'flip@example.com' });

    // Give the target a live session by logging them in from their own client.
    const tClient = makeClient();
    await tClient.post('/auth/login', { email: target.email, password: target.password });
    expect((await tClient.get('/api/me')).status).toBe(200);

    const disable = await client.patch(`/api/admin/users/${target.id}`, { status: 'disabled' });
    expect(disable.status).toBe(200);
    const body = (await disable.json()) as { user: { status: string } };
    expect(body.user.status).toBe('disabled');

    // Target's session is revoked.
    const sessions = await dbAll<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`, target.id,
    );
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);

    // Re-enable.
    const enable = await client.patch(`/api/admin/users/${target.id}`, { status: 'active' });
    expect(enable.status).toBe(200);
    const body2 = (await enable.json()) as { user: { status: string } };
    expect(body2.user.status).toBe('active');

    // Audit event written.
    const audit = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event WHERE subject_type='user' AND subject_id=? AND action LIKE 'admin.%'`,
      target.id,
    );
    expect(audit.some((a) => a.action === 'admin.user.patch')).toBe(true);
  });

  it('can toggle staff flag', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'promote@example.com' });

    const res = await client.patch(`/api/admin/users/${target.id}`, { staff: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { staff: boolean } };
    expect(body.user.staff).toBe(true);

    const row = await dbGet<{ staff: number }>(`SELECT staff FROM user WHERE id = ?`, target.id);
    expect(row?.staff).toBe(1);
  });

  it('rejects an attempt to set status on a deleted_soft user', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'gone@example.com', status: 'deleted_soft' });
    const res = await client.patch(`/api/admin/users/${target.id}`, { status: 'active' });
    expect(res.status).toBe(409);
  });
});

describe('/api/admin/users/:id/resend-verification', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('happy path: sends a fresh verify email, 204', async () => {
    const { client } = await staffClient();
    const target = await seedUser({
      email: 'resend@example.com',
      status: 'pending_verification',
    });

    const res = await client.post(`/api/admin/users/${target.id}/resend-verification`);
    expect(res.status).toBe(204);
    expect(capture.emails.some((e) => e.to === 'resend@example.com')).toBe(true);
    expect(capture.tokenFor('resend@example.com')).toBeTruthy();

    const audit = await dbAll<{ action: string }>(
      `SELECT action FROM audit_event WHERE action = 'admin.user.resend_verification' AND subject_id = ?`,
      target.id,
    );
    expect(audit.length).toBe(1);
  });

  it('409 when user is already active', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'already-active@example.com', status: 'active' });

    const res = await client.post(`/api/admin/users/${target.id}/resend-verification`);
    expect(res.status).toBe(409);
  });
});

describe('/api/admin/users/:id/delete', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('soft-deletes and revokes sessions', async () => {
    const { client } = await staffClient();
    const target = await seedUser({ email: 'sd@example.com' });

    // Log the target in first.
    const tClient = makeClient();
    await tClient.post('/auth/login', { email: target.email, password: target.password });
    expect((await tClient.get('/api/me')).status).toBe(200);

    const res = await client.post(`/api/admin/users/${target.id}/delete`);
    expect(res.status).toBe(204);

    const row = await dbGet<{ status: string; deleted_at: number | null }>(
      `SELECT status, deleted_at FROM user WHERE id = ?`, target.id,
    );
    expect(row?.status).toBe('deleted_soft');
    expect(row?.deleted_at).not.toBeNull();

    const sessions = await dbAll<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`, target.id,
    );
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);

    // Target's GET /api/me is now 401 (session revoked) or 403 (deleted). Either works.
    const me = await tClient.get('/api/me');
    expect([401, 403]).toContain(me.status);
  });
});
