// Magic-link login: request (no-enumerate), consume, expired token,
// pending-verification users become active on consume.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, locationPath, locationQuery } from './_client';
import {
  applyMigrations,
  dbGet,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('auth /magic-link', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('request → email captured → consume establishes a session', async () => {
    const user = await seedUser({ email: 'magic@example.com' });
    const client = makeClient();

    const req = await client.post('/auth/magic-link/request', { email: user.email });
    expect(req.status).toBe(204);
    expect(capture.emails).toHaveLength(1);
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const link = capture.linkFor(user.email);
    expect(link).toBeTruthy();
    const consume = await client.get(new URL(link!).pathname + new URL(link!).search);
    expect(consume.status).toBe(302);
    expect(locationPath(consume)).toBe('/');
    expect(locationQuery(consume, 'welcome')).toBe('1');
    expect(client.cookie).toMatch(/^gb_session=/);

    const meRes = await client.get('/api/me');
    const me = await client.json<{ user: { id: string } }>(meRes);
    expect(me.user.id).toBe(user.id);
  });

  it('request for unknown email returns 204 (no enumeration) and sends no email', async () => {
    const client = makeClient();
    const res = await client.post('/auth/magic-link/request', { email: 'unknown@example.com' });
    expect(res.status).toBe(204);
    expect(capture.emails).toHaveLength(0);
  });

  it('consume with an expired token redirects to /login?error=magic_link_invalid', async () => {
    const user = await seedUser({ email: 'expire-magic@example.com' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();
    await dbRun(`UPDATE auth_token SET expires_at = ? WHERE kind = 'magic_link'`, 1);

    const consume = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(consume.status).toBe(302);
    expect(locationPath(consume)).toBe('/login');
    expect(locationQuery(consume, 'error')).toBe('magic_link_invalid');
  });

  it('consume with a consumed token redirects to /login?error=magic_link_invalid', async () => {
    const user = await seedUser({ email: 'consumed-magic@example.com' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const first = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(locationQuery(first, 'welcome')).toBe('1');

    const fresh = makeClient();
    const second = await fresh.get(`/auth/magic-link/consume?token=${token}`);
    expect(locationPath(second)).toBe('/login');
    expect(locationQuery(second, 'error')).toBe('magic_link_invalid');
  });

  it('consuming a magic link for a pending_verification user flips them to active', async () => {
    const user = await seedUser({ email: 'pending-magic@example.com', status: 'pending_verification' });
    const client = makeClient();
    await client.post('/auth/magic-link/request', { email: user.email });
    const token = capture.tokenFor(user.email);
    expect(token).toBeTruthy();

    const before = await dbGet<{ status: string }>(`SELECT status FROM user WHERE id = ?`, user.id);
    expect(before?.status).toBe('pending_verification');

    const consume = await client.get(`/auth/magic-link/consume?token=${token}`);
    expect(consume.status).toBe(302);
    expect(locationQuery(consume, 'welcome')).toBe('1');

    const after = await dbGet<{ status: string }>(`SELECT status FROM user WHERE id = ?`, user.id);
    expect(after?.status).toBe('active');
  });
});
