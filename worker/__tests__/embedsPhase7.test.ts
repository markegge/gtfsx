// Tests for the Embeds Phase 7 (#34) sub-features:
//   1. Custom theming (accent / dark / font URL params + cache-key folding)
//   2. i18n (lang param + feed_lang/agency_lang defaults; UI-string translation)
//   3. Impression counters (beacon endpoint → embed_impression → owner rollup)
//   4. GTFS-Realtime passthrough (proxy registered project_rt_feed URLs)
//
// Mirrors embeds.test.ts / embedsApi.test.ts for the publish harness.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { makeClient, type TestClient } from './_client';
import {
  applyMigrations,
  dbAll,
  dbGet,
  dbRun,
  gzip,
  resetDb,
  seedUser,
  setupEmailCapture,
  type EmailCapture,
} from './_setup';
import { ulid } from 'ulidx';
import { transit_realtime } from 'gtfs-realtime-bindings';

async function loggedInClient(
  email: string,
  plan: 'free' | 'agency' | 'enterprise' = 'agency',
): Promise<{ client: TestClient; userId: string }> {
  const user = await seedUser({ email, plan });
  const client = makeClient();
  await client.post('/auth/login', { email: user.email, password: user.password });
  return { client, userId: user.id };
}

// agency_lang: 'es' so we can assert the default-language fallback path.
function makeFeedState(opts: { agencyLang?: string; feedLang?: string } = {}) {
  return {
    feedInfo: {
      feed_publisher_name: 'P7Agency',
      feed_start_date: '20260101',
      feed_end_date: '20261231',
      ...(opts.feedLang ? { feed_lang: opts.feedLang } : {}),
    },
    agencies: [
      {
        agency_id: 'a1',
        agency_name: 'Phase7 Agency',
        agency_url: 'https://x.test',
        agency_timezone: 'America/Denver',
        ...(opts.agencyLang ? { agency_lang: opts.agencyLang } : {}),
      },
    ],
    routes: [
      { route_id: 'R1', agency_id: 'a1', route_short_name: '1', route_long_name: 'Downtown', route_type: 3, route_color: '8e44ad', route_text_color: 'ffffff' },
    ],
    stops: [
      { stop_id: 's1', stop_code: 'A1', stop_name: 'Main & 1st', stop_lat: 45.6, stop_lon: -111.0, wheelchair_boarding: 1 },
      { stop_id: 's2', stop_name: 'Main & 2nd', stop_lat: 45.61, stop_lon: -111.01 },
    ],
    shapes: [{ shape_id: 'sh1', points: [
      { shape_pt_lat: 45.6, shape_pt_lon: -111.0, shape_pt_sequence: 1 },
      { shape_pt_lat: 45.62, shape_pt_lon: -111.02, shape_pt_sequence: 2 },
    ] }],
    calendars: [
      { service_id: 'DAILY', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: '20260101', end_date: '20261231' },
    ],
    calendarDates: [],
    trips: [
      { trip_id: 't1', route_id: 'R1', service_id: 'DAILY', direction_id: 0, shape_id: 'sh1', trip_headsign: 'Downtown' },
    ],
    stopTimes: [
      { trip_id: 't1', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 's1', stop_sequence: 1 },
      { trip_id: 't1', arrival_time: '08:05:00', departure_time: '08:05:00', stop_id: 's2', stop_sequence: 2 },
    ],
  };
}

async function createPublishedProject(
  client: TestClient,
  name: string,
  stateOpts: { agencyLang?: string; feedLang?: string } = {},
): Promise<{ slug: string; id: string }> {
  const proj = await client.json<{ id: string; slug: string }>(
    await client.post('/api/projects', { name }),
  );
  const stateBuf = await gzip(JSON.stringify(makeFeedState(stateOpts)));
  const snapshotForm = new FormData();
  snapshotForm.append('state', new Blob([stateBuf], { type: 'application/json' }), 'state.json.gz');
  snapshotForm.append('meta', JSON.stringify({ summary: {}, validationErrors: 0, validationWarnings: 0 }));
  const snapshot = await client.json<{ snapshot: { id: string } }>(
    await client.post(`/api/projects/${proj.id}/snapshots`, undefined, { body: snapshotForm }),
  );
  const publishForm = new FormData();
  publishForm.append('meta', JSON.stringify({ snapshotId: snapshot.snapshot.id }));
  publishForm.append('zip', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }), 'gtfs.zip');
  await client.post(`/api/projects/${proj.id}/publish`, undefined, { body: publishForm });
  return { slug: proj.slug, id: proj.id };
}

