// A2c — spatial metrics for the variant-compare modal: the pure computation
// seam (metric assembly, fingerprint, cache invalidation, delta math). The FGB
// network layer is faked at the same `loadBlocks` seam the coverage tests use.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route, RouteStop, Stop } from '../../types/gtfs';
import type { BlockPoint } from '../blockCoverage';
import {
  clearVariantSpatialCache,
  computeSpatialMetrics,
  getVariantSpatialMetrics,
  peekVariantSpatialMetrics,
  spatialDelta,
  stopSetFingerprint,
  type SpatialInput,
} from '../variantSpatialMetrics';

/* ── fixtures (mirror walkshedProfile.test.ts) ── */

function blk(geoid: string, lon: number, lat: number, attrs: Partial<BlockPoint> = {}): BlockPoint {
  return {
    geoid, lon, lat,
    pop: 0, hh: 0, workers: 0,
    minority: 0, race_pop: 0, lowinc: 0, pov_univ: 0,
    zeroveh_hh: 0, occ_hh: 0, senior: 0, youth: 0,
    carless: 0, disability: 0, prop_all: 0, need_all: 0, jobs: 0,
    ...attrs,
  };
}

function richBlock(geoid: string, lon: number, lat: number, scale = 1): BlockPoint {
  return blk(geoid, lon, lat, {
    pop: 100 * scale, hh: 40 * scale, workers: 55 * scale,
    minority: 25 * scale, race_pop: 100 * scale, lowinc: 35 * scale, pov_univ: 95 * scale,
    zeroveh_hh: 8 * scale, occ_hh: 40 * scale, senior: 15 * scale, youth: 20 * scale,
    carless: 12 * scale, disability: 10 * scale, prop_all: 40 * scale, need_all: 62 * scale, jobs: 60 * scale,
  });
}

function stop(id: string, lon: number, lat: number): Stop {
  return { stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0 };
}
function route(id: string, routeType: number): Route {
  return {
    route_id: id, agency_id: 'a', route_short_name: id, route_long_name: id,
    route_type: routeType, route_color: '000000', route_text_color: 'FFFFFF',
  };
}
function rs(routeId: string, stopId: string, seq: number): RouteStop {
  return { route_id: routeId, stop_id: stopId, direction_id: 0, stop_sequence: seq, _snapped: false };
}

// Two overlapping stops near a shared block + a block only near stop A; the
// system is the UNION, so SHARED is counted once.
const SHARED = richBlock('SHARED', -111.0, 46.0);
const NEAR_A = richBlock('NEAR_A', -111.006, 46.0, 0.5);
const FAR = richBlock('FAR', -110.0, 46.0, 9); // outside every walkshed

const stops = [stop('A', -111.003, 46.0), stop('B', -110.997, 46.0)];
const routes = [route('r1', 3)];
const routeStops = [rs('r1', 'A', 1), rs('r1', 'B', 2)];
const input: SpatialInput = { stops, routes, routeStops };

const fakeLoad = async (): Promise<BlockPoint[]> => [SHARED, NEAR_A, FAR];

beforeEach(() => clearVariantSpatialCache());

/* ── metric assembly ── */

describe('computeSpatialMetrics', () => {
  it('reduces the system walkshed to the six-metric bundle (union, block counted once)', async () => {
    const m = await computeSpatialMetrics(input, fakeLoad);
    // SHARED(100) + NEAR_A(50), FAR excluded; union so SHARED counts once.
    expect(m.population).toBe(150);
    expect(m.households).toBe(60);       // 40 + 20
    expect(m.jobs).toBe(90);             // 60 + 30
    expect(m.blocksCovered).toBe(2);     // SHARED + NEAR_A
    expect(m.stopCount).toBe(2);
    // Equity segments + the two estimates carried straight through.
    expect(m.needAll).toBe(93);          // 62 + 31
    expect(m.propensityAll).toBe(60);    // 40 + 20
    expect(m.carless).toBe(18);          // 12 + 6
    expect(m.lowIncome).toBe(52.5);      // 35 + 17.5
    expect(m.seniors).toBe(22.5);        // 15 + 7.5
    expect(m.disability).toBe(15);       // 10 + 5
  });

  it('propagates the region gate as a rejection (no fabricated zeros)', async () => {
    await expect(
      computeSpatialMetrics({ stops: [stop('L', -0.13, 51.5)], routes: [], routeStops: [] }, async () => []),
    ).rejects.toThrow(/United States/);
  });
});

