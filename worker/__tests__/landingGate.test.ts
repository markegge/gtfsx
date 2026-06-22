// The "/" landing gate: logged-out visitors get the marketing page; only a
// VALID session redirects to /editor. Regression guard for the stale-cookie bug
// where a merely-present (but expired/invalid) gb_session cookie trapped
// logged-out visitors in the editor.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient, locationPath } from './_client';
import { applyMigrations, resetDb, seedUser, setupEmailCapture, type EmailCapture } from './_setup';

describe("landing gate at '/'", () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('does not redirect a logged-out visitor (no cookie) to /editor', async () => {
    const client = makeClient();
    const res = await client.get('/', { noCookie: true });
    expect(res.status).not.toBe(302);
  });

  it('does not redirect a stale/invalid gb_session cookie to /editor', async () => {
    // Presence != validity: a bogus token must still land on the marketing page.
    const client = makeClient();
    client.setCookie('gb_session=stale-bogus-token-not-in-db');
    const res = await client.get('/');
    expect(res.status).not.toBe(302);
  });

  it('redirects a valid session to /editor (302)', async () => {
    const user = await seedUser({ email: 'gate@example.com', plan: 'free' });
    const client = makeClient();
    const login = await client.post('/auth/login', { email: user.email, password: user.password });
    expect(login.status).toBe(200);
    expect(client.cookie).toMatch(/^gb_session=/);

    const res = await client.get('/');
    expect(res.status).toBe(302);
    expect(locationPath(res)).toBe('/editor');
  });
});
