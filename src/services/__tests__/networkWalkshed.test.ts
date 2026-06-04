import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import type { Stop } from '../../types/gtfs';
import type { BlockGroupData } from '../demographics';
import {
  buildNetworkWalkshed,
  circlePolygonOverlapFraction,
  coverageFromWalkshed,
  walkshedGeoJSON,
  MAX_ISOCHRONE_REQUESTS,
  _clearIsochroneCache,
} from '../networkWalkshed';

function stop(id: string, lat: number, lon: number): Stop {
  return { stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0 };
}

function bg(geoid: string, lat: number, lon: number, extra: Partial<BlockGroupData> = {}): BlockGroupData {
  return {
    geoid, lat, lon,
    population: 0, households: 0, workers: 0,
    minorityPop: 0, totalRacePop: 0,
    lowIncomePop: 0, povertyUniverse: 0,
    zeroVehicleHouseholds: 0, occupiedHouseholds: 0,
    seniorPop: 0, youthPop: 0,
    ...extra,
  };
}

// A ~0.06° square (≈ 4 mi across) centred on (40, -100): big enough to fully
// contain a BG circle modeled at (40, -100) with sub-mile radius.
function squarePolygon(lon: number, lat: number, halfDeg: number): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lon - halfDeg, lat - halfDeg],
        [lon + halfDeg, lat - halfDeg],
        [lon + halfDeg, lat + halfDeg],
        [lon - halfDeg, lat + halfDeg],
        [lon - halfDeg, lat - halfDeg],
      ]],
    },
  };
}

/** Build a fake Mapbox Isochrone response wrapping a polygon. */
function isochroneResponse(poly: Feature<Polygon>) {
  return {
    ok: true,
    json: async () => ({ features: [poly] }),
  } as unknown as Response;
}

afterEach(() => {
  _clearIsochroneCache();
  vi.restoreAllMocks();
});

describe('circlePolygonOverlapFraction', () => {
  it('is ~1 when the BG circle is fully inside the polygon', () => {
    const poly = squarePolygon(-100, 40, 0.06); // ~4 mi across
    const f = circlePolygonOverlapFraction(-100, 40, 0.5, poly);
    expect(f).toBeGreaterThan(0.99);
  });

  it('is 0 when the BG circle is far outside the polygon', () => {
    const poly = squarePolygon(-100, 40, 0.01);
    const f = circlePolygonOverlapFraction(-100, 50, 0.5, poly); // 10° north
    expect(f).toBe(0);
  });

  it('is partial when the circle straddles the polygon edge', () => {
    // Polygon covers only east of lon -100; BG centred on the boundary.
    const poly: Feature<Polygon> = {
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[
        [-100, 39.9], [-99.8, 39.9], [-99.8, 40.1], [-100, 40.1], [-100, 39.9],
      ]] },
    };
    const f = circlePolygonOverlapFraction(-100, 40, 0.5, poly);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(1);
  });
});

describe('coverageFromWalkshed', () => {
  it('apportions a covered block group and excludes a distant one', () => {
    const poly = squarePolygon(-100, 40, 0.06);
    const bgs = [
      bg('in', 40, -100, { population: 1000, households: 400, workers: 600 }),
      bg('out', 50, -100, { population: 999 }),
    ];
    const r = coverageFromWalkshed(poly, bgs, 0.25);
    expect(r.totalPopulation).toBeGreaterThan(900); // ~fully inside
    expect(r.coveredBlockGroupIds).toContain('in');
    expect(r.coveredBlockGroupIds).not.toContain('out');
    expect(r.bufferMiles).toBe(0.25); // carried through as the label
  });
});

describe('buildNetworkWalkshed', () => {
  it('returns empty status with no stops', async () => {
    const res = await buildNetworkWalkshed([], 10);
    expect(res.status).toBe('empty');
    expect(res.polygon).toBeNull();
  });

  it('fetches, dedupes by rounded coord, unions, and caches', async () => {
    const poly = squarePolygon(-100, 40, 0.02);
    const fetchMock = vi.fn().mockResolvedValue(isochroneResponse(poly));
    vi.stubGlobal('fetch', fetchMock);

    // Two stops at the same rounded coordinate → one request.
    const stops = [stop('a', 40.0001, -100.0001), stop('b', 40.0002, -100.0002)];
    const res = await buildNetworkWalkshed(stops, 10);
    expect(res.status).toBe('ok');
    expect(res.polygon).not.toBeNull();
    expect(res.requestCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Re-run hits the cache → no new fetch.
    const res2 = await buildNetworkWalkshed(stops, 10);
    expect(res2.status).toBe('ok');
    expect(res2.requestCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps requests and reports without truncating', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // One more distinct coord than the cap.
    const stops: Stop[] = [];
    for (let i = 0; i <= MAX_ISOCHRONE_REQUESTS; i++) {
      stops.push(stop(`s${i}`, 40 + i * 0.01, -100));
    }
    const res = await buildNetworkWalkshed(stops, 10);
    expect(res.status).toBe('capped');
    expect(res.polygon).toBeNull();
    expect(res.neededRequests).toBe(MAX_ISOCHRONE_REQUESTS + 1);
    expect(res.message).toContain('cap');
    expect(fetchMock).not.toHaveBeenCalled(); // no API calls when over cap
  });

  it('falls back with an error status when the API fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response));
    const res = await buildNetworkWalkshed([stop('a', 40, -100)], 10);
    expect(res.status).toBe('error');
    expect(res.polygon).toBeNull();
    expect(res.message).toContain('straight-line buffer');
  });

  it('returns empty when the API reports no reachable polygon', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) } as unknown as Response));
    const res = await buildNetworkWalkshed([stop('a', 40, -100)], 10);
    expect(res.status).toBe('empty');
    expect(res.polygon).toBeNull();
  });
});

describe('walkshedGeoJSON', () => {
  it('tags the polygon with route id + color', () => {
    const poly = squarePolygon(-100, 40, 0.02);
    const feats = walkshedGeoJSON(poly, '#ff0000', 'R1');
    expect(feats).toHaveLength(1);
    expect(feats[0].properties).toMatchObject({ route_id: 'R1', route_color: '#ff0000' });
  });

  it('returns nothing for a null polygon', () => {
    expect(walkshedGeoJSON(null, '#fff', 'R1')).toHaveLength(0);
  });
});
