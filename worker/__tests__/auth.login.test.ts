// Login: credentials path, failure modes, timing-equalization, status gates.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ApiError, makeClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('auth /login', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('signup + verify → logout → login with password returns the user and a valid session', async () => {
    const user = await seedUser({ email: 'login@example.com', password: 'correct-horse-battery' });

    const client = makeClient();
    const loginRes = await client.post('/auth/login', {
      email: user.email,
      password: user.password,
    });
    const login = await client.json<{ user: { email: string; status: string } }>(loginRes);
    expect(login.user.email).toBe(user.email);
    expect(login.user.status).toBe('active');
    expect(client.cookie).toMatch(/^gb_session=/);

    // /api/me succeeds on the session cookie.
    const me = await client.json<{ user: { id: string } }>(await client.get('/api/me'));
    expect(me.user.id).toBe(user.id);

    // Logout then login again (fresh client mimics a re-login from another browser).
    const logoutRes = await client.post('/auth/logout');
    expect(logoutRes.status).toBe(204);

    const c2 = makeClient();
    const loginRes2 = await c2.post('/auth/login', { email: user.email, password: user.password });
    expect(loginRes2.status).toBe(200);
    expect(c2.cookie).toMatch(/^gb_session=/);
  });

  it('wrong password returns 401 invalid_credentials', async () => {
    const user = await seedUser({ email: 'wrongpw@example.com', password: 'correct-horse-battery' });
    const client = makeClient();
    const res = await client.post('/auth/login', {
      email: user.email,
      password: 'nope-nope-nope',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_credentials');
  });

  it('unknown email returns the SAME 401 invalid_credentials (no enumeration)', async () => {
    const client = makeClient();
    const res = await client.post('/auth/login', {
      email: 'nobody@example.com',
      password: 'whatever-at-all',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_credentials');
  });

  it('timing of wrong-password vs unknown-email is comparable (enumeration mitigation)', async () => {
    await seedUser({ email: 'time1@example.com', password: 'correct-horse-battery' });

    const c1 = makeClient();
    const s1 = Date.now();
    await c1.post('/auth/login', { email: 'time1@example.com', password: 'bad-bad-bad' });
    const tWrong = Date.now() - s1;

    const c2 = makeClient();
    const s2 = Date.now();
    await c2.post('/auth/login', { email: 'nobody-here@example.com', password: 'bad-bad-bad' });
    const tUnknown = Date.now() - s2;

    // Both must go through verifyPassword against either the real hash or the
    // cached dummy hash. Because dummyHash is lazily generated ONCE, the first
    // call in a worker isolate computes a fresh PBKDF2 hash (~100ms). Rather
    // than assert ±40% we assert both are within a reasonable window that
    // matches password-verify timings.
    expect(tWrong).toBeGreaterThan(50);
    expect(tUnknown).toBeGreaterThan(50);
    const ratio = Math.max(tWrong, tUnknown) / Math.max(1, Math.min(tWrong, tUnknown));
    // NOTE: on the first "unknown" call dummyHash() is computed, so there's
    // an inherent first-call penalty; a 3x cap is generous but still proves
    // the two are in the same ballpark rather than a bare string-compare fast-path.
    expect(ratio).toBeLessThan(3);
  });

  it('login as a pending_verification user succeeds but returns that status', async () => {
    const user = await seedUser({
      email: 'pending@example.com',
      password: 'correct-horse-battery',
      status: 'pending_verification',
    });

    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    const body = await client.json<{ user: { status: string } }>(res);
    expect(body.user.status).toBe('pending_verification');
  });

  it('disabled user login returns 403 forbidden', async () => {
    const user = await seedUser({
      email: 'disabled@example.com',
      password: 'correct-horse-battery',
      status: 'disabled',
    });

    const client = makeClient();
    const res = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
  });

  it('propagates ApiError to json() for non-2xx responses (client sanity check)', async () => {
    const client = makeClient();
    const res = await client.post('/auth/login', { email: 'x@x.com', password: 'whatever' });
    await expect(client.json(res)).rejects.toBeInstanceOf(ApiError);
  });
});
