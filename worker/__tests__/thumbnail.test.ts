// Route-map thumbnails: geometry hashing (the autosave gate), Mapbox Static
// API render (mocked), R2 storage + DB version bump, the public serve route,
// and the og:image emission. See worker/embeds/thumbnail.ts, worker/embeds/
// layout.ts, and worker/publication/feeds.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { html } from 'hono/html';
import { SELF } from 'cloudflare:test';
import { applyMigrations, env, resetDb } from './_setup';
import {
  generateAndStoreThumbnail,
  maybeRegenerateThumbnail,
  renderRouteThumbnail,
  thumbnailGeomHash,
} from '../embeds/thumbnail';
import { renderLayout } from '../embeds/layout';
import { thumbnailKey } from '../projects/r2';
import type { FeedState } from '../embeds/types';

const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

function stateWithShapes(color2 = 'BB29BB'): FeedState {
  return {
    agencies: [],
    calendars: [],
    calendarDates: [],
    routes: [
      { route_id: 'R1', agency_id: 'A', route_short_name: '1', route_long_name: 'One', route_type: 3, route_color: '274BAC', route_text_color: 'FFFFFF' },
      { route_id: 'R2', agency_id: 'A', route_short_name: '2', route_long_name: 'Two', route_type: 3, route_color: color2, route_text_color: 'FFFFFF' },
    ],
    stops: [],
    trips: [
      { trip_id: 'T1', route_id: 'R1', service_id: 'S', direction_id: 0, shape_id: 'SH1' },
      { trip_id: 'T2', route_id: 'R2', service_id: 'S', direction_id: 0, shape_id: 'SH2' },
    ],
    stopTimes: [],
    shapes: [
      { shape_id: 'SH1', points: [
        { shape_pt_lat: 45.670, shape_pt_lon: -111.040, shape_pt_sequence: 0 },
        { shape_pt_lat: 45.680, shape_pt_lon: -111.050, shape_pt_sequence: 1 },
        { shape_pt_lat: 45.690, shape_pt_lon: -111.030, shape_pt_sequence: 2 },
      ] },
      { shape_id: 'SH2', points: [
        { shape_pt_lat: 45.660, shape_pt_lon: -111.020, shape_pt_sequence: 0 },
        { shape_pt_lat: 45.670, shape_pt_lon: -111.010, shape_pt_sequence: 1 },
      ] },
    ],
    feedInfo: null,
  };
}

function emptyState(): FeedState {
  return { agencies: [], calendars: [], calendarDates: [], routes: [], stops: [], trips: [], stopTimes: [], shapes: [], feedInfo: null };
}

