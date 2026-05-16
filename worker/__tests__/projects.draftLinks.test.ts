// Draft-link creation, public serving on feeds.*, revocation, and listing.

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

async function createSnapshot(client: TestClient, projectId: string): Promise<{ snapshot: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify({}));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.json(await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }));
}

async function createDraftLink(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  zipBytes: Uint8Array,
): Promise<{ url: string; token: string; tokenHash: string; expiresAt: number }> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, ttlDays: 7 }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.json(await client.post(`/api/projects/${projectId}/draft-links`, undefined, { body: form }));
}

describe('/api/projects/:id/draft-links', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('create draft link → public URL returns the ZIP with noindex + attachment headers', async () => {
    const client = await loggedInClient('dl1@example.com');
    const proj = await createProject(client, 'DraftFeed');
    const v = await createSnapshot(client, proj.id);
    const zipBytes = new TextEncoder().encode('draft-zip-contents');

    const link = await createDraftLink(client, proj.id, v.snapshot.id, zipBytes);
    expect(link.url).toContain(`/${proj.slug}/draft/`);
    expect(link.token).toBeTruthy();
    expect(link.expiresAt).toBeGreaterThan(Date.now());

    const draftPath = new URL(link.url).pathname;
    const res = await SELF.fetch(`http://feeds.test${draftPath}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(res.headers.get('Cache-Control')).toContain('private');
    expect(res.headers.get('Content-Disposition')).toContain(`${proj.slug}-draft-`);
    const recvd = new Uint8Array(await res.arrayBuffer());
    expect(recvd).toEqual(zipBytes);
  });

  it('revoke draft link → public URL returns 410 Gone', async () => {
    const client = await loggedInClient('dl2@example.com');
    const proj = await createProject(client, 'RevokeFeed');
    const v = await createSnapshot(client, proj.id);
    const link = await createDraftLink(client, proj.id, v.snapshot.id, new Uint8Array([7, 7]));

    const del = await client.delete(`/api/projects/${proj.id}/draft-links/${link.tokenHash}`);
    expect(del.status).toBe(204);

    const path = new URL(link.url).pathname;
    const res = await SELF.fetch(`http://feeds.test${path}`);
    expect(res.status).toBe(410);
  });

  it('list draft links returns tokenHash only — never the cleartext token', async () => {
    const client = await loggedInClient('dl3@example.com');
    const proj = await createProject(client, 'ListFeed');
    const v = await createSnapshot(client, proj.id);
    const link = await createDraftLink(client, proj.id, v.snapshot.id, new Uint8Array([1]));

    const list = await client.json<{ links: { tokenHash: string; snapshotId: string }[] }>(
      await client.get(`/api/projects/${proj.id}/draft-links`),
    );
    expect(list.links.length).toBe(1);
    expect(list.links[0].tokenHash).toBe(link.tokenHash);
    // The cleartext token should not leak into the listing — we hashed it when we stored it.
    const serialized = JSON.stringify(list);
    expect(serialized.includes(link.token)).toBe(false);
  });

  it('unknown token returns 404, mismatched slug returns 404', async () => {
    const client = await loggedInClient('dl4@example.com');
    const proj = await createProject(client, 'MismatchFeed');
    const v = await createSnapshot(client, proj.id);
    const link = await createDraftLink(client, proj.id, v.snapshot.id, new Uint8Array([1, 2]));

    const missing = await SELF.fetch(`http://feeds.test/${proj.slug}/draft/not-a-real-token.zip`);
    expect(missing.status).toBe(404);

    const wrongSlug = await SELF.fetch(`http://feeds.test/wrong-slug/draft/${link.token}.zip`);
    expect(wrongSlug.status).toBe(404);
  });
});
