// Public feed distribution — feeds.* hostname handling. Covers the canonical
// ZIP, feed_info.json sidecar, robots.txt, and unknown-path 404s.

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

async function createSnapshotWithFeedInfo(client: TestClient, projectId: string): Promise<{ snapshot: { id: string } }> {
  const form = new FormData();
  const state = {
    feedInfo: {
      feed_publisher_name: 'Example Transit',
      feed_start_date: '20260301',
      feed_end_date: '20260831',
    },
    agencies: [],
    routes: [],
    stops: [],
    trips: [],
  };
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.json(await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }));
}

async function publishMultipart(
  client: TestClient,
  projectId: string,
  snapshotId: string,
  zipBytes: Uint8Array,
): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId }));
  form.append('zip', new Blob([zipBytes], { type: 'application/zip' }), 'gtfs.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

describe('feeds.* distribution handler', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => capture.restore());

  it('GET feeds.*/<slug>/gtfs.zip serves the published ZIP with cache headers', async () => {
    const client = await loggedInClient('fd1@example.com');
    const proj = await createProject(client, 'DistFeed');
    const v = await createSnapshotWithFeedInfo(client, proj.id);
    const zipBytes = new TextEncoder().encode('PKZIPzipzipzip');
    await publishMultipart(client, proj.id, v.snapshot.id, zipBytes);

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/gtfs.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/zip');
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=3600');
    expect(res.headers.get('Last-Modified')).toBeTruthy();
    const recvd = new Uint8Array(await res.arrayBuffer());
    expect(recvd).toEqual(zipBytes);
  });

  it('GET feeds.*/<slug>/feed_info.json returns the sidecar with RT feeds + distribution', async () => {
    const client = await loggedInClient('fd2@example.com');
    const proj = await createProject(client, 'InfoFeed');
    const v = await createSnapshotWithFeedInfo(client, proj.id);
    // Register RT feed + opt in to mobility_db before publishing.
    await client.put(`/api/projects/${proj.id}/rt-feeds`, {
      feeds: [{ kind: 'trip_updates', url: 'https://example.com/tu.pb' }],
    });
    await client.post(`/api/projects/${proj.id}/catalog-submissions`, { catalog: 'mobility_db' });
    await publishMultipart(client, proj.id, v.snapshot.id, new Uint8Array([1, 2, 3]));

    const res = await SELF.fetch(`http://feeds.example.com/${proj.slug}/feed_info.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json() as {
      feed_title: string;
      snapshot_id: string;
      zip_url: string;
      rt_feeds: { kind: string; url: string }[];
      distribution: Record<string, { status: string }>;
      feed_start_date?: string;
      feed_end_date?: string;
    };
    expect(body.snapshot_id).toBe(v.snapshot.id);
    expect(body.feed_title).toBe('Example Transit');
    expect(body.zip_url).toContain(`/${proj.slug}/gtfs.zip`);
    expect(body.rt_feeds).toEqual([{ kind: 'trip_updates', url: 'https://example.com/tu.pb' }]);
    expect(body.distribution.mobility_db).toBeDefined();
    expect(body.feed_start_date).toBe('20260301');
  });

  it('GET feeds.*/robots.txt disallows crawling', async () => {
    const res = await SELF.fetch('http://feeds.example.com/robots.txt');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Disallow: /');
  });

  it('unknown slug returns 404', async () => {
    const res = await SELF.fetch('http://feeds.example.com/does-not-exist/gtfs.zip');
    expect(res.status).toBe(404);
  });

  it('unknown path on feeds.* returns 404', async () => {
    const res = await SELF.fetch('http://feeds.example.com/random/nope.html');
    expect(res.status).toBe(404);
  });
});
