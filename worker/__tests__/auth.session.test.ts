// Session lifecycle: logout, logout-all, idle timeout, absolute timeout.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbGet,
  dbRun,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('auth session lifecycle', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('logout revokes the current session; /api/me → 401', async () => {
    const user = await seedUser({ email: 'logout@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    expect((await client.get('/api/me')).status).toBe(200);

    const lo = await client.post('/auth/logout');
    expect(lo.status).toBe(204);

    const meRes = await client.get('/api/me');
    expect(meRes.status).toBe(401);
  });

  it('logout-all revokes ALL sessions across browsers', async () => {
    const user = await seedUser({ email: 'logoutall@example.com' });

    const c1 = makeClient();
    await c1.post('/auth/login', { email: user.email, password: user.password });
    const c2 = makeClient();
    await c2.post('/auth/login', { email: user.email, password: user.password });

    expect((await c1.get('/api/me')).status).toBe(200);
    expect((await c2.get('/api/me')).status).toBe(200);

    const lo = await c1.post('/auth/logout-all');
    expect(lo.status).toBe(204);

    // Both sessions are now revoked.
    expect((await c1.get('/api/me')).status).toBe(401);
    expect((await c2.get('/api/me')).status).toBe(401);

    const rows = await dbAll<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`,
      user.id,
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('absolute timeout: when session.expires_at is in the past, /api/me → 401', async () => {
    const user = await seedUser({ email: 'abs-timeout@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    expect((await client.get('/api/me')).status).toBe(200);

    // Backdate expires_at to 1ms after epoch.
    await dbRun(`UPDATE session SET expires_at = ? WHERE user_id = ?`, 1, user.id);
    expect((await client.get('/api/me')).status).toBe(401);
  });

  it('idle timeout: when last_used_at is > 30 days ago, /api/me → 401', async () => {
    const user = await seedUser({ email: 'idle-timeout@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });
    expect((await client.get('/api/me')).status).toBe(200);

    // Backdate last_used_at to 31 days ago. Absolute expiry remains in the
    // future (90-day cookie), so only the idle check should fail.
    const idleThreshold = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await dbRun(`UPDATE session SET last_used_at = ? WHERE user_id = ?`, idleThreshold, user.id);

    expect((await client.get('/api/me')).status).toBe(401);
  });

  it('a logged-in session is NOT marked revoked_at, but a logged-out one is', async () => {
    const user = await seedUser({ email: 'revoked-check@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const liveRow = await dbGet<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`,
      user.id,
    );
    expect(liveRow?.revoked_at).toBeNull();

    await client.post('/auth/logout');
    const deadRow = await dbGet<{ revoked_at: number | null }>(
      `SELECT revoked_at FROM session WHERE user_id = ?`,
      user.id,
    );
    expect(deadRow?.revoked_at).not.toBeNull();
  });
});