/* ── fingerprint: the cache invalidation contract ── */

describe('stopSetFingerprint', () => {
  it('is stable across array reordering (order does not change the answer)', () => {
    const a = stopSetFingerprint(input);
    const reordered: SpatialInput = {
      stops: [stops[1], stops[0]],
      routes,
      routeStops: [routeStops[1], routeStops[0]],
    };
    expect(stopSetFingerprint(reordered)).toBe(a);
  });

  it('is UNCHANGED by a non-stop edit (retime / rename) — cache should survive it', () => {
    const before = stopSetFingerprint(input);
    // A route rename / recolor doesn't touch stops or tram membership.
    const renamed: SpatialInput = { stops, routes: [{ ...routes[0], route_long_name: 'Renamed' }], routeStops };
    expect(stopSetFingerprint(renamed)).toBe(before);
  });

  it('CHANGES when a stop moves', () => {
    const before = stopSetFingerprint(input);
    const moved: SpatialInput = { stops: [{ ...stops[0], stop_lat: 46.01 }, stops[1]], routes, routeStops };
    expect(stopSetFingerprint(moved)).not.toBe(before);
  });

  it('CHANGES when a stop is added or removed', () => {
    const before = stopSetFingerprint(input);
    const added: SpatialInput = { stops: [...stops, stop('C', -111.5, 46)], routes, routeStops };
    expect(stopSetFingerprint(added)).not.toBe(before);
    const removed: SpatialInput = { stops: [stops[0]], routes, routeStops };
    expect(stopSetFingerprint(removed)).not.toBe(before);
  });

  it('CHANGES when a route flips to tram (the stop buffer grows to ½ mi)', () => {
    const before = stopSetFingerprint(input);
    const tram: SpatialInput = { stops, routes: [route('r1', 0)], routeStops };
    expect(stopSetFingerprint(tram)).not.toBe(before);
  });
});

/* ── the session cache ── */

describe('getVariantSpatialMetrics / peekVariantSpatialMetrics', () => {
  it('computes once, then serves the cache without touching the network again', async () => {
    const load = vi.fn(fakeLoad);
    const first = await getVariantSpatialMetrics('v1', input, load);
    const second = await getVariantSpatialMetrics('v1', input, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('peek is a synchronous hit only when the fingerprint still matches', async () => {
    expect(peekVariantSpatialMetrics('v1', input)).toBeNull(); // nothing cached yet
    await getVariantSpatialMetrics('v1', input, fakeLoad);
    expect(peekVariantSpatialMetrics('v1', input)).not.toBeNull(); // now a hit

    // A stop move invalidates: same variant id, different fingerprint.
    const moved: SpatialInput = { stops: [{ ...stops[0], stop_lat: 46.02 }, stops[1]], routes, routeStops };
    expect(peekVariantSpatialMetrics('v1', moved)).toBeNull();
  });

  it('recomputes for the SAME variant id once its stop set changes (the active-variant case)', async () => {
    const load = vi.fn(fakeLoad);
    await getVariantSpatialMetrics('active', input, load);
    expect(load).toHaveBeenCalledTimes(1);

    // The active variant is edited (a stop moves) — same id, new fingerprint.
    const edited: SpatialInput = { stops: [{ ...stops[0], stop_lon: -111.004 }, stops[1]], routes, routeStops };
    await getVariantSpatialMetrics('active', edited, load);
    expect(load).toHaveBeenCalledTimes(2); // recomputed, not served stale
  });

  it('does not cache failures (a transient error can be retried)', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('network blip');
      return [SHARED, NEAR_A, FAR];
    };
    await expect(getVariantSpatialMetrics('v2', input, flaky)).rejects.toThrow('network blip');
    const ok = await getVariantSpatialMetrics('v2', input, flaky);
    expect(ok.population).toBe(150);
    expect(calls).toBe(2);
  });
});

/* ── delta math ── */

describe('spatialDelta', () => {
  it('is B − A on every field', async () => {
    const a = await computeSpatialMetrics(input, fakeLoad);
    const bInput: SpatialInput = { stops: [stops[0]], routes, routeStops: [routeStops[0]] };
    const b = await computeSpatialMetrics(bInput, fakeLoad);
    const d = spatialDelta(a, b);
    for (const k of Object.keys(a) as (keyof typeof a)[]) {
      expect(d[k]).toBeCloseTo(b[k] - a[k], 9);
    }
  });
});
