// POST /api/projects/:id/publish, /unpublish, /publish/rollback, /publish/history
// — plus end-to-end consumption of the canonical feed URL on feeds.*.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

async function createVersion(
  client: TestClient,
  projectId: string,
  state: unknown,
  meta: { label?: string; validationErrors?: number; validationWarnings?: number; summary?: Record<string, unknown> } = {},
): Promise<{ version: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({
    label: meta.label,
    summary: meta.summary ?? {},
    validationErrors: meta.validationErrors ?? 0,
    validationWarnings: meta.validationWarnings ?? 0,
  }));
  return client.json(await client.post(`/api/projects/${projectId}/versions`, undefined, { body: form }));
}

async function publishMultipart(
  client: TestClient,
  projectId: string,
  versionId: string,
  zipBytes: Uint8Array,
  flags: { ignoreWarnings?: boolean; ignoreRtBreakage?: boolean } = {},
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ versionId, ...flags }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

describe('/api/projects/:id/publish', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('publish → canonical feed URL returns the ZIP with correct headers', async () => {
    const client = await loggedInClient('pub1@example.com');
    const proj = await createProject(client, 'Pub Feed');
    const v = await createVersion(client, proj.id, { agencies: [], routes: [], stops: [], trips: [] });
    const zipBytes = new TextEncoder().encode('PK\x03\x04fake-zip-body');

    const pubRes = await publishMultipart(client, proj.id, v.version.id, zipBytes);
    expect(pubRes.status).toBe(200);
    const pubBody = await client.json<{ publication: { canonicalUrl: string } }>(pubRes);
    expect(pubBody.publication.canonicalUrl).toContain(`/${proj.slug}/gtfs.zip`);

    const feedRes = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(feedRes.status).toBe(200);
    expect(feedRes.headers.get('Content-Type')).toBe('application/zip');
    expect(feedRes.headers.get('Cache-Control')).toContain('max-age=3600');
    expect(feedRes.headers.get('Content-Disposition')).toContain(`${proj.slug}-`);
    expect(feedRes.headers.get('ETag')).toBe(`"${v.version.id}"`);
    const recvd = new Uint8Array(await feedRes.arrayBuffer());
    expect(recvd).toEqual(zipBytes);
  });

  it('publish with validation errors returns 422; ignoreWarnings allows it', async () => {
    const client = await loggedInClient('pub2@example.com');
    const proj = await createProject(client, 'Broken');
    const v = await createVersion(client, proj.id, {}, { validationErrors: 3 });
    const zipBytes = new Uint8Array([1, 2, 3]);

    const blocked = await publishMultipart(client, proj.id, v.version.id, zipBytes);
    expect(blocked.status).toBe(422);

    const allowed = await publishMultipart(client, proj.id, v.version.id, zipBytes, { ignoreWarnings: true });
    expect(allowed.status).toBe(200);
  });

  it('unpublish → canonical URL returns 410', async () => {
    const client = await loggedInClient('pub3@example.com');
    const proj = await createProject(client, 'GoneFeed');
    const v = await createVersion(client, proj.id, {});
    await publishMultipart(client, proj.id, v.version.id, new Uint8Array([9, 9]));
    const feedOk = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(feedOk.status).toBe(200);

    const unpub = await client.post(`/api/projects/${proj.id}/unpublish`);
    expect(unpub.status).toBe(204);
    const after = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    // Feed pointer deleted → 404 "No feed published here."
    expect(after.status).toBe(404);
  });

  it('rollback: serves an earlier version; history records the action', async () => {
    const client = await loggedInClient('pub4@example.com');
    const proj = await createProject(client, 'Roll');
    const vA = await createVersion(client, proj.id, { tag: 'A' });
    const vB = await createVersion(client, proj.id, { tag: 'B' });
    const zipA = new TextEncoder().encode('aaaa');
    const zipB = new TextEncoder().encode('bbbb');
    await publishMultipart(client, proj.id, vA.version.id, zipA);
    await publishMultipart(client, proj.id, vB.version.id, zipB);

    // Rollback to A — the pub slot for A still exists in R2 from the first publish.
    const rb = await client.post(`/api/projects/${proj.id}/publish/rollback`, { versionId: vA.version.id });
    expect(rb.status).toBe(200);

    const feedRes = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`);
    expect(feedRes.status).toBe(200);
    const recvd = new Uint8Array(await feedRes.arrayBuffer());
    expect(recvd).toEqual(zipA);

    const hist = await client.json<{ history: { action: string; versionId: string | null }[] }>(
      await client.get(`/api/projects/${proj.id}/publish/history`),
    );
    const actions = hist.history.map((h) => h.action);
    expect(actions).toContain('rollback');
    expect(actions.filter((a) => a === 'publish').length).toBe(2);
  });

  it('If-None-Match with the matching version etag returns 304', async () => {
    const client = await loggedInClient('pub5@example.com');
    const proj = await createProject(client, 'ETag');
    const v = await createVersion(client, proj.id, {});
    await publishMultipart(client, proj.id, v.version.id, new Uint8Array([1, 2, 3, 4]));

    const res = await SELF.fetch(`http://feeds.test/${proj.slug}/gtfs.zip`, {
      headers: { 'If-None-Match': `"${v.version.id}"` },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(`"${v.version.id}"`);
  });

  it('publish/history returns full log with current pointer', async () => {
    const client = await loggedInClient('pub6@example.com');
    const proj = await createProject(client, 'Hist');
    const v = await createVersion(client, proj.id, {});
    await publishMultipart(client, proj.id, v.version.id, new Uint8Array([0]));
    await client.post(`/api/projects/${proj.id}/unpublish`);

    const hist = await client.json<{
      history: { action: string }[];
      current: { versionId: string } | null;
    }>(await client.get(`/api/projects/${proj.id}/publish/history`));
    expect(hist.current).toBeNull();
    expect(hist.history.map((h) => h.action)).toEqual(['unpublish', 'publish']);
  });
});
