// CSRF defense: X-GB-Client required on state-changing methods, not on GETs.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

describe('CSRF — X-GB-Client header requirement', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('POST /api/projects without X-GB-Client → 422', async () => {
    const user = await seedUser({ email: 'csrf1@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.post('/api/projects', { name: 'Blocked' }, { noClientHeader: true });
    expect(res.status).toBe(422);
  });

  it('POST /api/projects with X-GB-Client → 201', async () => {
    const user = await seedUser({ email: 'csrf2@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.post('/api/projects', { name: 'Allowed' });
    expect(res.status).toBe(201);
  });

  it('GET /api/projects without X-GB-Client → 200 (CSRF only applies to writes)', async () => {
    const user = await seedUser({ email: 'csrf3@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.get('/api/projects', { noClientHeader: true });
    expect(res.status).toBe(200);
  });

  it('GET /api/me without X-GB-Client → 200', async () => {
    const user = await seedUser({ email: 'csrf4@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.get('/api/me', { noClientHeader: true });
    expect(res.status).toBe(200);
  });

  it('DELETE /api/me without X-GB-Client → 422', async () => {
    const user = await seedUser({ email: 'csrf5@example.com' });
    const client = makeClient();
    await client.post('/auth/login', { email: user.email, password: user.password });

    const res = await client.delete('/api/me', { password: user.password }, { noClientHeader: true });
    expect(res.status).toBe(422);
  });
});
