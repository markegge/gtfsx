/**
 * Unit tests for src/services/routeGeometry.ts — mocked fetch, never the real
 * Mapbox API.
 *
 * This module exists because Map Matching (snapToRoad.ts) is the wrong primitive
 * for stops that sit miles apart: it returned stubs covering 3-7% of the real
 * corridor on the Skyline feed. So the things that matter here are that we call
 * DIRECTIONS with the stops as waypoints, that a >25-waypoint chain is chunked
 * and stitched back into ONE continuous line (no duplicated seam vertex, no
 * hole), and that a failure degrades honestly rather than silently truncating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type LngLat = [number, number];

/** A Directions response whose geometry is just the waypoints it was given,
 *  plus a midpoint on each leg (stands in for road vertices). */
function geometryFor(coordString: string): LngLat[] {
  const waypoints: LngLat[] = coordString
    .split(';')
    .map((pair) => pair.split(',').map(Number) as LngLat);
  const out: LngLat[] = [waypoints[0]];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    out.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    out.push(b);
  }
  return out;
}

/** Mock fetch that answers every Directions call with a route through exactly
 *  the waypoints in the URL. `failFor` lets a test fail specific windows. */
function mockDirections(opts: { failFor?: (coordString: string) => boolean } = {}) {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url);
    const coordString = url.split('/driving/')[1].split('?')[0];
    if (opts.failFor?.(coordString)) {
      return { ok: false, status: 422, json: () => Promise.resolve({}) };
    }
    return {
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          code: 'Ok',
          routes: [{ geometry: { type: 'LineString', coordinates: geometryFor(coordString) } }],
        }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, urls };
}

/** N stops marching north-east, 0.01° apart. */
const stopChain = (n: number): LngLat[] =>
  Array.from({ length: n }, (_, i) => [-111.04 + i * 0.01, 45.68 + i * 0.01] as LngLat);

