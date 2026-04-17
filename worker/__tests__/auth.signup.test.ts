// Signup flow: happy path, duplicate email, timing-equalization against
// enumeration, CSRF, expired/consumed verify tokens.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, locationPath, locationQuery } from './_client';
import {
  applyMigrations,
  resetDb,
  setupEmailCapture,
  extractToken,
  dbGet,
  dbRun,
  type EmailCapture,
} from './_setup';

describe('auth /signup + /verify', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('signup → email → verify activates the user and returns a valid session', async () => {
    const client = makeClient();
    const signup = await client.post('/auth/signup', {
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'correct-horse-battery',
    });
    expect(signup.status).toBe(204);
    expect(capture.emails).toHaveLength(1);
    expect(capture.emails[0].to).toBe('alice@example.com');

    const token = capture.tokenFor('alice@example.com');
    expect(token).toBeTruthy();

    // Before verify: the user row exists but is pending_verification.
    const preRow = await dbGet<{ status: string }>(
      `SELECT status FROM user WHERE email = ?`,
      'alice@example.com',
    );
    expect(preRow?.status).toBe('pending_verification');

    // Follow the actual link from the email — catches any mismatch between the
    // URL the Worker emails and the endpoint that actually consumes the token.
    const link = capture.linkFor('alice@example.com');
    expect(link).toBeTruthy();
    const linkPath = new URL(link!).pathname + new URL(link!).search;
    const verify = await client.get(linkPath);
    expect(verify.status).toBe(302);
    expect(locationPath(verify)).toBe('/');
    expect(locationQuery(verify, 'welcome')).toBe('1');
    expect(client.cookie).toMatch(/^gb_session=/);

    // DB shows active user.
    const postRow = await dbGet<{ status: string }>(
      `SELECT status FROM user WHERE email = ?`,
      'alice@example.com',
    );
    expect(postRow?.status).toBe('active');

    // /api/me works with the session cookie.
    const meRes = await client.get('/api/me');
    const me = await client.json<{ user: { email: string; status: string } }>(meRes);
    expect(me.user.email).toBe('alice@example.com');
    expect(me.user.status).toBe('active');
  });

  it('duplicate signup returns 409 conflict', async () => {
    const client = makeClient();
    const first = await client.post('/auth/signup', {
      email: 'dup@example.com',
      displayName: 'Dup',
      password: 'correct-horse-battery',
    });
    expect(first.status).toBe(204);

    const second = await client.post('/auth/signup', {
      email: 'dup@example.com',
      displayName: 'Dup2',
      password: 'correct-horse-battery2',
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('conflict');
  });

  it('invalid payload returns 422 validation_failed', async () => {
    const client = makeClient();
    const res = await client.post('/auth/signup', {
      email: 'not-an-email',
      displayName: '',
      password: 'short',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_failed');
  });

  it('missing X-GB-Client header returns 422 (CSRF defense)', async () => {
    const client = makeClient();
    const res = await client.post(
      '/auth/signup',
      {
        email: 'csrf@example.com',
        displayName: 'CSRF',
        password: 'correct-horse-battery',
      },
      { noClientHeader: true },
    );
    expect(res.status).toBe(422);
  });

  it('both fresh-email and duplicate signups incur the 200ms floor (no timing enumeration)', async () => {
    const client = makeClient();

    const freshStart = Date.now();
    const fresh = await client.post('/auth/signup', {
      email: 'timing@example.com',
      displayName: 'Timing',
      password: 'correct-horse-battery',
    });
    expect(fresh.status).toBe(204);
    const freshElapsed = Date.now() - freshStart;
    expect(freshElapsed).toBeGreaterThanOrEqual(180);

    const dupStart = Date.now();
    const dup = await client.post('/auth/signup', {
      email: 'timing@example.com',
      displayName: 'Timing',
      password: 'correct-horse-battery',
    });
    const dupElapsed = Date.now() - dupStart;
    expect(dup.status).toBe(409);
    expect(dupElapsed).toBeGreaterThanOrEqual(180);
  });

  it('verify with an expired token redirects to /verify-email?status=invalid', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: 'expired@example.com',
      displayName: 'Exp',
      password: 'correct-horse-battery',
    });
    const token = capture.tokenFor('expired@example.com');
    expect(token).toBeTruthy();

    // Backdate the token's expiry.
    await dbRun(`UPDATE auth_token SET expires_at = ? WHERE kind = 'verify_email'`, 1);

    const res = await client.get(`/auth/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(locationPath(res)).toBe('/verify-email');
    expect(locationQuery(res, 'status')).toBe('invalid');
  });

  it('verify with an already-consumed token redirects to /verify-email?status=invalid', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: 'consumed@example.com',
      displayName: 'Con',
      password: 'correct-horse-battery',
    });
    const token = capture.tokenFor('consumed@example.com');
    expect(token).toBeTruthy();

    const first = await client.get(`/auth/verify?token=${token}`);
    expect(first.status).toBe(302);
    expect(locationQuery(first, 'welcome')).toBe('1');

    // Reusing a fresh client so we're not sending the session cookie — the
    // redirect target should still be the invalid path.
    const fresh = makeClient();
    const reuse = await fresh.get(`/auth/verify?token=${token}`);
    expect(reuse.status).toBe(302);
    expect(locationPath(reuse)).toBe('/verify-email');
    expect(locationQuery(reuse, 'status')).toBe('invalid');
  });

  it('verify with a bogus token redirects to /verify-email?status=invalid', async () => {
    const client = makeClient();
    const res = await client.get('/auth/verify?token=not-a-real-token');
    expect(res.status).toBe(302);
    expect(locationPath(res)).toBe('/verify-email');
    expect(locationQuery(res, 'status')).toBe('invalid');
    // extractToken sanity-check
    expect(extractToken('/foo?token=abc123')).toBe('abc123');
  });
});
