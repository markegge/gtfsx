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
    expect(signup.status).toBe(200);
    const signupBody = (await signup.json()) as { activated: boolean };
    expect(signupBody.activated).toBe(false);
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
    // Verify auto-creates a session and lands signup users on /pricing.
    expect(locationPath(verify)).toBe('/pricing');
    expect(locationQuery(verify, 'source')).toBe('welcome');
    expect(client.cookie).toMatch(/^gb_session=/);

    // DB shows active user.
    const postRow = await dbGet<{ status: string }>(
      `SELECT status FROM user WHERE email = ?`,
      'alice@example.com',
    );
    expect(postRow?.status).toBe('active');

    // Session from verify works against /api/me directly — no separate login.
    const meRes = await client.get('/api/me');
    const me = await client.json<{ user: { email: string; status: string } }>(meRes);
    expect(me.user.email).toBe('alice@example.com');
    expect(me.user.status).toBe('active');
  });

  it('first password verify sends exactly one welcome email with reply_to and NO owner bcc', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: 'welcome@example.com',
      displayName: 'Welcome',
      password: 'correct-horse-battery',
    });
    const link = capture.linkFor('welcome@example.com');
    expect(link).toBeTruthy();
    const linkPath = new URL(link!).pathname + new URL(link!).search;
    const verify = await client.get(linkPath);
    expect(verify.status).toBe(302);

    const welcomes = capture.emails.filter((e) => e.subject.startsWith('Welcome to GTFS·X'));
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].to).toBe('welcome@example.com');
    expect(welcomes[0].reply_to).toBe('hello@gtfsx.com');
    // Owner is no longer BCC'd per-signup — replaced by the daily owner digest.
    expect(welcomes[0].bcc).toBeUndefined();
    // The welcome links at the editor + the two onboarding docs.
    expect(welcomes[0].text).toContain('/docs/quick-start/');
    expect(welcomes[0].text).toContain('/docs/hosted-publishing/');
  });

  it('re-clicking the verify link does NOT send a second welcome email', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: 'once@example.com',
      displayName: 'Once',
      password: 'correct-horse-battery',
    });
    const token = capture.tokenFor('once@example.com')!;
    expect(token).toBeTruthy();

    const first = await client.get(`/auth/verify?token=${token}`);
    expect(first.status).toBe(302);
    expect(capture.emails.filter((e) => e.subject.startsWith('Welcome to GTFS·X'))).toHaveLength(1);

    // Re-click with a fresh client → hits the already-active short-circuit.
    const fresh = makeClient();
    const reuse = await fresh.get(`/auth/verify?token=${token}`);
    expect(reuse.status).toBe(302);
    expect(locationQuery(reuse, 'status')).toBe('already_verified');
    // Still exactly one welcome — the short-circuit returns before the send.
    expect(capture.emails.filter((e) => e.subject.startsWith('Welcome to GTFS·X'))).toHaveLength(1);
  });

  it('a failing welcome send does not break activation (user ends active, 302)', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: 'wfail@example.com',
      displayName: 'WFail',
      password: 'correct-horse-battery',
    });
    const token = capture.tokenFor('wfail@example.com')!;
    expect(token).toBeTruthy();

    // The verify email already went out; from here every Resend call fails. The
    // only send during /verify is the welcome — its failure must be swallowed.
    capture.simulateSendFailure(500, '{"error":"boom"}');
    const verify = await client.get(`/auth/verify?token=${token}`);
    expect(verify.status).toBe(302);
    expect(locationPath(verify)).toBe('/pricing');

    const row = await dbGet<{ status: string }>(
      `SELECT status FROM user WHERE email = ?`,
      'wfail@example.com',
    );
    expect(row?.status).toBe('active');
  });

  it('duplicate signup for an already-active account returns 409 conflict', async () => {
    const client = makeClient();
    await client.post('/auth/signup', {
      email: 'dup@example.com',
      displayName: 'Dup',
      password: 'correct-horse-battery',
    });
    // Move to active so the second attempt hits the "real existing" branch.
    await dbRun(`UPDATE user SET status = 'active' WHERE email = ?`, 'dup@example.com');

    const second = await client.post('/auth/signup', {
      email: 'dup@example.com',
      displayName: 'Dup2',
      password: 'correct-horse-battery2',
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe('conflict');
  });

  it('signup for a pending_verification email is a retry: new password + fresh verify email', async () => {
    const client = makeClient();
    // First attempt establishes the pending user.
    const first = await client.post('/auth/signup', {
      email: 'retry@example.com',
      displayName: 'First',
      password: 'first-password-long',
    });
    expect(first.status).toBe(200);
    expect(capture.emails).toHaveLength(1);
    const firstToken = extractToken(capture.emails[0].text)!;
    expect(firstToken).toBeTruthy();

    // Second signup with a different password + display name — retry path.
    const second = await client.post('/auth/signup', {
      email: 'retry@example.com',
      displayName: 'Second',
      password: 'second-password-long',
    });
    expect(second.status).toBe(200);

    // Old verify token is invalidated.
    const oldTokenResult = await client.get(`/auth/verify?token=${firstToken}`);
    expect(oldTokenResult.status).toBe(302);
    expect(locationQuery(oldTokenResult, 'status')).toBe('invalid');

    // New verify token (the second email) works.
    expect(capture.emails).toHaveLength(2);
    const newToken = extractToken(capture.emails[1].text)!;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(firstToken);
    const verify = await client.get(`/auth/verify?token=${newToken}`);
    expect(verify.status).toBe(302);

    // Login uses the NEW password (not the first).
    const loginOld = await client.post('/auth/login', {
      email: 'retry@example.com',
      password: 'first-password-long',
    });
    expect(loginOld.status).toBe(401);
    const loginNew = await client.post('/auth/login', {
      email: 'retry@example.com',
      password: 'second-password-long',
    });
    expect(loginNew.status).toBe(200);

    // Display name was updated to the one from the retry.
    const row = await dbGet<{ display_name: string }>(
      `SELECT display_name FROM user WHERE email = ?`,
      'retry@example.com',
    );
    expect(row?.display_name).toBe('Second');
  });

  it('stuck pending_verification user with zero credentials can still sign up again', async () => {
    // Reproduces the bug where an early-release PBKDF2-600k crash left a
    // user row behind with no credential. A retry should now succeed.
    await dbRun(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES ('stuck01HXSTUCK000000000000000', 'stuck@example.com', 'Stuck', 'pending_verification', 0, ?, ?)`,
      Date.now(),
      Date.now(),
    );
    const client = makeClient();
    const res = await client.post('/auth/signup', {
      email: 'stuck@example.com',
      displayName: 'Unstuck',
      password: 'fresh-password-long',
    });
    expect(res.status).toBe(200);
    const token = capture.tokenFor('stuck@example.com');
    expect(token).toBeTruthy();

    // Verify and log in.
    await client.get(`/auth/verify?token=${token}`);
    const login = await client.post('/auth/login', {
      email: 'stuck@example.com',
      password: 'fresh-password-long',
    });
    expect(login.status).toBe(200);
  });

  it('fresh signup rolls back the user row when the verify email send fails', async () => {
    capture.simulateSendFailure(401, '{"error":"unauthorized"}');
    const client = makeClient();
    const res = await client.post('/auth/signup', {
      email: 'rollback@example.com',
      displayName: 'Rollback',
      password: 'correct-horse-battery',
    });
    expect(res.status).toBe(502);

    // User row must be gone — otherwise the email would be blocked from
    // re-signing-up until manual DB cleanup (the original bug).
    const row = await dbGet(`SELECT id FROM user WHERE email = ?`, 'rollback@example.com');
    expect(row).toBeNull();

    // And indeed a fresh signup on the same email now succeeds.
    capture.failWith = undefined;
    const retry = await client.post('/auth/signup', {
      email: 'rollback@example.com',
      displayName: 'Rollback',
      password: 'correct-horse-battery',
    });
    expect(retry.status).toBe(200);
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

  it('fresh + conflict signups both incur the 200ms floor (no timing enumeration)', async () => {
    const client = makeClient();

    const freshStart = Date.now();
    const fresh = await client.post('/auth/signup', {
      email: 'timing@example.com',
      displayName: 'Timing',
      password: 'correct-horse-battery',
    });
    expect(fresh.status).toBe(200);
    const freshElapsed = Date.now() - freshStart;
    expect(freshElapsed).toBeGreaterThanOrEqual(180);

    // Promote to active so the next signup hits the "real existing" 409 path
    // (pending_verification goes through retry now).
    await dbRun(`UPDATE user SET status = 'active' WHERE email = ?`, 'timing@example.com');

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
    expect(locationPath(first)).toBe('/pricing');
    expect(locationQuery(first, 'source')).toBe('welcome');

    // Reusing a fresh client so we're not sending the session cookie. The
    // token is consumed and the user is active, so the friendlier
    // "already verified" page is the right landing — not the invalid page.
    const fresh = makeClient();
    const reuse = await fresh.get(`/auth/verify?token=${token}`);
    expect(reuse.status).toBe(302);
    expect(locationPath(reuse)).toBe('/verify-email');
    expect(locationQuery(reuse, 'status')).toBe('already_verified');
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

  it('signup returns 502 email_send_failed when Resend send fails', async () => {
    capture.simulateSendFailure(401, '{"error":"unauthorized"}');
    const client = makeClient();
    const res = await client.post('/auth/signup', {
      email: 'sendfail@example.com',
      displayName: 'SendFail',
      password: 'correct-horse-battery',
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('email_send_failed');
    expect(body.message).toMatch(/contact the administrator/i);
  });
});

describe('auth /verify-resend (public)', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('sends a fresh verify link for a pending_verification user', async () => {
    // Seed a pending user directly (skip signup's own email send).
    await dbRun(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES ('01J000000000000000000RESEND', 'resend@example.com', 'R', 'pending_verification', 0, ?, ?)`,
      Date.now(),
      Date.now(),
    );

    const client = makeClient();
    const res = await client.post('/auth/verify-resend', { email: 'resend@example.com' });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(1);
    const link = capture.linkFor('resend@example.com');
    expect(link).toMatch(/\/auth\/verify\?token=/);
  });

  it('silently 204s for an already-active user (no enumeration, no email sent)', async () => {
    await dbRun(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES ('01J000000000000000000ACTIVE', 'active@example.com', 'A', 'active', 0, ?, ?)`,
      Date.now(),
      Date.now(),
    );
    const client = makeClient();
    const res = await client.post('/auth/verify-resend', { email: 'active@example.com' });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(0);
  });

  it('silently 204s for an unknown email', async () => {
    const client = makeClient();
    const res = await client.post('/auth/verify-resend', { email: 'nobody@example.com' });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(0);
  });

  it('does NOT require auth (public endpoint)', async () => {
    const client = makeClient();
    // No session cookie. Should still accept the request (returns 204 even for unknown).
    const res = await client.post('/auth/verify-resend', { email: 'anyone@example.com' });
    expect(res.status).toBe(204);
  });
});
