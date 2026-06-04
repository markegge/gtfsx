import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import type { Stop, Trip, StopTime, Calendar, Frequency } from '../../types/gtfs';
import type { BlockGroupData } from '../demographics';
import type { FeedSlice } from '../stopAnalysis';
import {
  buildNetworkWalkshed,
  circlePolygonOverlapFraction,
  coverageFromWalkshed,
  walkshedGeoJSON,
  minutesForHeadway,
  stopHeadwaysMin,
  autoMinutesByStop,
  AUTO_FREQUENT_MINUTES,
  AUTO_INFREQUENT_MINUTES,
  FREQUENT_HEADWAY_MAX_MIN,
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

/* ─────────────── Auto-by-frequency walk-time classification ─────────────── */

describe('minutesForHeadway', () => {
  it('gives the frequent (10-min / ½-mi) walkshed at exactly the 15-min cutoff', () => {
    expect(minutesForHeadway(FREQUENT_HEADWAY_MAX_MIN)).toBe(AUTO_FREQUENT_MINUTES);
    expect(minutesForHeadway(15)).toBe(10);
    expect(minutesForHeadway(5)).toBe(10);
  });

  it('gives the infrequent (5-min / ¼-mi) walkshed above the cutoff', () => {
    expect(minutesForHeadway(15.1)).toBe(AUTO_INFREQUENT_MINUTES);
    expect(minutesForHeadway(30)).toBe(5);
    expect(minutesForHeadway(60)).toBe(5);
  });

  it('treats an unknown headway (null) as infrequent', () => {
    expect(minutesForHeadway(null)).toBe(AUTO_INFREQUENT_MINUTES);
  });
});

// Minimal feed builders for the headway computation. One all-week calendar so
// the representative day picks up every trip.
const ALL_WEEK: Calendar = {
  service_id: 'WK',
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
  start_date: '20260101', end_date: '20261231',
};

function trip(id: string, routeId = 'R1'): Trip {
  return { trip_id: id, route_id: routeId, service_id: 'WK', direction_id: 0 };
}

/** A stop_time at `stopId` for `tripId` departing at HH:MM:SS. */
function st(tripId: string, stopId: string, time: string, seq = 1): StopTime {
  return { trip_id: tripId, stop_id: stopId, arrival_time: time, departure_time: time, stop_sequence: seq };
}

function feed(over: Partial<FeedSlice>): FeedSlice {
  return {
    stops: [], routes: [], routeStops: [], trips: [], stopTimes: [],
    calendars: [ALL_WEEK], calendarDates: [], frequencies: [],
    ...over,
  };
}

describe('stopHeadwaysMin', () => {
  it('computes average headway = span ÷ (departures − 1)', () => {
    // Stop F served at 08:00, 08:10, 08:20, 08:30 → span 30 min over 3 gaps = 10 min.
    const f = feed({
      stops: [stop('F', 40, -100)],
      trips: [trip('t1'), trip('t2'), trip('t3'), trip('t4')],
      stopTimes: [
        st('t1', 'F', '08:00:00'),
        st('t2', 'F', '08:10:00'),
        st('t3', 'F', '08:20:00'),
        st('t4', 'F', '08:30:00'),
      ],
    });
    expect(stopHeadwaysMin(f).get('F')).toBeCloseTo(10, 5);
  });

  it('returns no headway for a stop with a single departure', () => {
    const f = feed({
      stops: [stop('S', 40, -100)],
      trips: [trip('t1')],
      stopTimes: [st('t1', 'S', '08:00:00')],
    });
    expect(stopHeadwaysMin(f).has('S')).toBe(false);
  });

  it('honors frequencies.txt by expanding a frequency-based trip into departures', () => {
    // One trip, but frequencies says it runs every 12 min from 06:00 to 09:00
    // (span 180 min). Departures = 06:00,06:12,…,08:48 → 15 deps, 14 gaps,
    // average ≈ 168/14 = 12 min ≤ 15 → frequent.
    const freq: Frequency = { trip_id: 't1', start_time: '06:00:00', end_time: '09:00:00', headway_secs: 720 };
    const f = feed({
      stops: [stop('Q', 40, -100)],
      trips: [trip('t1')],
      stopTimes: [st('t1', 'Q', '06:00:00')],
      frequencies: [freq],
    });
    const hw = stopHeadwaysMin(f).get('Q');
    expect(hw).toBeDefined();
    expect(hw!).toBeLessThanOrEqual(FREQUENT_HEADWAY_MAX_MIN);
    expect(hw!).toBeCloseTo(12, 5);
  });
});

describe('autoMinutesByStop', () => {
  it('assigns 10 min to frequent stops and 5 min to infrequent ones', () => {
    // Frequent stop A: 4 trips, 10-min headway. Infrequent stop B: 2 trips, 60-min apart.
    const f = feed({
      stops: [stop('A', 40, -100), stop('B', 41, -100)],
      trips: [trip('a1'), trip('a2'), trip('a3'), trip('a4'), trip('b1'), trip('b2')],
      stopTimes: [
        st('a1', 'A', '08:00:00'),
        st('a2', 'A', '08:10:00'),
        st('a3', 'A', '08:20:00'),
        st('a4', 'A', '08:30:00'),
        st('b1', 'B', '08:00:00'),
        st('b2', 'B', '09:00:00'),
      ],
    });
    const m = autoMinutesByStop(f);
    expect(m.get('A')).toBe(AUTO_FREQUENT_MINUTES); // 10 min
    expect(m.get('B')).toBe(AUTO_INFREQUENT_MINUTES); // 5 min
  });

  it('defaults an unserved stop (no departures) to the infrequent walkshed', () => {
    const f = feed({ stops: [stop('Z', 40, -100)] });
    expect(autoMinutesByStop(f).get('Z')).toBe(AUTO_INFREQUENT_MINUTES);
  });
});

describe('buildNetworkWalkshed with a per-stop minutes resolver', () => {
  it('issues a separate isochrone per (coord, walk-time) and resolves per stop', async () => {
    const poly = squarePolygon(-100, 40, 0.02);
    const fetchMock = vi.fn().mockResolvedValue(isochroneResponse(poly));
    vi.stubGlobal('fetch', fetchMock);

    // Two distinct locations; resolver asks for 10 min at the first, 5 at the second.
    const stops = [stop('frequent', 40, -100), stop('infrequent', 41, -100)];
    const minutesByStop = new Map([['frequent', 10], ['infrequent', 5]]);
    const res = await buildNetworkWalkshed(stops, (s) => minutesByStop.get(s.stop_id) ?? 5);

    expect(res.status).toBe('ok');
    expect(res.requestCount).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The 10-min request must carry contours_minutes=10, the 5-min one =5.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('contours_minutes=10'))).toBe(true);
    expect(urls.some((u) => u.includes('contours_minutes=5'))).toBe(true);
  });
});
