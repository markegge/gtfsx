// Pure-logic tests for travelTime.ts: the cumulative-duration projection of
// stops onto a matched path, and the dwell/speed-factor timing layout. The
// Map Matching fetch itself is not exercised here (it's a thin wrapper).
import { describe, expect, it } from 'vitest';
import { cumulativeTravelAtStops, layoutStopTimes } from '../travelTime';

describe('cumulativeTravelAtStops', () => {
  // A straight west→east path, 4 vertices / 3 equal segments of 60s each.
  const coords: [number, number][] = [[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]];
  const durations = [60, 60, 60];

  it('returns cumulative seconds at each stop sitting on a vertex', () => {
    const stops: [number, number][] = [[0, 0], [0.02, 0], [0.03, 0]];
    const cum = cumulativeTravelAtStops(coords, durations, stops);
    expect(cum[0]).toBeCloseTo(0, 1);
    expect(cum[1]).toBeCloseTo(120, 1);
    expect(cum[2]).toBeCloseTo(180, 1);
  });

  it('interpolates within a segment for a stop between vertices', () => {
    const cum = cumulativeTravelAtStops(coords, durations, [[0.015, 0]]);
    expect(cum[0]).toBeCloseTo(90, 0); // halfway through the middle segment
  });

  it('is monotonic non-decreasing in route order', () => {
    const stops: [number, number][] = [[0, 0], [0.01, 0], [0.025, 0], [0.03, 0]];
    const cum = cumulativeTravelAtStops(coords, durations, stops);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
  });
});

describe('layoutStopTimes', () => {
  const start = 8 * 3600; // 08:00:00

  it('first stop departs at start with no dwell; intermediate stops dwell; last has none', () => {
    const out = layoutStopTimes([0, 120, 180], { startSec: start, dwellSec: 18, speedFactor: 1 });
    expect(out[0]).toEqual({ arrivalSec: start, departureSec: start });
    // stop 1: +120s travel, then 18s dwell
    expect(out[1]).toEqual({ arrivalSec: start + 120, departureSec: start + 138 });
    // stop 2 (last): +60s travel from stop 1's departure, no trailing dwell
    expect(out[2]).toEqual({ arrivalSec: start + 198, departureSec: start + 198 });
  });

  it('scales travel by the speed factor (dwell is unaffected)', () => {
    const out = layoutStopTimes([0, 120, 180], { startSec: start, dwellSec: 18, speedFactor: 1.5 });
    expect(out[1].arrivalSec).toBe(start + 180);          // 120 * 1.5
    expect(out[1].departureSec).toBe(start + 180 + 18);   // + dwell
    expect(out[2].arrivalSec).toBe(start + 180 + 18 + 90); // 60 * 1.5 from departure
  });
});
