// GTFS-X open catalog (issue #47): the pull-model feed catalog served at
// feeds.<zone>/catalog.json, its opt-in/opt-out machinery, and the app-host
// canonical-URL redirect.
//
// Split in two: pure-builder unit tests (worker/publication/catalog.ts) and
// end-to-end tests that drive the real route through SELF — mirroring the
// dmfr.json approach in publication.ntd.test.ts.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbRun,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import {
  buildCatalogDocument,
  licenseUrlForSpdx,
  stopBoundingBox,
  deriveCatalogFeatures,
  type CatalogFeedInput,
} from '../publication/catalog';

// ─── Pure builder ───────────────────────────────────────────────────────────

describe('catalog builder (pure)', () => {
  const baseFeed: CatalogFeedInput = {
    slug: 'svt',
    name: 'Sunset Valley Transit',
    publisherType: 'official',
    publishedAt: Date.parse('2026-07-15T12:00:00Z'),
  };

  it('maps official/community to the MobilityData is_official boolean', () => {
    const doc = buildCatalogDocument({
      feedsOrigin: 'https://feeds.gtfsx.com',
      generatedAt: Date.now(),
      feeds: [
        { ...baseFeed, slug: 'a', publisherType: 'official' },
        { ...baseFeed, slug: 'b', publisherType: 'community' },
      ],
    });
    expect(doc.feeds[0].is_official).toBe(true);
    expect(doc.feeds[1].is_official).toBe(false);
    expect(doc.feed_count).toBe(2);
    expect(doc.version).toBe('0.2');
  });

  it('builds stable ids, download + page URLs off the feeds origin', () => {
    const doc = buildCatalogDocument({
      feedsOrigin: 'https://feeds.gtfsx.com/',
      generatedAt: Date.now(),
      feeds: [baseFeed],
    });
    const f = doc.feeds[0];
    expect(f.id).toBe('gtfsx:svt');
    expect(f.direct_download_url).toBe('https://feeds.gtfsx.com/svt/gtfs.zip');
    expect(f.gtfsx_feed_page).toBe('https://feeds.gtfsx.com/svt');
    expect(f.authentication_type).toBe(0);
    expect(f.feed_updated_at).toBe('2026-07-15T12:00:00.000Z');
  });

  it('emits license_url for known SPDX ids and omits it for unknown ones', () => {
    const doc = buildCatalogDocument({
      feedsOrigin: 'https://feeds.gtfsx.com',
      generatedAt: Date.now(),
      feeds: [
        { ...baseFeed, slug: 'known', licenseSpdx: 'CC-BY-4.0' },
        { ...baseFeed, slug: 'unknown', licenseSpdx: 'Weird-License-9.9' },
        { ...baseFeed, slug: 'none' },
      ],
    });
    expect(doc.feeds[0].license_spdx_identifier).toBe('CC-BY-4.0');
    expect(doc.feeds[0].license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(doc.feeds[1].license_spdx_identifier).toBe('Weird-License-9.9');
    expect(doc.feeds[1].license_url).toBeUndefined();
    expect(doc.feeds[2].license_spdx_identifier).toBeUndefined();
    expect(doc.feeds[2].license_url).toBeUndefined();
  });

  it('emits optional meta only when present, and mdb_source_id when numeric', () => {
    const doc = buildCatalogDocument({
      feedsOrigin: 'https://feeds.gtfsx.com',
      generatedAt: Date.now(),
      feeds: [
        {
          ...baseFeed,
          slug: 'full',
          mdbSourceId: 1234,
          meta: {
            bbox: { minimum_latitude: 45.6, minimum_longitude: -111.2, maximum_latitude: 45.7, maximum_longitude: -111.0 },
            features: ['flex'],
            feedPublisherName: 'Sunset Valley Transit Authority',
            feedContactEmail: 'gtfs@svt.example',
          },
        },
        { ...baseFeed, slug: 'bare', meta: { bbox: null, features: [], feedPublisherName: null, feedContactEmail: null } },
      ],
    });
    const full = doc.feeds[0];
    expect(full.mdb_source_id).toBe(1234);
    expect(full.provider).toBe('Sunset Valley Transit Authority'); // publisher name wins over project name
    expect(full.feed_contact_email).toBe('gtfs@svt.example');
    expect(full.features).toEqual(['flex']);
    expect(full.bounding_box).toEqual({
      minimum_latitude: 45.6, minimum_longitude: -111.2, maximum_latitude: 45.7, maximum_longitude: -111.0,
    });
    const bare = doc.feeds[1];
    expect(bare.mdb_source_id).toBeUndefined();
    expect(bare.provider).toBe('Sunset Valley Transit'); // falls back to project name
    expect(bare.feed_contact_email).toBeUndefined();
    expect(bare.features).toBeUndefined();
    expect(bare.bounding_box).toBeUndefined();
  });

  it('licenseUrlForSpdx / stopBoundingBox / deriveCatalogFeatures helpers', () => {
    expect(licenseUrlForSpdx('CC0-1.0')).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(licenseUrlForSpdx('nope')).toBeNull();
    expect(licenseUrlForSpdx(null)).toBeNull();

    expect(stopBoundingBox([])).toBeNull();
    expect(stopBoundingBox([{ stop_lat: 0, stop_lon: 0 }])).toBeNull(); // null island ignored
    expect(
      stopBoundingBox([
        { stop_lat: 45.68, stop_lon: -111.04 },
        { stop_lat: 45.7, stop_lon: -111.02 },
        { stop_lat: 'bad', stop_lon: 'x' },
      ]),
    ).toEqual({ minimum_latitude: 45.68, minimum_longitude: -111.04, maximum_latitude: 45.7, maximum_longitude: -111.02 });

    expect(deriveCatalogFeatures({ flexZones: [{ id: 'z1' }] })).toEqual(['flex']);
    expect(deriveCatalogFeatures({ flexZones: [] })).toEqual([]);
    expect(deriveCatalogFeatures({})).toEqual([]);
    expect(deriveCatalogFeatures(null)).toEqual([]);
  });
});

// ─── End-to-end route ─────────────────────────────────────────────────────────

interface CatalogDoc {
  specification: string;
  version: string;
  publisher: { name: string; url: string };
  feed_count: number;
  feeds: Array<{
    id: string;
    is_official: boolean;
    direct_download_url: string;
    bounding_box?: unknown;
    feed_contact_email?: string;
    features?: string[];
    mdb_source_id?: number;
    license_url?: string;
  }>;
}

async function loggedInClient(email: string): Promise<TestClient> {
  const user = await seedUser({ email });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return client;
}

async function createProject(client: TestClient, name: string): Promise<{ id: string; slug: string }> {
  return client.json(await client.post('/api/projects', { name }));
}

interface FeedState {
  feedInfo?: Record<string, unknown>;
  stops?: Array<{ stop_id: string; stop_lat?: number; stop_lon?: number }>;
  flexZones?: unknown[];
}

async function createSnapshot(client: TestClient, projectId: string, state: FeedState): Promise<{ snapshot: { id: string } }> {
  const form = new FormData();
  const stateBuf = await gzip(JSON.stringify(state));
  form.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  form.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  return client.json(await client.post(`/api/projects/${projectId}/snapshots`, undefined, { body: form }));
}

async function publish(client: TestClient, projectId: string, snapshotId: string, licenseSpdx?: string): Promise<Response> {
  const form = new FormData();
  form.append('meta', JSON.stringify({ snapshotId, ...(licenseSpdx ? { licenseSpdx } : {}) }));
  form.append('zip', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'g.zip');
  return client.post(`/api/projects/${projectId}/publish`, undefined, { body: form });
}

function sampleState(overrides: Partial<FeedState> = {}): FeedState {
  return {
    feedInfo: { feed_publisher_name: 'Sunset Valley Transit', feed_contact_email: 'gtfs@svt.example' },
    stops: [
      { stop_id: 'S1', stop_lat: 45.68, stop_lon: -111.04 },
      { stop_id: 'S2', stop_lat: 45.7, stop_lon: -111.02 },
    ],
    ...overrides,
  };
}

/** Fetch and parse the live catalog document off the feeds host. */
async function fetchCatalog(): Promise<CatalogDoc> {
  const res = await SELF.fetch('http://feeds.example.com/catalog.json');
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toContain('max-age=3600');
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  return res.json<CatalogDoc>();
}

/** Publish a project, opt it into the catalog, and wait for catalog_meta to land. */
async function optInAndPublish(
  client: TestClient,
  projectId: string,
  publisherType: 'official' | 'community',
  state: FeedState,
  licenseSpdx?: string,
): Promise<void> {
  const v = await createSnapshot(client, projectId, state);
  const pub = await publish(client, projectId, v.snapshot.id, licenseSpdx);
  expect(pub.status).toBe(200);
  await client.put(`/api/projects/${projectId}/catalog-listing`, { publisherType });
}

describe('/catalog.json (open catalog endpoint)', () => {
  let capture: EmailCapture;

  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => {
    capture.restore();
  });

  it('empty catalog is a valid, empty document', async () => {
    const doc = await fetchCatalog();
    expect(doc.feed_count).toBe(0);
    expect(doc.feeds).toEqual([]);
    expect(doc.version).toBe('0.2');
    expect(doc.publisher.name).toBe('GTFS-X');
    expect(doc.specification).toContain('catalog-spec');
  });

  it('lists an official, published, opted-in feed with is_official=true', async () => {
    const client = await loggedInClient('cat-official@example.com');
    const proj = await createProject(client, 'Official Feed');
    await optInAndPublish(client, proj.id, 'official', sampleState(), 'CC-BY-4.0');

    const doc = await fetchCatalog();
    const entry = doc.feeds.find((f) => f.id === `gtfsx:${proj.slug}`);
    expect(entry).toBeTruthy();
    expect(entry!.is_official).toBe(true);
    expect(entry!.direct_download_url).toBe(`http://feeds.test.local/${proj.slug}/gtfs.zip`);
    expect(entry!.license_url).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('community declaration emits is_official=false', async () => {
    const client = await loggedInClient('cat-comm@example.com');
    const proj = await createProject(client, 'Community Feed');
    await optInAndPublish(client, proj.id, 'community', sampleState());

    const doc = await fetchCatalog();
    const entry = doc.feeds.find((f) => f.id === `gtfsx:${proj.slug}`);
    expect(entry!.is_official).toBe(false);
  });

  it('opted-in but NOT published feed does not appear', async () => {
    const client = await loggedInClient('cat-unpub@example.com');
    const proj = await createProject(client, 'Not Published');
    // Opt in without ever publishing.
    await client.put(`/api/projects/${proj.id}/catalog-listing`, { publisherType: 'official' });

    const doc = await fetchCatalog();
    expect(doc.feeds.find((f) => f.id === `gtfsx:${proj.slug}`)).toBeUndefined();
  });

  it('published but NOT opted-in feed does not appear (no silent default)', async () => {
    const client = await loggedInClient('cat-noopt@example.com');
    const proj = await createProject(client, 'No Opt In');
    const v = await createSnapshot(client, proj.id, sampleState());
    expect((await publish(client, proj.id, v.snapshot.id)).status).toBe(200);

    const doc = await fetchCatalog();
    expect(doc.feeds.find((f) => f.id === `gtfsx:${proj.slug}`)).toBeUndefined();
  });

  it('opt-out drops the feed from the catalog', async () => {
    const client = await loggedInClient('cat-optout@example.com');
    const proj = await createProject(client, 'Opt Out Later');
    await optInAndPublish(client, proj.id, 'official', sampleState());
    expect((await fetchCatalog()).feeds.some((f) => f.id === `gtfsx:${proj.slug}`)).toBe(true);

    const del = await client.delete(`/api/projects/${proj.id}/catalog-listing`);
    expect(del.status).toBe(204);
    expect((await fetchCatalog()).feeds.some((f) => f.id === `gtfsx:${proj.slug}`)).toBe(false);
  });

  it('unpublish drops the feed from the catalog (self-healing)', async () => {
    const client = await loggedInClient('cat-selfheal@example.com');
    const proj = await createProject(client, 'Self Heal');
    await optInAndPublish(client, proj.id, 'official', sampleState());
    expect((await fetchCatalog()).feeds.some((f) => f.id === `gtfsx:${proj.slug}`)).toBe(true);

    const un = await client.post(`/api/projects/${proj.id}/unpublish`);
    expect(un.status).toBe(204);
    expect((await fetchCatalog()).feeds.some((f) => f.id === `gtfsx:${proj.slug}`)).toBe(false);
  });

  it('persists bbox + publisher name + contact email + features from the snapshot state', async () => {
    const client = await loggedInClient('cat-meta@example.com');
    const proj = await createProject(client, 'Meta Feed');
    await optInAndPublish(client, proj.id, 'official', sampleState({ flexZones: [{ id: 'z1' }] }));

    // catalog_meta is computed in a background (waitUntil) task — poll for it.
    let entry: CatalogDoc['feeds'][number] | undefined;
    for (let i = 0; i < 40; i += 1) {
      const doc = await fetchCatalog();
      entry = doc.feeds.find((f) => f.id === `gtfsx:${proj.slug}`);
      if (entry?.bounding_box) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(entry).toBeTruthy();
    expect(entry!.bounding_box).toEqual({
      minimum_latitude: 45.68, minimum_longitude: -111.04, maximum_latitude: 45.7, maximum_longitude: -111.02,
    });
    expect(entry!.feed_contact_email).toBe('gtfs@svt.example');
    expect(entry!.features).toEqual(['flex']);
  });

  it('carries mdb_source_id when persisted on the project (switcher case)', async () => {
    const client = await loggedInClient('cat-mdb@example.com');
    const proj = await createProject(client, 'Switcher Feed');
    await optInAndPublish(client, proj.id, 'official', sampleState());
    await dbRun(`UPDATE feed_project SET mdb_source_id = 5678 WHERE id = ?`, proj.id);

    const doc = await fetchCatalog();
    const entry = doc.feeds.find((f) => f.id === `gtfsx:${proj.slug}`);
    expect(entry!.mdb_source_id).toBe(5678);
  });

  it('GET catalog-listing reflects opt-in state', async () => {
    const client = await loggedInClient('cat-listing@example.com');
    const proj = await createProject(client, 'Listing State');
    const before = await client.json<{ listing: { listed: boolean; publisherType: string | null } }>(
      await client.get(`/api/projects/${proj.id}/catalog-listing`),
    );
    expect(before.listing.listed).toBe(false);
    expect(before.listing.publisherType).toBeNull();

    await client.put(`/api/projects/${proj.id}/catalog-listing`, { publisherType: 'community' });
    const after = await client.json<{ listing: { listed: boolean; publisherType: string | null } }>(
      await client.get(`/api/projects/${proj.id}/catalog-listing`),
    );
    expect(after.listing.listed).toBe(true);
    expect(after.listing.publisherType).toBe('community');
  });

  it('rejects an invalid publisherType', async () => {
    const client = await loggedInClient('cat-bad@example.com');
    const proj = await createProject(client, 'Bad Type');
    const res = await client.put(`/api/projects/${proj.id}/catalog-listing`, { publisherType: 'partner' });
    expect(res.status).toBe(422); // validationFailed
  });
});

describe('app-host /catalog.json canonical redirect', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('301-redirects the app host to the canonical feeds-origin URL', async () => {
    const client = makeClient();
    // Default host (127.0.0.1) is the app host, not the feeds host.
    const res = await client.get('/catalog.json', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('Location')).toBe('http://feeds.test.local/catalog.json');
  });
});