describe('routeThroughStops', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.test-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('calls the Directions API with the stops as waypoints', async () => {
    const { urls } = mockDirections();
    const { routeThroughStops } = await import('../routeGeometry');

    const stops = stopChain(3);
    const result = await routeThroughStops(stops);

    expect(urls).toHaveLength(1);
    // Directions (NOT map matching), full geojson geometry, token attached.
    expect(urls[0]).toContain('https://api.mapbox.com/directions/v5/mapbox/driving/');
    expect(urls[0]).toContain('geometries=geojson');
    expect(urls[0]).toContain('overview=full');
    expect(urls[0]).toContain('access_token=pk.test-token');
    // Every stop is a waypoint, in order.
    const coordString = urls[0].split('/driving/')[1].split('?')[0];
    expect(coordString).toBe(stops.map((c) => `${c[0]},${c[1]}`).join(';'));

    expect(result.status).toBe('routed');
    // Geometry starts and ends at the first/last stop and passes through them all.
    expect(result.coords[0]).toEqual(stops[0]);
    expect(result.coords[result.coords.length - 1]).toEqual(stops[2]);
    expect(result.coords).toContainEqual(stops[1]);
  });

  it('chunks a >25-waypoint chain into overlapping windows and stitches ONE continuous line', async () => {
    const { urls } = mockDirections();
    const { routeThroughStops } = await import('../routeGeometry');

    // 30 stops → windows [0..24] and [24..29] (overlapping by the 25th stop).
    const stops = stopChain(30);
    const result = await routeThroughStops(stops);

    expect(result.status).toBe('routed');
    expect(urls).toHaveLength(2);

    const windows = urls.map((u) =>
      u
        .split('/driving/')[1]
        .split('?')[0]
        .split(';')
        .map((pair) => pair.split(',').map(Number) as LngLat),
    );
    expect(windows[0]).toHaveLength(25); // the Directions cap
    expect(windows[0][0]).toEqual(stops[0]);
    expect(windows[0][24]).toEqual(stops[24]);
    // Overlap by exactly one: the next window RESUMES at the previous one's last
    // stop, so there's no unrouted gap between the windows.
    expect(windows[1][0]).toEqual(stops[24]);
    expect(windows[1][windows[1].length - 1]).toEqual(stops[29]);

    // The seam vertex appears exactly ONCE in the stitched line…
    const seam = stops[24];
    const seamHits = result.coords.filter((c) => c[0] === seam[0] && c[1] === seam[1]);
    expect(seamHits).toHaveLength(1);
    // …no vertex is repeated back-to-back anywhere (a duplicated joint would
    // show up here)…
    for (let i = 1; i < result.coords.length; i++) {
      expect(result.coords[i]).not.toEqual(result.coords[i - 1]);
    }
    // …and every stop is still on the line, in order.
    expect(result.coords[0]).toEqual(stops[0]);
    expect(result.coords[result.coords.length - 1]).toEqual(stops[29]);
    for (const stop of stops) expect(result.coords).toContainEqual(stop);
  });

  it('is "partial" when only some windows route, filling the failed window with its stops', async () => {
    const stops = stopChain(30);
    // Fail the SECOND window (the one that starts at stop 24).
    const secondWindowStart = `${stops[24][0]},${stops[24][1]}`;
    mockDirections({ failFor: (cs) => cs.startsWith(secondWindowStart) });
    const { routeThroughStops } = await import('../routeGeometry');

    const result = await routeThroughStops(stops);

    expect(result.status).toBe('partial');
    // The unrouted window is straight rather than missing: the line still spans
    // the whole chain (which is what the caller's length guard checks).
    expect(result.coords[0]).toEqual(stops[0]);
    expect(result.coords[result.coords.length - 1]).toEqual(stops[29]);
    for (const stop of stops) expect(result.coords).toContainEqual(stop);
    for (let i = 1; i < result.coords.length; i++) {
      expect(result.coords[i]).not.toEqual(result.coords[i - 1]);
    }
  });

  it('is "failed" (input returned unchanged) when the request fails', async () => {
    mockDirections({ failFor: () => true });
    const { routeThroughStops } = await import('../routeGeometry');

    const stops = stopChain(3);
    const result = await routeThroughStops(stops);

    expect(result.status).toBe('failed');
    expect(result.coords).toEqual(stops); // caller falls back to the straight line
  });

  it('is "failed" when the network throws, or the API answers with no route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { routeThroughStops } = await import('../routeGeometry');
    expect((await routeThroughStops(stopChain(3))).status).toBe('failed');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ code: 'NoRoute', routes: [] }),
      }),
    );
    const again = await routeThroughStops(stopChain(3));
    expect(again.status).toBe('failed');
    expect(again.coords).toEqual(stopChain(3));
  });

  it('makes no request for fewer than 2 stops', async () => {
    const { fetchMock } = mockDirections();
    const { routeThroughStops } = await import('../routeGeometry');

    expect(await routeThroughStops([])).toEqual({ status: 'routed', coords: [] });
    const one = stopChain(1);
    expect(await routeThroughStops(one)).toEqual({ status: 'routed', coords: one });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pathLengthMeters', () => {
  it('measures a polyline in metres', async () => {
    const { pathLengthMeters } = await import('../routeGeometry');

    expect(pathLengthMeters([])).toBe(0);
    expect(pathLengthMeters([[-111.04, 45.68]])).toBe(0);

    // ~0.01° of latitude ≈ 1.11 km.
    const oneLeg = pathLengthMeters([
      [-111.04, 45.68],
      [-111.04, 45.69],
    ]);
    expect(oneLeg).toBeGreaterThan(1050);
    expect(oneLeg).toBeLessThan(1150);

    // Cumulative over legs.
    const twoLegs = pathLengthMeters([
      [-111.04, 45.68],
      [-111.04, 45.69],
      [-111.04, 45.70],
    ]);
    expect(twoLegs).toBeCloseTo(oneLeg * 2, 0);
  });
});