describe('Embeds Phase 7', () => {
  let capture: EmailCapture;
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    capture = setupEmailCapture();
  });
  afterEach(() => {
    capture.restore();
    vi.restoreAllMocks();
  });

  // ─── 1. Theming ─────────────────────────────────────────────────────────────

  describe('theming', () => {
    it('applies an accent= override and folds it into the ETag', async () => {
      const { client } = await loggedInClient('p7-theme1@example.com');
      const { slug } = await createPublishedProject(client, 'ThemeAccent');

      const plain = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map`);
      const themed = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map?accent=00aaff`);
      expect(plain.status).toBe(200);
      expect(themed.status).toBe(200);

      const themedHtml = await themed.text();
      // The accent override emits a CSS var with the chosen color.
      expect(themedHtml).toContain('--brand: #00aaff');

      // Theme is part of the cache key: the two ETags must differ so the edge
      // cache never serves the un-themed page for a themed request.
      const plainEtag = plain.headers.get('ETag');
      const themedEtag = themed.headers.get('ETag');
      expect(plainEtag).toBeTruthy();
      expect(themedEtag).toBeTruthy();
      expect(plainEtag).not.toBe(themedEtag);
    });

    it('applies dark mode and a font override', async () => {
      const { client } = await loggedInClient('p7-theme2@example.com');
      const { slug } = await createPublishedProject(client, 'ThemeDark');

      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/route/R1?theme=dark&font=serif`);
      expect(res.status).toBe(200);
      const html = await res.text();
      // Dark surface override + font var present.
      expect(html).toContain('background: #14110e');
      expect(html).toContain('--embed-font: Georgia');
    });

    it('ignores an invalid accent and serves the default page', async () => {
      const { client } = await loggedInClient('p7-theme3@example.com');
      const { slug } = await createPublishedProject(client, 'ThemeBad');

      const plain = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map`);
      const bad = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map?accent=notacolor`);
      expect(bad.status).toBe(200);
      // Invalid accent → no override → same cache key as the plain page.
      expect(bad.headers.get('ETag')).toBe(plain.headers.get('ETag'));
      expect(await bad.text()).not.toContain('--brand: #notacolor');
    });
  });

  // ─── 2. i18n ──────────────────────────────────────────────────────────────────

  describe('i18n', () => {
    it('translates UI chrome to the lang= param (es) while leaving GTFS content verbatim', async () => {
      const { client } = await loggedInClient('p7-i18n1@example.com');
      const { slug } = await createPublishedProject(client, 'I18nEs');

      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map?lang=es`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('lang="es"');
      // Localized chrome.
      expect(html).toContain('Mapa del sistema');
      expect(html).toContain('Rutas');
      // GTFS content is NOT translated — agency + route names stay as authored.
      expect(html).toContain('Phase7 Agency');
      expect(html).toContain('Downtown');
    });

    it('localizes the stop page departures heading + accessibility label (fr)', async () => {
      const { client } = await loggedInClient('p7-i18n2@example.com');
      const { slug } = await createPublishedProject(client, 'I18nFr');

      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1?lang=fr`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('lang="fr"');
      expect(html).toContain('Départs'); // "Departures today (...)"
      expect(html).toContain('Accessible aux fauteuils roulants'); // wheelchair_boarding=1
    });

    it('falls back to agency_lang when no lang= param is given', async () => {
      const { client } = await loggedInClient('p7-i18n3@example.com');
      const { slug } = await createPublishedProject(client, 'I18nDefault', { agencyLang: 'es' });

      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map`);
      const html = await res.text();
      expect(html).toContain('lang="es"');
      expect(html).toContain('Mapa del sistema');
    });

    it('falls back to English for an unsupported lang', async () => {
      const { client } = await loggedInClient('p7-i18n4@example.com');
      const { slug } = await createPublishedProject(client, 'I18nUnsup');

      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map?lang=zz`);
      const html = await res.text();
      expect(html).toContain('lang="en"');
      expect(html).toContain('System map');
    });

    it('lang is part of the cache key (different ETag per language)', async () => {
      const { client } = await loggedInClient('p7-i18n5@example.com');
      const { slug } = await createPublishedProject(client, 'I18nEtag');
      const en = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map?lang=en`);
      const es = await SELF.fetch(`http://feeds.example.com/${slug}/embed/system-map?lang=es`);
      expect(en.headers.get('ETag')).not.toBe(es.headers.get('ETag'));
    });
  });

  // ─── 3. Impression counters ───────────────────────────────────────────────────

  describe('impression counters', () => {
    it('beacon returns a no-store 1x1 gif and counts a view', async () => {
      const { client } = await loggedInClient('p7-imp1@example.com');
      const { slug, id } = await createPublishedProject(client, 'ImpCount');

      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/beacon?kind=stop&target=s1`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/gif');
      expect(res.headers.get('Cache-Control')).toContain('no-store');

      const row = await dbGet<{ views: number; kind: string; target: string }>(
        `SELECT views, kind, target FROM embed_impression WHERE project_id = ?`,
        id,
      );
      expect(row?.kind).toBe('stop');
      expect(row?.target).toBe('s1');
      expect(row?.views).toBe(1);
    });

    it('increments the same daily bucket on repeat views', async () => {
      const { client } = await loggedInClient('p7-imp2@example.com');
      const { slug, id } = await createPublishedProject(client, 'ImpRepeat');
      for (let i = 0; i < 3; i++) {
        await SELF.fetch(`http://feeds.example.com/${slug}/embed/beacon?kind=system-map`);
      }
      const rows = await dbAll<{ views: number }>(
        `SELECT views FROM embed_impression WHERE project_id = ? AND kind = 'system-map'`,
        id,
      );
      expect(rows.length).toBe(1);
      expect(rows[0].views).toBe(3);
    });

    it('ignores an unknown kind (still returns the pixel, counts nothing)', async () => {
      const { client } = await loggedInClient('p7-imp3@example.com');
      const { slug, id } = await createPublishedProject(client, 'ImpBadKind');
      const res = await SELF.fetch(`http://feeds.example.com/${slug}/embed/beacon?kind=hacker`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('image/gif');
      const rows = await dbAll(`SELECT 1 FROM embed_impression WHERE project_id = ?`, id);
      expect(rows.length).toBe(0);
    });

    it('embed pages include the beacon snippet', async () => {
      const { client } = await loggedInClient('p7-imp4@example.com');
      const { slug } = await createPublishedProject(client, 'ImpSnippet');
      const html = await (await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`)).text();
      expect(html).toContain('/embed/beacon?kind=stop');
    });

    it('owner rollup endpoint returns aggregate counts (no PII)', async () => {
      const { client } = await loggedInClient('p7-imp5@example.com');
      const { slug, id } = await createPublishedProject(client, 'ImpRollup');
      await SELF.fetch(`http://feeds.example.com/${slug}/embed/beacon?kind=stop&target=s1`);
      await SELF.fetch(`http://feeds.example.com/${slug}/embed/beacon?kind=stop&target=s1`);
      await SELF.fetch(`http://feeds.example.com/${slug}/embed/beacon?kind=route&target=R1`);

      const res = await client.get(`/api/projects/${id}/embed-impressions`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        total: number;
        by_kind: Record<string, number>;
        top_targets: { kind: string; target: string; views: number }[];
      };
      expect(body.total).toBe(3);
      expect(body.by_kind.stop).toBe(2);
      expect(body.by_kind.route).toBe(1);
      const top = body.top_targets.find((t) => t.target === 's1');
      expect(top?.views).toBe(2);
    });

    it('owner rollup is gated by the embeds entitlement (402 paywall for free)', async () => {
      // The owner-facing /api/projects endpoint uses the app's standard 402
      // paywall (requireOwnerFeature), matching brand_color / publish gating —
      // unlike the public JSON/RT surfaces which serve a 403 to integrators.
      const { client, userId } = await loggedInClient('p7-imp6@example.com');
      const { id } = await createPublishedProject(client, 'ImpGate');
      await dbRun(`UPDATE user SET plan = 'free' WHERE id = ?`, userId);
      const res = await client.get(`/api/projects/${id}/embed-impressions`);
      expect(res.status).toBe(402);
    });
  });

  // ─── 4. GTFS-Realtime passthrough ───────────────────────────────────────────

  describe('rt passthrough', () => {
    function makeTripUpdatesPb(stopId: string, time: number): Uint8Array {
      const rt = transit_realtime;
      const msg = rt.FeedMessage.create({
        header: { gtfsRealtimeVersion: '2.0', incrementality: rt.FeedHeader.Incrementality.FULL_DATASET, timestamp: Math.floor(Date.now() / 1000) },
        entity: [
          {
            id: 'e1',
            tripUpdate: {
              trip: { tripId: 't1' },
              stopTimeUpdate: [{ stopId, departure: { time } }],
            },
          },
        ],
      });
      return rt.FeedMessage.encode(msg).finish();
    }

    async function registerRtFeed(projectId: string, kind: string, url: string) {
      await dbRun(
        `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at, managed) VALUES (?, ?, ?, ?, ?, 0)`,
        ulid(),
        projectId,
        kind,
        url,
        Date.now(),
      );
    }

    it('404s when no RT source is registered for the kind', async () => {
      const { client } = await loggedInClient('p7-rt1@example.com');
      const { slug } = await createPublishedProject(client, 'RtNone');
      const res = await SELF.fetch(`http://feeds.example.com/${slug}/rt/vehicle_positions.json`);
      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('no_rt_source');
    });

    it('proxies a registered trip_updates feed as protobuf and JSON', async () => {
      const { client } = await loggedInClient('p7-rt2@example.com');
      const { slug, id } = await createPublishedProject(client, 'RtProxy');
      const upstream = 'https://rt.upstream.test/trip_updates.pb';
      await registerRtFeed(id, 'trip_updates', upstream);

      const pb = makeTripUpdatesPb('s1', 1717000000);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (u === upstream) {
          return new Response(pb, { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } });
        }
        throw new Error(`unexpected fetch ${u}`);
      });

      const jsonRes = await SELF.fetch(`http://feeds.example.com/${slug}/rt/trip_updates.json`);
      expect(jsonRes.status).toBe(200);
      expect(jsonRes.headers.get('Content-Type')).toContain('application/json');
      expect(jsonRes.headers.get('Access-Control-Allow-Origin')).toBe('*');
      const json = await jsonRes.json() as { entity: { tripUpdate: { trip: { tripId: string } } }[] };
      expect(json.entity[0].tripUpdate.trip.tripId).toBe('t1');

      const pbRes = await SELF.fetch(`http://feeds.example.com/${slug}/rt/trip_updates.pb`);
      expect(pbRes.status).toBe(200);
      expect(pbRes.headers.get('Content-Type')).toBe('application/x-protobuf');

      fetchSpy.mockRestore();
    });

    it('502s when the upstream RT feed is unreachable', async () => {
      const { client } = await loggedInClient('p7-rt3@example.com');
      const { slug, id } = await createPublishedProject(client, 'RtDown');
      const upstream = 'https://rt.down.test/vp.pb';
      await registerRtFeed(id, 'vehicle_positions', upstream);

      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('network down');
      });
      const res = await SELF.fetch(`http://feeds.example.com/${slug}/rt/vehicle_positions.pb`);
      expect(res.status).toBe(502);
    });

    it('RT passthrough is gated by the embeds entitlement (403 for free owner)', async () => {
      const { client, userId } = await loggedInClient('p7-rt4@example.com');
      const { slug, id } = await createPublishedProject(client, 'RtGate');
      await registerRtFeed(id, 'trip_updates', 'https://rt.gate.test/tu.pb');
      await dbRun(`UPDATE user SET plan = 'free' WHERE id = ?`, userId);
      const res = await SELF.fetch(`http://feeds.example.com/${slug}/rt/trip_updates.json`);
      expect(res.status).toBe(403);
    });

    it('stop embed includes the live RT enhancer only when a trip_updates source exists', async () => {
      const { client } = await loggedInClient('p7-rt5@example.com');
      const { slug, id } = await createPublishedProject(client, 'RtEnhancer');

      const before = await (await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`)).text();
      expect(before).not.toContain('/rt/trip_updates.json');

      await registerRtFeed(id, 'trip_updates', 'https://rt.enh.test/tu.pb');
      const after = await (await SELF.fetch(`http://feeds.example.com/${slug}/embed/stop/s1`)).text();
      expect(after).toContain('/rt/trip_updates.json');
      // Departure <li> carries the data-trip hook the enhancer matches on.
      expect(after).toContain('data-trip="t1"');
    });
  });
});
