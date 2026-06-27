import { describe, expect, it } from 'vitest';
import type { Feature, Polygon } from 'geojson';
import type { Stop } from '../../types/gtfs';
import {
  regionForState,
  isInUS,
  bboxFromStops,
  unionWalkshedPolygons,
  tabulateBlocks,
  type BlockPoint,
} from '../blockCoverage';

/** A synthetic census block point. Defaults to all-zero attributes; override
 *  the ones a test cares about. */
function blk(geoid: string, lon: number, lat: number, attrs: Partial<BlockPoint> = {}): BlockPoint {
  return {
    geoid, lon, lat,
    pop: 0, hh: 0, workers: 0, riders: 0,
    minority: 0, race_pop: 0, lowinc: 0, pov_univ: 0,
    zeroveh_hh: 0, occ_hh: 0, senior: 0, youth: 0, jobs: 0,
    ...attrs,
  };
}

/** Axis-aligned square polygon centred on (lon, lat) with half-width `half` deg. */
function square(lon: number, lat: number, half: number): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lon - half, lat - half],
        [lon + half, lat - half],
        [lon + half, lat + half],
        [lon - half, lat + half],
        [lon - half, lat - half],
      ]],
    },
  };
}

function stop(id: string, lon: number, lat: number): Stop {
  return { stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0 };
}

describe('regionForState / isInUS', () => {
  it('maps the 50 states + DC to the us block region, territories/unknown to null', () => {
    expect(regionForState('30')).toBe('us'); // Montana
    expect(regionForState('06')).toBe('us'); // California
    expect(regionForState('11')).toBe('us'); // DC
    expect(regionForState('72')).toBeNull(); // Puerto Rico (territory, not in us.fgb)
    expect(regionForState('99')).toBeNull(); // unknown
  });

  it('bounds-checks US coordinates (CONUS + AK + HI)', () => {
    expect(isInUS(46.6, -111.9)).toBe(true); // Helena, MT
    expect(isInUS(37.8, -122.2)).toBe(true); // Oakland, CA
    expect(isInUS(61.2, -149.9)).toBe(true); // Anchorage, AK
    expect(isInUS(21.3, -157.8)).toBe(true); // Honolulu, HI
    expect(isInUS(51.5, -0.13)).toBe(false); // London
  });
});

describe('bboxFromStops', () => {
  it('returns a padded bbox covering all stops', () => {
    const bbox = bboxFromStops([stop('a', -112, 46), stop('b', -111, 47)], 0.02);
    expect(bbox).not.toBeNull();
    expect(bbox!.minX).toBeCloseTo(-112.02, 6);
    expect(bbox!.maxX).toBeCloseTo(-110.98, 6);
    expect(bbox!.minY).toBeCloseTo(45.98, 6);
    expect(bbox!.maxY).toBeCloseTo(47.02, 6);
  });

  it('returns null for an empty stop set', () => {
    expect(bboxFromStops([])).toBeNull();
  });
});

describe('tabulateBlocks', () => {
  // A 0.1°-half-width square centred on (-111, 46): contains the two "inside"
  // blocks, excludes the far one.
  const walkshed = square(-111, 46, 0.1);

  const blocks = [
    blk('A', -111.0, 46.0, { pop: 100, hh: 40, workers: 50, riders: 30, minority: 20, race_pop: 100, jobs: 10 }),
    blk('B', -110.95, 46.05, { pop: 50, hh: 20, workers: 25, riders: 15, minority: 5, race_pop: 50, jobs: 200 }),
    blk('C', -110.0, 46.0, { pop: 9999, hh: 9999, workers: 9999, riders: 9999, minority: 9999, race_pop: 9999, jobs: 9999 }),
  ];

  it('sums attributes only for blocks whose centroid is inside the walkshed', () => {
    const r = tabulateBlocks(blocks, walkshed);
    expect(r.blocksCovered).toBe(2);
    expect(r.blocksTotal).toBe(3);
    expect(r.coveredBlockGroupIds.sort()).toEqual(['A', 'B']);
    expect(r.totalPopulation).toBe(150);
    expect(r.totalHouseholds).toBe(60);
    expect(r.totalWorkers).toBe(75);
    expect(r.totalHighPropensityRiders).toBe(45);
    expect(r.minorityPop).toBe(25);
    expect(r.totalRacePop).toBe(150);
    expect(r.totalJobs).toBe(210); // includes B's job-heavy block
  });

  it('counts a block once under union semantics across overlapping walksheds', () => {
    // Two overlapping squares; block A sits in the overlap, B in only one.
    const s1 = square(-111.0, 46.0, 0.08);
    const s2 = square(-110.95, 46.05, 0.08);
    const unioned = unionWalkshedPolygons([s1, s2]);
    expect(unioned).not.toBeNull();
    const r = tabulateBlocks(blocks, unioned);
    expect(r.blocksCovered).toBe(2); // A counted once despite being in both
    expect(r.totalPopulation).toBe(150);
    expect(r.totalJobs).toBe(210);
  });

  it('falls back to per-feature OR testing when no union polygon is available', () => {
    const s1 = square(-111.0, 46.0, 0.03); // contains A only
    const s2 = square(-110.95, 46.05, 0.03); // contains B only
    const r = tabulateBlocks(blocks, null, [s1, s2]);
    expect(r.blocksCovered).toBe(2);
    expect(r.totalPopulation).toBe(150);
  });

  it('returns zeroed totals when nothing is inside', () => {
    const empty = square(0, 0, 0.01);
    const r = tabulateBlocks(blocks, empty);
    expect(r.blocksCovered).toBe(0);
    expect(r.totalPopulation).toBe(0);
    expect(r.totalJobs).toBe(0);
  });
});
