// Password reset: request → confirm → old sessions revoked, old password fails.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ApiError, makeClient } from './_client';
import {
  applyMigrations,
  dbAll,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('auth /password-reset', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('request → confirm new password → old sessions revoked and old password fails', async () => {
    const user = await seedUser({ email: 'reset@example.com', password: 'original-hunter2' });

    // Log in so we have a live session to invalidate.
    const loggedIn = makeClient();
    await loggedIn.post('/auth/login', { email: user.email, password: user.password });
    const meBefore = await loggedIn.get('/api/me');
    expect(meBefore.status).toBe(200);

    // Request reset. A separate client to not mix cookies.
    const requester = makeClient();
    const req = await requester.post('/auth/password-reset/request', { email: user.email });
    expect(req.status).toBe(204);
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    // Confirm with a new password.
    const confirmRes = await requester.post('/auth/password-reset/confirm', {
      token,
      password: 'brand-new-passw0rd',
    });
    expect(confirmRes.status).toBe(204);

    // Old session is revoked.
    const meAfter = await loggedIn.get('/api/me');
    expect(meAfter.status).toBe(401);

    // Old password fails.
    const oldPw = makeClient();
    const oldRes = await oldPw.post('/auth/login', { email: user.email, password: 'original-hunter2' });
    expect(oldRes.status).toBe(401);

    // New password works.
    const newPw = makeClient();
    const newRes = await newPw.post('/auth/login', { email: user.email, password: 'brand-new-passw0rd' });
    expect(newRes.status).toBe(200);
  });

  it('other pending reset tokens are invalidated on confirm', async () => {
    const user = await seedUser({ email: 'two-tokens@example.com' });
    const client = makeClient();

    await client.post('/auth/password-reset/request', { email: user.email });
    const token1 = capture.tokenFor(user.email);

    // Request a second reset — now there are two unconsumed tokens.
    capture.emails.length = 0;
    await client.post('/auth/password-reset/request', { email: user.email });
    const token2 = capture.tokenFor(user.email);
    expect(token1).toBeTruthy();
    expect(token2).toBeTruthy();
    expect(token1).not.toBe(token2);

    const pendingBefore = await dbAll(
      `SELECT token_hash FROM auth_token WHERE user_id = ? AND kind = 'password_reset' AND consumed_at IS NULL`,
      user.id,
    );
    expect(pendingBefore.length).toBe(2);

    // Consume the second token.
    await client.post('/auth/password-reset/confirm', { token: token2, password: 'brand-new-passw0rd' });

    const pendingAfter = await dbAll(
      `SELECT token_hash FROM auth_token WHERE user_id = ? AND kind = 'password_reset' AND consumed_at IS NULL`,
      user.id,
    );
    expect(pendingAfter.length).toBe(0);

    // token1 is now invalid — confirming against it should 422.
    const reuse = await client.post('/auth/password-reset/confirm', { token: token1, password: 'other-passw0rd' });
    expect(reuse.status).toBe(422);
  });

  it('unknown email on request returns 204 and sends no email', async () => {
    const client = makeClient();
    const res = await client.post('/auth/password-reset/request', { email: 'nobody@example.com' });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(0);
  });

  it('confirm with a bogus token returns 422', async () => {
    const client = makeClient();
    const res = await client.post('/auth/password-reset/confirm', {
      token: 'totally-not-a-valid-token',
      password: 'brand-new-passw0rd',
    });
    await expect(client.json(res)).rejects.toMatchObject({ status: 422 } as Partial<ApiError>);
  });
});
