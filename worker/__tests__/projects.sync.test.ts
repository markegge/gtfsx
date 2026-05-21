// /api/projects/:id/working-state — optimistic-concurrency save/load round-trip.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { makeClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string, plan: 'free' | 'pro' | 'team' | 'enterprise' = 'team') {
  const user = await seedUser({ email, plan });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

describe('/api/projects/:id/working-state', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });

  afterEach(() => {
    capture.restore();
  });

  it('GET returns 404 when no working-state blob has been written yet', async () => {
    const client = await loggedInClient('sync1@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Empty' }),
    );
    const res = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(res.status).toBe(404);
  });

  it('PUT with If-Match: 0 succeeds and returns workingStateVersion: 1', async () => {
    const client = await loggedInClient('sync2@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Save' }),
    );

    const payload = JSON.stringify({ routes: [], stops: [] });
    const body = await gzip(payload);

    const put = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body,
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0', 'Content-Type': 'application/json' },
    });
    expect(put.status).toBe(200);
    const parsed = await client.json<{ workingStateVersion: number }>(put);
    expect(parsed.workingStateVersion).toBe(1);
  });

  it('GET after PUT returns the gzipped body and X-Working-State-Version header', async () => {
    const client = await loggedInClient('sync3@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Round Trip' }),
    );

    const payload = JSON.stringify({ hello: 'world', n: 42 });
    await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(payload),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });

    const getRes = await client.get(`/api/projects/${proj.id}/working-state`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('X-Working-State-Version')).toBe('1');
    // Worker decompresses the R2 blob and streams plain JSON to the client —
    // a manually-set Content-Encoding header on a Worker response isn't
    // auto-decoded by browser fetch, so we send the bytes raw. CF's edge
    // re-gzips on the wire when the client sends Accept-Encoding: gzip.
    expect(await getRes.json()).toEqual({ hello: 'world', n: 42 });
  });

  it('stale If-Match on second write returns 409 conflict with currentVersion', async () => {
    const client = await loggedInClient('sync4@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Race' }),
    );

    await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ first: true })),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });

    // Second write still with If-Match: 0 — now the server is at version 1.
    const stale = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ second: true })),
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: string; currentVersion: number };
    expect(body.error).toBe('conflict');
    expect(body.currentVersion).toBe(1);
  });

  it('missing If-Match header returns 409 (spec requires it)', async () => {
    const client = await loggedInClient('sync5@example.com');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'NoEtag' }),
    );

    const res = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: await gzip(JSON.stringify({ anything: true })),
      headers: { 'Content-Encoding': 'gzip' },
    });
    expect(res.status).toBe(409);
  });

  it('oversize body is rejected with 413', async () => {
    // Free plan caps the blob at 20 MB (per quotas.ts). Send 21 MB.
    const client = await loggedInClient('sync6@example.com', 'free');
    const proj = await client.json<{ id: string }>(
      await client.post('/api/projects', { name: 'Huge' }),
    );

    // Build a >20 MB incompressible body. Random bytes gzip to ~same size.
    const raw = new Uint8Array(21 * 1024 * 1024);
    crypto.getRandomValues(raw.subarray(0, 1024));
    // Fill the rest with pseudo-random from the seed so gzip can't squash it.
    for (let i = 1024; i < raw.length; i += 1024) raw.set(raw.subarray(0, 1024), i);
    // Not actually gzipped content — but server doesn't verify, just sends the raw bytes
    // through R2 with content-encoding: gzip. Size check happens pre-write.
    const res = await client.put(`/api/projects/${proj.id}/working-state`, undefined, {
      body: raw,
      headers: { 'Content-Encoding': 'gzip', 'If-Match': '0' },
    });
    // Implementation returns 413 on >plan.blobBytes. (A 409 would mean the
    // concurrency guard tripped first — check that didn't happen.)
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('quota_exceeded');
  });
});
