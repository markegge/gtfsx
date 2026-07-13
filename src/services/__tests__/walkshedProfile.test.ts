import { describe, expect, it } from 'vitest';
import type { Route, RouteStop, Stop } from '../../types/gtfs';
import type { BlockPoint } from '../blockCoverage';
import { tabulateBlocks, unionWalkshedPolygons } from '../blockCoverage';
import buffer from '@turf/buffer';
import { point as turfPoint } from '@turf/helpers';
import type { Feature } from 'geojson';
import {
  PROFILE_CATEGORIES,
  MISSING_CATEGORIES,
  analyzeWalkshedProfiles,
  buildBlockIndex,
  bufferMilesForRouteType,
  bufferMilesForStop,
  blocksWithin,
  categoryShare,
  profileFromBlocks,
  routeProfile,
  stopProfile,
  stopsOnRoute,
  unionProfile,
  DEFAULT_BUFFER_MILES,
  RAIL_BUFFER_MILES,
  type WalkshedProfile,
} from '../walkshedProfile';

/* ── fixtures ── */

function blk(geoid: string, lon: number, lat: number, attrs: Partial<BlockPoint> = {}): BlockPoint {
  return {
    geoid, lon, lat,
    pop: 0, hh: 0, workers: 0, riders: 0,
    minority: 0, race_pop: 0, lowinc: 0, pov_univ: 0,
    zeroveh_hh: 0, occ_hh: 0, senior: 0, youth: 0, jobs: 0,
    ...attrs,
  };
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

/** A fully-populated block so every category has a non-zero value. */
function richBlock(geoid: string, lon: number, lat: number, scale = 1): BlockPoint {
  return blk(geoid, lon, lat, {
    pop: 100 * scale,
    hh: 40 * scale,
    workers: 55 * scale,
    riders: 30 * scale,
    minority: 25 * scale,
    race_pop: 100 * scale,
    lowinc: 35 * scale,
    pov_univ: 95 * scale,
    zeroveh_hh: 8 * scale,
    occ_hh: 40 * scale,
    senior: 15 * scale,
    youth: 20 * scale,
    jobs: 60 * scale,
  });
}

/* ── buffer rules (mirrors getBufferForRoute) ── */

describe('walk buffers', () => {
  it('gives light rail / tram (route_type 0) a 1/2 mi walkshed and everything else 1/4 mi', () => {
    expect(bufferMilesForRouteType(0)).toBe(RAIL_BUFFER_MILES);
    expect(bufferMilesForRouteType(0)).toBe(0.5);
    expect(bufferMilesForRouteType(3)).toBe(DEFAULT_BUFFER_MILES);
    expect(bufferMilesForRouteType(3)).toBe(0.25);
    expect(bufferMilesForRouteType(2)).toBe(0.25); // heavy rail is NOT tram
    expect(bufferMilesForRouteType(undefined)).toBe(0.25);
  });

  it('gives a stop the 1/2 mi walkshed when ANY route serving it is a tram', () => {
    const routes = [route('bus', 3), route('tram', 0)];
    const routeStops = [rs('bus', 's1', 1), rs('bus', 's2', 2), rs('tram', 's2', 1)];
    expect(bufferMilesForStop('s1', routeStops, routes)).toBe(0.25);
    expect(bufferMilesForStop('s2', routeStops, routes)).toBe(0.5); // shared with the tram
    expect(bufferMilesForStop('unserved', routeStops, routes)).toBe(0.25);
  });

  it('reads route membership straight off the denormalized routeStops table', () => {
    const stops = [stop('s1', -111, 46), stop('s2', -111.01, 46), stop('s3', -111.02, 46)];
    const routeStops = [rs('r1', 's1', 1), rs('r1', 's3', 2)];
    expect(stopsOnRoute('r1', routeStops, stops).map((s) => s.stop_id)).toEqual(['s1', 's3']);
    expect(stopsOnRoute('nope', routeStops, stops)).toEqual([]);
  });
});

/* ── the union property: THE correctness requirement ── */

describe('route aggregation is a UNION, never a sum', () => {
  // Two stops ~0.15 mi apart. At a 0.25 mi buffer their walksheds overlap, and
  // the shared block sits inside BOTH. A third block is near only one stop.
  const shared = richBlock('SHARED', -111.0, 46.0);          // between the two stops
  const nearA  = richBlock('NEAR_A', -111.006, 46.0, 0.5);   // ~0.29 mi W — only stop A
  const far    = richBlock('FAR', -110.9, 46.0, 10);         // ~4.8 mi away — neither

  const blocks = [shared, nearA, far];
  const index = buildBlockIndex(blocks);

  const stopA = stop('A', -111.003, 46.0);
  const stopB = stop('B', -110.997, 46.0);

  it('places the shared block in BOTH stops’ walksheds (the setup this test relies on)', () => {
    const a = blocksWithin(index, stopA.stop_lon, stopA.stop_lat, 0.25).map((b) => b.geoid);
    const b = blocksWithin(index, stopB.stop_lon, stopB.stop_lat, 0.25).map((b) => b.geoid);
    expect(a).toContain('SHARED');
    expect(b).toContain('SHARED');
    expect(a).toContain('NEAR_A');
    expect(b).not.toContain('NEAR_A');
    expect(a).not.toContain('FAR');
  });

  it('counts a shared block ONCE for the route, not once per nearby stop', () => {
    const pA = stopProfile(index, stopA, 0.25);
    const pB = stopProfile(index, stopB, 0.25);
    const union = unionProfile(index, [stopA, stopB], 0.25);

    // Per-stop: A sees SHARED + NEAR_A (100 + 50), B sees SHARED only (100).
    expect(pA.counts.population).toBe(150);
    expect(pB.counts.population).toBe(100);

    // Naively summing the stops double-counts SHARED's 100 residents.
    const naiveSum = pA.counts.population + pB.counts.population;
    expect(naiveSum).toBe(250);

    // The union counts SHARED exactly once: 100 + 50 = 150, NOT 250.
    expect(union.counts.population).toBe(150);
    expect(union.counts.population).toBeLessThan(naiveSum);
    expect(union.blocksCounted).toBe(2); // SHARED + NEAR_A, never SHARED twice
  });

  it('holds the union property for EVERY category, not just population', () => {
    const pA = stopProfile(index, stopA, 0.25);
    const pB = stopProfile(index, stopB, 0.25);
    const union = unionProfile(index, [stopA, stopB], 0.25);

    // The expected union = SHARED (scale 1) + NEAR_A (scale 0.5), each once.
    const expected = profileFromBlocks([shared, nearA], 0.25, 2);

    for (const cat of PROFILE_CATEGORIES) {
      const naive = pA.counts[cat.key] + pB.counts[cat.key];
      expect(union.counts[cat.key]).toBe(expected.counts[cat.key]);
      // Every category the shared block contributes to must be strictly below
      // the naive sum — that difference IS the double-count we are removing.
      if (shared[({
        population: 'pop', households: 'hh', workers: 'workers', minority: 'minority',
        lowIncome: 'lowinc', zeroVehicleHouseholds: 'zeroveh_hh', seniors: 'senior',
        youth: 'youth', jobs: 'jobs', highPropensityRiders: 'riders',
      } as const)[cat.key]] > 0) {
        expect(union.counts[cat.key]).toBeLessThan(naive);
      }
    }
    // Denominators must be unioned too, or the shares would be wrong.
    expect(union.universes.raceUniverse).toBe(expected.universes.raceUniverse);
    expect(union.universes.occupiedHouseholds).toBe(expected.universes.occupiedHouseholds);
    expect(union.universes.povertyUniverse).toBe(expected.universes.povertyUniverse);
  });

  it('routeProfile unions all the route’s stops at the route’s own buffer', () => {
    const stops = [stopA, stopB];
    const routeStops = [rs('r1', 'A', 1), rs('r1', 'B', 2)];
    const p = routeProfile(index, route('r1', 3), routeStops, stops);
    expect(p.bufferMiles).toBe(0.25);
    expect(p.stopCount).toBe(2);
    expect(p.counts.population).toBe(150); // union, not 250
    expect(p.counts.jobs).toBe(60 + 30);   // SHARED 60 + NEAR_A 30, each once
  });

  it('profileFromBlocks dedupes by geoid even when handed the same block twice', () => {
    // The defensive half of the guarantee: a caller that concatenates two
    // overlapping walksheds’ block lists still gets each block counted once.
    const doubled = profileFromBlocks([shared, nearA, shared, shared], 0.25, 2);
    const once = profileFromBlocks([shared, nearA], 0.25, 2);
    expect(doubled.counts).toEqual(once.counts);
    expect(doubled.universes).toEqual(once.universes);
    expect(doubled.blocksCounted).toBe(2);
  });

  it('a stop on 10 routes is still one block set — union scales with stops, not with route membership', () => {
    // Adding the same stop many times (as a multi-route stop would) must not
    // inflate anything.
    const many = unionProfile(index, [stopA, stopA, stopA, stopB, stopB], 0.25);
    expect(many.counts.population).toBe(150);
    expect(many.blocksCounted).toBe(2);
  });
});

/* ── the existing tabulateBlocks also has union semantics ── */

describe('blockCoverage.tabulateBlocks union semantics (the shared primitive)', () => {
  it('counts a block once when two overlapping stop buffers both contain it', () => {
    const shared = richBlock('SHARED', -111.0, 46.0);
    const blocks = [shared];
    const bufA = buffer(turfPoint([-111.003, 46.0]), 0.25, { units: 'miles' }) as Feature;
    const bufB = buffer(turfPoint([-110.997, 46.0]), 0.25, { units: 'miles' }) as Feature;

    // Union-polygon path.
    const poly = unionWalkshedPolygons([bufA, bufB]);
    const viaUnion = tabulateBlocks(blocks, poly);
    expect(viaUnion.blocksCovered).toBe(1);
    expect(viaUnion.totalPopulation).toBe(100); // ONCE, not 200

    // Per-feature OR path (used when the polygons can't be unioned).
    const viaFeatures = tabulateBlocks(blocks, null, [bufA, bufB]);
    expect(viaFeatures.blocksCovered).toBe(1);
    expect(viaFeatures.totalPopulation).toBe(100);
  });
});

/* ── overlapping categories must never be summed ── */

describe('categories overlap and are never totalled', () => {
  it('exposes no total, and the categories provably overlap (their sum exceeds the population)', () => {
    // One block where every resident is low-income, senior-heavy, etc. The
    // category counts legitimately sum to MORE than the population — which is
    // exactly why summing them is forbidden.
    const b = blk('X', -111, 46, {
      pop: 100, hh: 40, workers: 55, riders: 60,
      minority: 90, race_pop: 100, lowinc: 80, pov_univ: 100,
      zeroveh_hh: 30, occ_hh: 40, senior: 25, youth: 30, jobs: 10,
    });
    const p = profileFromBlocks([b], 0.25, 1);

    const residenceSum = PROFILE_CATEGORIES
      .filter((c) => c.basis === 'residence' && c.key !== 'population' && c.key !== 'households')
      .reduce((a, c) => a + p.counts[c.key], 0);

    // workers 55 + minority 90 + low-income 80 + zero-veh HH 30 + 65+ 25 +
    // under-18 30 + high-propensity 60 = 370 "people" inside a 100-person block.
    // The groups are not disjoint; any UI that adds them is lying.
    expect(residenceSum).toBe(370);
    expect(residenceSum).toBeGreaterThan(p.counts.population);

    // The profile itself exposes no `total` of any kind — there is nothing to
    // accidentally render.
    expect(Object.keys(p)).toEqual(
      expect.not.arrayContaining(['total', 'totalPeople', 'totalServed', 'predictedRiders']),
    );
  });

  it('labels exactly one category an estimate (the composite) and the rest straight counts', () => {
    const estimates = PROFILE_CATEGORIES.filter((c) => c.kind === 'estimate');
    expect(estimates.map((c) => c.key)).toEqual(['highPropensityRiders']);
    // Everything else is an exact tabulation and must be labelled as such.
    for (const c of PROFILE_CATEGORIES) {
      if (c.key !== 'highPropensityRiders') expect(c.kind).toBe('count');
    }
  });

  it('keeps jobs on a separate (workplace) basis from every residence-based category', () => {
    const workplace = PROFILE_CATEGORIES.filter((c) => c.basis === 'workplace');
    expect(workplace.map((c) => c.key)).toEqual(['jobs']);
  });

  it('computes a share against the category’s OWN universe, never against a mixed denominator', () => {
    const p = profileFromBlocks(
      [blk('X', -111, 46, {
        pop: 200, minority: 50, race_pop: 200, lowinc: 30, pov_univ: 150,
        zeroveh_hh: 10, occ_hh: 80, senior: 20, youth: 40, jobs: 500,
      })],
      0.25, 1,
    );
    const byKey = Object.fromEntries(PROFILE_CATEGORIES.map((c) => [c.key, c]));
    expect(categoryShare(p, byKey.minority)).toBeCloseTo(50 / 200, 9);      // of race universe
    expect(categoryShare(p, byKey.lowIncome)).toBeCloseTo(30 / 150, 9);     // of poverty universe
    expect(categoryShare(p, byKey.zeroVehicleHouseholds)).toBeCloseTo(10 / 80, 9); // of occupied HH
    expect(categoryShare(p, byKey.seniors)).toBeCloseTo(20 / 200, 9);       // of population
    // Jobs has no residence universe — it must render as "—", never as a % of
    // population (that would divide a workplace count by a residence count).
    expect(categoryShare(p, byKey.jobs)).toBeNull();
  });

  it('returns null (not 0%) for a share whose denominator is empty', () => {
    const p = profileFromBlocks([blk('X', -111, 46, { pop: 0 })], 0.25, 1);
    const byKey = Object.fromEntries(PROFILE_CATEGORIES.map((c) => [c.key, c]));
    expect(categoryShare(p, byKey.minority)).toBeNull();
    expect(categoryShare(p, byKey.seniors)).toBeNull();
  });

  it('documents the renter / age-18-24 gap instead of fabricating those categories', () => {
    const keys = PROFILE_CATEGORIES.map((c) => c.key) as string[];
    expect(keys).not.toContain('renters');
    expect(keys).not.toContain('adults18to24');
    expect(MISSING_CATEGORIES.map((m) => m.field)).toEqual(['renter', 'age_18_24']);
  });
});

/* ── spatial index ── */

describe('buildBlockIndex / blocksWithin', () => {
  const blocks = [
    blk('IN', -111.0, 46.0, { pop: 1 }),
    blk('EDGE_OUT', -111.0, 46.0 + 0.26 / 69, { pop: 1 }),   // ~0.26 mi N — outside 0.25
    blk('EDGE_IN', -111.0, 46.0 + 0.20 / 69, { pop: 1 }),    // ~0.20 mi N — inside 0.25
    blk('FAR', -110.0, 46.0, { pop: 1 }),
  ];
  const index = buildBlockIndex(blocks);

  it('finds exactly the blocks inside the radius, across grid-cell boundaries', () => {
    const got = blocksWithin(index, -111.0, 46.0, 0.25).map((b) => b.geoid).sort();
    expect(got).toEqual(['EDGE_IN', 'IN']);
  });

  it('agrees with a brute-force scan (the grid is only a candidate filter)', () => {
    // A stop deliberately placed on a cell boundary (-111.0 is a multiple of the
    // 0.01° cell size) — the classic place a grid index drops neighbours.
    const brute = blocks.filter((b) => {
      const dLat = (b.lat - 46.0) * 69;
      const dLon = (b.lon + 111.0) * 69 * Math.cos((46 * Math.PI) / 180);
      return Math.sqrt(dLat * dLat + dLon * dLon) <= 0.25;
    });
    const viaIndex = blocksWithin(index, -111.0, 46.0, 0.25);
    expect(viaIndex.map((b) => b.geoid).sort()).toEqual(brute.map((b) => b.geoid).sort());
  });

  it('returns nothing when the radius reaches no blocks', () => {
    expect(blocksWithin(index, -100, 40, 0.25)).toEqual([]);
  });
});

/* ── the feed-wide run ── */

describe('analyzeWalkshedProfiles', () => {
  const shared = richBlock('SHARED', -111.0, 46.0);
  const nearA = richBlock('NEAR_A', -111.006, 46.0, 0.5);
  const onR2 = richBlock('ON_R2', -111.5, 46.0, 2);

  const stops = [stop('A', -111.003, 46.0), stop('B', -110.997, 46.0), stop('C', -111.5, 46.0)];
  const routes = [route('r1', 3), route('r2', 0)];
  const routeStops = [rs('r1', 'A', 1), rs('r1', 'B', 2), rs('r2', 'C', 1)];

  async function run() {
    let calls = 0;
    const result = await analyzeWalkshedProfiles({ stops, routes, routeStops }, async () => {
      calls++;
      return [shared, nearA, onR2];
    });
    return { result, calls };
  }

  it('fetches the block layer EXACTLY ONCE for the whole feed (never once per stop)', async () => {
    const { calls } = await run();
    expect(calls).toBe(1);
  });

  it('profiles every stop and every route from the one in-memory block set', async () => {
    const { result } = await run();
    expect(Object.keys(result.byStop).sort()).toEqual(['A', 'B', 'C']);
    expect(Object.keys(result.byRoute).sort()).toEqual(['r1', 'r2']);
    expect(result.blocksLoaded).toBe(3);
  });

  it('gives r1 (bus) the union of A+B at 1/4 mi and r2 (tram) 1/2 mi', async () => {
    const { result } = await run();
    expect(result.byRoute.r1.bufferMiles).toBe(0.25);
    expect(result.byRoute.r1.counts.population).toBe(150); // union, not 250
    expect(result.byRoute.r2.bufferMiles).toBe(0.5);
    expect(result.byRoute.r2.counts.population).toBe(200); // ON_R2 at scale 2
    // Stop C is on a tram route, so its own walkshed is 1/2 mi too.
    expect(result.byStop.C.bufferMiles).toBe(0.5);
  });

  it('unions the system across routes — the system is not the sum of the routes', async () => {
    const { result } = await run();
    const routeSum = result.byRoute.r1.counts.population + result.byRoute.r2.counts.population;
    // Here the routes happen to be disjoint, so system == routeSum; the point is
    // that the system is computed by unioning blocks, so it can only ever be <=.
    expect(result.system.counts.population).toBeLessThanOrEqual(routeSum);
    expect(result.system.counts.population).toBe(350); // SHARED 100 + NEAR_A 50 + ON_R2 200
    expect(result.system.blocksCounted).toBe(3);
  });

  it('refuses a feed outside the block layer’s region rather than silently switching method', async () => {
    await expect(
      analyzeWalkshedProfiles(
        { stops: [stop('L', -0.13, 51.5)], routes: [], routeStops: [] }, // London
        async () => [],
      ),
    ).rejects.toThrow(/United States/);
  });

  it('refuses an empty stop set', async () => {
    await expect(
      analyzeWalkshedProfiles({ stops: [], routes: [], routeStops: [] }, async () => []),
    ).rejects.toThrow(/No stops/);
  });
});

/* ── nothing here forecasts ridership ── */

describe('no ridership model', () => {
  it('exposes no predicted-boardings field anywhere on a profile', () => {
    const p: WalkshedProfile = profileFromBlocks([richBlock('X', -111, 46)], 0.25, 1);
    const keys = [...Object.keys(p), ...Object.keys(p.counts)];
    for (const banned of ['boardings', 'ridership', 'predicted', 'forecast', 'elasticity', 'coefficient']) {
      expect(keys.some((k) => k.toLowerCase().includes(banned))).toBe(false);
    }
  });

  it('carries the high-propensity composite straight through from the block layer, unmodified', () => {
    // We do not re-weight, scale, or "improve" the upstream composite — it is
    // reported as-is and labelled an estimate. Anything else would be modelling.
    const b = richBlock('X', -111, 46); // riders: 30
    const p = profileFromBlocks([b], 0.25, 1);
    expect(p.counts.highPropensityRiders).toBe(30);
  });
});
