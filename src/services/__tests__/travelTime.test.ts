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

  it('a normal in-order set is unchanged/monotonic (each stop at its vertex)', () => {
    // Sequence follows the line west→east: expect the natural per-vertex times.
    const stops: [number, number][] = [[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]];
    const cum = cumulativeTravelAtStops(coords, durations, stops);
    expect(cum[0]).toBeCloseTo(0, 1);
    expect(cum[1]).toBeCloseTo(60, 1);
    expect(cum[2]).toBeCloseTo(120, 1);
    expect(cum[3]).toBeCloseTo(180, 1);
  });

  it('stops given out of GEOGRAPHIC order along the line still yield NON-DECREASING cumulative times in input order', () => {
    // Input sequence is east→west (against the line's drawn direction). Honoring
    // sequence order means each stop must land at/after the previous one, so the
    // cumulative times rise in INPUT order rather than tracking geography.
    const stops: [number, number][] = [[0.03, 0], [0.02, 0], [0.01, 0], [0, 0]];
    const cum = cumulativeTravelAtStops(coords, durations, stops);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
  });

  it('BZN-style: a stop near the line START but placed LAST gets a LATE (largest) time, not an early one', () => {
    // The 4th stop sits right at the line's start (like BZN Airport reordered to
    // the end). The old global-nearest projection gave it loc≈0 → an early time.
    // Forward-scanning must instead push it to >= its predecessors' location.
    const stops: [number, number][] = [
      [0.01, 0],  // 1st
      [0.02, 0],  // 2nd
      [0.03, 0],  // 3rd (end of line)
      [0, 0],     // 4th, but geographically at the START
    ];
    const cum = cumulativeTravelAtStops(coords, durations, stops);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
    // The reordered start-stop must end up with the largest cumulative time.
    expect(cum[3]).toBe(Math.max(...cum));
    expect(cum[3]).toBeGreaterThanOrEqual(cum[2]);
  });

  it('out-and-back line resolves a midpoint stop to the intended (later) pass', () => {
    // Line runs north out to an apex, then back south to the start. A midpoint
    // stop is geographically ambiguous (the line passes it twice). Sequenced
    // AFTER the apex stop, it must resolve to the INBOUND pass (a late time),
    // not the outbound pass (which would precede the apex and break order).
    const oab: [number, number][] = [
      [0, 0], [0, 0.005], [0, 0.01], [0, 0.015], [0, 0.02],
      [0, 0.015], [0, 0.01], [0, 0.005], [0, 0],
    ];
    const oabDur = [60, 60, 60, 60, 60, 60, 60, 60]; // 8 segments, 480s total
    const stops: [number, number][] = [
      [0, 0],      // start
      [0, 0.02],   // apex (turnaround) ≈ 240s in
      [0, 0.0075], // midpoint, sequenced on the way back
    ];
    const cum = cumulativeTravelAtStops(oab, oabDur, stops);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThanOrEqual(cum[i - 1]);
    expect(cum[1]).toBeCloseTo(240, 0);     // apex near the temporal middle
    expect(cum[2]).toBeGreaterThan(cum[1]); // resolved to the inbound pass, after the apex
    expect(cum[2]).toBeGreaterThan(300);    // clearly the inbound (≈390s), not outbound (≈90s)
  });

  it('clamps to the running location when a late stop only projects before it', () => {
    // A stop physically before the running min has no forward projection except
    // the clamp; its time must equal (not precede) the prior stop's.
    const cum = cumulativeTravelAtStops(coords, durations, [[0.03, 0], [0, 0]]);
    expect(cum[0]).toBeCloseTo(180, 1);
    expect(cum[1]).toBeGreaterThanOrEqual(cum[0]);
    expect(cum[1]).toBeCloseTo(180, 1); // clamped to the end (running min), not pulled back to 0
  });

  it('guards a degenerate shape (fewer than 2 points)', () => {
    expect(cumulativeTravelAtStops([[0, 0]], [], [[0, 0], [0.01, 0]])).toEqual([0, 0]);
    expect(cumulativeTravelAtStops(coords, durations, [])).toEqual([]);
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

  it('handles stops running opposite the shape (decreasing cumulative)', () => {
    // Stops sequenced against the shape's drawn direction → cumulative runs
    // high→low. Travel must still be real, not collapse to zero.
    const out = layoutStopTimes([180, 120, 0], { startSec: start, dwellSec: 18, speedFactor: 1 });
    expect(out[1]).toEqual({ arrivalSec: start + 60, departureSec: start + 78 });
    expect(out[2]).toEqual({ arrivalSec: start + 78 + 120, departureSec: start + 78 + 120 });
  });
});