function mockMapbox() {
  const mock = vi.fn(async () => new Response(FAKE_PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function seedProject(id: string, slug: string, thumbnailVersion = 0): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO feed_project (id, slug, name, owner_type, owner_id, working_state_version, created_at, updated_at, thumbnail_version)
     VALUES (?, ?, ?, 'user', 'u_test', 1, ?, ?, ?)`,
  )
    .bind(id, slug, `Feed ${slug}`, now, now, thumbnailVersion)
    .run();
}

beforeEach(async () => {
  await applyMigrations();
  await resetDb();
  (env as { MAPBOX_TOKEN?: string }).MAPBOX_TOKEN = 'pk.test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('thumbnailGeomHash (autosave gate)', () => {
  it('is stable for identical geometry and changes when a color or coord changes', () => {
    const a = thumbnailGeomHash(stateWithShapes());
    const b = thumbnailGeomHash(stateWithShapes());
    expect(a).toBeTruthy();
    expect(a).toBe(b);

    const recolored = thumbnailGeomHash(stateWithShapes('00AEEF'));
    expect(recolored).not.toBe(a);

    const moved = stateWithShapes();
    moved.shapes[0].points[1].shape_pt_lat = 45.700;
    expect(thumbnailGeomHash(moved)).not.toBe(a);
  });

  it('returns null when there are no route shapes', () => {
    expect(thumbnailGeomHash(emptyState())).toBeNull();
  });
});

describe('renderRouteThumbnail', () => {
  it('renders both sizes via the Mapbox Static API', async () => {
    const mock = mockMapbox();
    const res = await renderRouteThumbnail(stateWithShapes(), env);
    expect(res).not.toBeNull();
    expect(res!.lg).toEqual(FAKE_PNG);
    expect(res!.sm).toEqual(FAKE_PNG);
    expect(mock).toHaveBeenCalledTimes(2);

    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toContain('api.mapbox.com/styles/v1/mapbox/light-v11/static');
    expect(String(url)).toContain('auto/1200x630@2x');
    expect(String(url)).toContain('path-5+274BAC'); // route_color overlay
    // URL-restricted token needs an allowed Referer (APP_ORIGIN).
    expect((init?.headers as Record<string, string>).Referer).toBe('http://127.0.0.1/');
  });

  it('returns null (no Mapbox call) when there are no shapes', async () => {
    const mock = mockMapbox();
    expect(await renderRouteThumbnail(emptyState(), env)).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('returns null when MAPBOX_TOKEN is missing', async () => {
    const mock = mockMapbox();
    (env as { MAPBOX_TOKEN?: string }).MAPBOX_TOKEN = undefined;
    expect(await renderRouteThumbnail(stateWithShapes(), env)).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('sanitizes a route_color with stray whitespace (no control char in URL)', async () => {
    const mock = mockMapbox();
    await renderRouteThumbnail(stateWithShapes('005B95 '), env); // note trailing space
    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain('path-5+005B95-0.95'); // trimmed
    expect(url).not.toContain('005B95 '); // no raw space leaked into the URL
  });

  it('drops shapes to keep the URL under Mapbox’s cap for huge feeds', async () => {
    const mock = mockMapbox();
    // 250 distinct shapes would overflow the ~8KB URL even at max simplification.
    const state: FeedState = {
      ...emptyState(),
      routes: [{ route_id: 'R', agency_id: 'A', route_short_name: 'R', route_long_name: 'R', route_type: 3, route_color: '274BAC', route_text_color: 'FFFFFF' }],
      trips: Array.from({ length: 250 }, (_, i) => ({ trip_id: `T${i}`, route_id: 'R', service_id: 'S', direction_id: 0 as const, shape_id: `SH${i}` })),
      shapes: Array.from({ length: 250 }, (_, i) => ({
        shape_id: `SH${i}`,
        points: [
          { shape_pt_lat: 45.6 + i * 0.001, shape_pt_lon: -111.0 - i * 0.001, shape_pt_sequence: 0 },
          { shape_pt_lat: 45.61 + i * 0.001, shape_pt_lon: -111.01 - i * 0.001, shape_pt_sequence: 1 },
        ],
      })),
    };
    const res = await renderRouteThumbnail(state, env);
    expect(res).not.toBeNull();
    const url = String(mock.mock.calls[0][0]);
    expect(url.length).toBeLessThanOrEqual(8192); // Mapbox Static URL limit
  });
});

describe('generateAndStoreThumbnail + gate', () => {
  it('stores both sizes in R2, sets hash + bumps version, then skips when unchanged', async () => {
    const mock = mockMapbox();
    await seedProject('P1', 'gen-test');
    const state = stateWithShapes();

    const wrote = await generateAndStoreThumbnail(env, 'P1', state, null);
    expect(wrote).toBe(true);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(await env.FEEDS.get(thumbnailKey('P1', 'lg'))).not.toBeNull();
    expect(await env.FEEDS.get(thumbnailKey('P1', 'sm'))).not.toBeNull();
    const row = await env.DB.prepare(`SELECT thumbnail_version, thumbnail_geom_hash FROM feed_project WHERE id = 'P1'`)
      .first<{ thumbnail_version: number; thumbnail_geom_hash: string }>();
    expect(row!.thumbnail_version).toBe(1);
    expect(row!.thumbnail_geom_hash).toBe(thumbnailGeomHash(state));

    // maybeRegenerate reads the stored hash; unchanged geometry → no Mapbox call.
    const again = await maybeRegenerateThumbnail(env, 'P1', state);
    expect(again).toBe(false);
    expect(mock).toHaveBeenCalledTimes(2); // unchanged

    // Changed geometry → regenerate, version bumps.
    const wrote2 = await maybeRegenerateThumbnail(env, 'P1', stateWithShapes('00AEEF'));
    expect(wrote2).toBe(true);
    expect(mock).toHaveBeenCalledTimes(4);
    const row2 = await env.DB.prepare(`SELECT thumbnail_version FROM feed_project WHERE id = 'P1'`)
      .first<{ thumbnail_version: number }>();
    expect(row2!.thumbnail_version).toBe(2);
  });

  it('never throws and writes nothing when Mapbox fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await seedProject('P9', 'fail-test');
    const wrote = await generateAndStoreThumbnail(env, 'P9', stateWithShapes(), null);
    expect(wrote).toBe(false);
    const row = await env.DB.prepare(`SELECT thumbnail_version FROM feed_project WHERE id = 'P9'`)
      .first<{ thumbnail_version: number }>();
    expect(row!.thumbnail_version).toBe(0);
  });
});

describe('public thumbnail serve route', () => {
  it('serves both sizes as image/png and 404s when none / unknown', async () => {
    await seedProject('P2', 'serve-test', 3);
    await env.FEEDS.put(thumbnailKey('P2', 'lg'), FAKE_PNG, { httpMetadata: { contentType: 'image/png' } });
    await env.FEEDS.put(thumbnailKey('P2', 'sm'), FAKE_PNG, { httpMetadata: { contentType: 'image/png' } });
    await seedProject('P3', 'no-thumb', 0);

    const lg = await SELF.fetch('http://feeds.example.com/serve-test/thumbnail.png');
    expect(lg.status).toBe(200);
    expect(lg.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await lg.arrayBuffer())).toEqual(FAKE_PNG);

    const sm = await SELF.fetch('http://feeds.example.com/serve-test/thumbnail-sm.png');
    expect(sm.status).toBe(200);

    expect((await SELF.fetch('http://feeds.example.com/no-thumb/thumbnail.png')).status).toBe(404);
    expect((await SELF.fetch('http://feeds.example.com/nonexistent/thumbnail.png')).status).toBe(404);
  });
});

describe('og:image emission (renderLayout)', () => {
  it('emits og:image + summary_large_image when a thumbnail URL is set', async () => {
    const out = String(
      await renderLayout({
        title: 'T',
        social: { title: 'T', description: 'D', url: 'http://x/', imageUrl: 'http://feeds/abc/thumbnail.png?v=2', imageWidth: 1200, imageHeight: 630 },
        noindex: false,
        body: html`<p>x</p>`,
      }),
    );
    expect(out).toContain('property="og:image" content="http://feeds/abc/thumbnail.png?v=2"');
    expect(out).toContain('property="og:image:width" content="1200"');
    expect(out).toContain('property="og:image:height" content="630"');
    expect(out).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('falls back to summary card with no og:image when no thumbnail', async () => {
    const out = String(
      await renderLayout({
        title: 'T',
        social: { title: 'T', description: 'D', url: 'http://x/' },
        noindex: false,
        body: html`<p>x</p>`,
      }),
    );
    expect(out).not.toContain('og:image');
    expect(out).toContain('name="twitter:card" content="summary"');
  });
});
