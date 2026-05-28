import { describe, it, expect } from 'vitest';
import type { Stop } from '../../types/gtfs';
import type { BlockGroupData } from '../demographics';
import {
  circleOverlapFraction,
  calculateCoverage,
  coverageFromFractions,
  demographicShares,
  baselineShares,
  BG_RADIUS_MILES,
} from '../coverageAnalysis';

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
function stop(id: string, lat: number, lon: number): Stop {
  return { stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0 };
}

describe('circleOverlapFraction', () => {
  it('is 0 when the circles do not touch', () => {
    expect(circleOverlapFraction(10, 0.25, 0.5)).toBe(0);
  });
  it('is 1 when the block group is fully inside the buffer', () => {
    // d + bgRadius <= buffer
    expect(circleOverlapFraction(0, 1.0, 0.5)).toBe(1);
  });
  it('is (buffer/bgRadius)^2 when a small buffer sits at the BG center', () => {
    // d = 0, buffer < bgRadius
    expect(circleOverlapFraction(0, 0.25, 0.5)).toBeCloseTo((0.25 / 0.5) ** 2, 6);
  });
  it('decreases monotonically as the centers separate', () => {
    const near = circleOverlapFraction(0.1, 0.5, BG_RADIUS_MILES);
    const far = circleOverlapFraction(0.6, 0.5, BG_RADIUS_MILES);
    expect(near).toBeGreaterThan(far);
  });
});

describe('calculateCoverage', () => {
  it('recovers a block group fully covered by a stop buffer', () => {
    const stops = [stop('s', 40, -100)];
    const bgs = [bg('g1', 40, -100, { population: 1000, households: 400, workers: 600 })];
    // 0.5 mi buffer with the BG centered on the stop and bgRadius 0.5 → fraction 1.
    const r = calculateCoverage(stops, bgs, 0.5);
    expect(r.totalPopulation).toBe(1000);
    expect(r.totalHouseholds).toBe(400);
    expect(r.totalWorkers).toBe(600);
  });

  it('excludes a block group far outside any buffer', () => {
    const stops = [stop('s', 40, -100)];
    const bgs = [bg('far', 41, -100, { population: 999 })];
    const r = calculateCoverage(stops, bgs, 0.25);
    expect(r.totalPopulation).toBe(0);
    expect(r.coveredBlockGroupIds).toHaveLength(0);
  });

  it('apportions counts by the overlap fraction', () => {
    // buffer 0.25 mi at the BG center (radius 0.5) → fraction (0.25/0.5)^2 = 0.25.
    const stops = [stop('s', 40, -100)];
    const bgs = [bg('g', 40, -100, { population: 1000, lowIncomePop: 400, povertyUniverse: 1000 })];
    const r = calculateCoverage(stops, bgs, 0.25);
    expect(r.totalPopulation).toBe(250);          // 1000 × 0.25
    expect(r.lowIncomePop).toBe(100);             // 400 × 0.25
    expect(r.povertyUniverse).toBe(250);          // 1000 × 0.25
    // share is invariant to the apportionment fraction (num & denom scale together)
    expect(demographicShares(r).lowIncome).toBeCloseTo(0.4, 6);
  });
});

describe('demographicShares & baselineShares', () => {
  const bgs = [
    bg('a', 40, -100, {
      totalRacePop: 100, minorityPop: 40,
      povertyUniverse: 100, lowIncomePop: 25,
      occupiedHouseholds: 50, zeroVehicleHouseholds: 10,
      population: 100, seniorPop: 20, youthPop: 30,
    }),
    bg('b', 40, -100, {
      totalRacePop: 100, minorityPop: 60,
      povertyUniverse: 100, lowIncomePop: 75,
      occupiedHouseholds: 50, zeroVehicleHouseholds: 30,
      population: 100, seniorPop: 10, youthPop: 10,
    }),
  ];

  it('computes county baseline shares from unweighted sums', () => {
    const b = baselineShares(bgs);
    expect(b.minority).toBeCloseTo(0.5, 6);      // (40+60)/(100+100)
    expect(b.lowIncome).toBeCloseTo(0.5, 6);     // (25+75)/200
    expect(b.zeroVehicle).toBeCloseTo(0.4, 6);   // (10+30)/100
    expect(b.senior).toBeCloseTo(0.15, 6);       // (20+10)/200
    expect(b.youth).toBeCloseTo(0.2, 6);         // (30+10)/200
  });

  it('returns null shares when denominators are zero', () => {
    const b = baselineShares([bg('z', 40, -100)]);
    expect(b.minority).toBeNull();
    expect(b.lowIncome).toBeNull();
  });

  it('coverageFromFractions sums apportioned numerators and denominators', () => {
    const fractions = new Map([['a', 1], ['b', 0.5]]);
    const r = coverageFromFractions(fractions, bgs, 0.25);
    // minority = 40×1 + 60×0.5 = 70 ; race = 100 + 50 = 150
    expect(r.minorityPop).toBe(70);
    expect(r.totalRacePop).toBe(150);
    expect(demographicShares(r).minority).toBeCloseTo(70 / 150, 6);
  });
});
