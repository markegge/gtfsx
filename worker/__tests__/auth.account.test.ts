// /api/me account-management routes: display-name update, change password,
// change email (with duplicate collision), delete account.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbGet,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('/api/me account management', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('PATCH /api/me updates display name', async () => {
    const user = await seedUser({ email: 'patch@example.com', displayName: 'Old Name' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.patch('/api/me', { displayName: 'New Name' });
    const body = await client.json<{ user: { displayName: string } }>(res);
    expect(body.user.displayName).toBe('New Name');

    const row = await dbGet<{ display_name: string }>(`SELECT display_name FROM user WHERE id = ?`, user.id);
    expect(row?.display_name).toBe('New Name');
  });

  it('change-password: wrong current returns 401; correct revokes other sessions but keeps this one', async () => {
    const user = await seedUser({ email: 'chpw@example.com', password: 'original-hunter2' });

    // Two sessions: c1 performs the change, c2 should be revoked.
    const c1 = makeClient();
    await c1.post('/auth/login', { email: user.email, password: user.password });
    const c2 = makeClient();
    await c2.post('/auth/login', { email: user.email, password: user.password });

    const bad = await c1.post('/api/me/change-password', {
      currentPassword: 'wrong-wrong-wrong',
      newPassword: 'brand-new-passw0rd',
    });
    expect(bad.status).toBe(401);

    const ok = await c1.post('/api/me/change-password', {
      currentPassword: 'original-hunter2',
      newPassword: 'brand-new-passw0rd',
    });
    expect(ok.status).toBe(204);

    // c1 still works; c2 is revoked.
    expect((await c1.get('/api/me')).status).toBe(200);
    expect((await c2.get('/api/me')).status).toBe(401);
  });

  it('change-email: request → confirm → user.email updated', async () => {
    const user = await seedUser({ email: 'old@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const req = await client.post('/api/me/change-email', { newEmail: 'new@example.com' });
    expect(req.status).toBe(204);

    // The verify email is sent to the NEW address.
    expect(capture.emails.some((e) => e.to === 'new@example.com')).toBe(true);
    const token = capture.tokenFor('new@example.com');
    expect(token).toBeTruthy();

    const confirm = await client.post('/api/me/change-email/confirm', { token });
    expect(confirm.status).toBe(204);

    const row = await dbGet<{ email: string }>(`SELECT email FROM user WHERE id = ?`, user.id);
    expect(row?.email).toBe('new@example.com');
  });

  it('change-email collision with another user returns 409', async () => {
    await seedUser({ email: 'taken@example.com' });
    const user = await seedUser({ email: 'wants-taken@example.com' });

    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.post('/api/me/change-email', { newEmail: 'taken@example.com' });
    expect(res.status).toBe(409);
  });

  it('DELETE /api/me with correct password soft-deletes and revokes sessions', async () => {
    const user = await seedUser({ email: 'goodbye@example.com', password: 'original-hunter2' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    // Wrong password is rejected.
    const bad = await client.delete('/api/me', { password: 'wrong-wrong-wrong' });
    expect(bad.status).toBe(401);
    expect((await client.get('/api/me')).status).toBe(200);

    const ok = await client.delete('/api/me', { password: 'original-hunter2' });
    expect(ok.status).toBe(204);

    // Session and user are gone.
    expect((await client.get('/api/me')).status).toBe(401);
    const row = await dbGet<{ status: string; deleted_at: number | null }>(
      `SELECT status, deleted_at FROM user WHERE id = ?`,
      user.id,
    );
    expect(row?.status).toBe('deleted_soft');
    expect(row?.deleted_at).not.toBeNull();
  });

  it('DELETE /api/me without password returns 422 (password confirmation required)', async () => {
    const user = await seedUser({ email: 'nopwdelete@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.delete('/api/me', {});
    expect(res.status).toBe(422);
  });
});
