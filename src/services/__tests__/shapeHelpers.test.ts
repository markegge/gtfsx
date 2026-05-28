import { describe, expect, it } from 'vitest';
import type { Shape, ShapePoint } from '../../types/gtfs';
import {
  duplicateShapePoints,
  nearestVertexIndex,
  trimShapeAtIndex,
  trimShapeAtPoint,
} from '../shapeHelpers';

// Make a simple straight-line shape in (0,0)→(0.001,0.001) hops so the math
// is easy to eyeball. Sequence + dist are seeded distinctively so we can
// assert the helpers preserve / renumber the right fields.
function makePoints(n: number): ShapePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    shape_pt_lat: i * 0.001,
    shape_pt_lon: i * 0.001,
    shape_pt_sequence: 100 + i, // intentionally non-zero-based
    shape_dist_traveled: i * 50, // 50 m / vertex
  }));
}

describe('duplicateShapePoints', () => {
  it('returns a deep copy with renumbered sequence starting at 0', () => {
    const src = makePoints(4);
    const dup = duplicateShapePoints(src);
    expect(dup.length).toBe(4);
    expect(dup.map((p) => p.shape_pt_sequence)).toEqual([0, 1, 2, 3]);
    // Same lat/lon — clone is geometrically identical.
    expect(dup[2].shape_pt_lat).toBe(0.002);
    expect(dup[2].shape_pt_lon).toBe(0.002);
  });

  it('preserves shape_dist_traveled so the clone reads identically without a recalc', () => {
    const src = makePoints(3);
    const dup = duplicateShapePoints(src);
    expect(dup.map((p) => p.shape_dist_traveled)).toEqual([0, 50, 100]);
  });

  it('produces an independent array — mutating the clone does not touch the source', () => {
    const src = makePoints(2);
    const dup = duplicateShapePoints(src);
    dup[0].shape_pt_lat = 99;
    expect(src[0].shape_pt_lat).toBe(0);
  });
});

describe('nearestVertexIndex', () => {
  it('returns the index of the closest vertex by flat-plane distance', () => {
    const pts = makePoints(5);
    expect(nearestVertexIndex(pts, 0.0021, 0.0021)).toBe(2);
    expect(nearestVertexIndex(pts, 0.004, 0.004)).toBe(4);
  });

  it('returns -1 on empty input (caller defends against degenerate shapes)', () => {
    expect(nearestVertexIndex([], 0, 0)).toBe(-1);
  });
});

describe('trimShapeAtIndex', () => {
  it("side='end' drops everything after the cut and includes the cut vertex", () => {
    const pts = makePoints(5);
    const trimmed = trimShapeAtIndex(pts, 'end', 2);
    expect(trimmed.length).toBe(3);
    expect(trimmed[trimmed.length - 1].shape_pt_lat).toBeCloseTo(0.002);
  });

  it("side='start' drops everything before the cut and includes the cut vertex", () => {
    const pts = makePoints(5);
    const trimmed = trimShapeAtIndex(pts, 'start', 2);
    expect(trimmed.length).toBe(3);
    expect(trimmed[0].shape_pt_lat).toBeCloseTo(0.002);
  });

  it('renumbers shape_pt_sequence from 0 in the trimmed output', () => {
    const pts = makePoints(6);
    const trimmed = trimShapeAtIndex(pts, 'start', 3);
    expect(trimmed.map((p) => p.shape_pt_sequence)).toEqual([0, 1, 2]);
  });

  it('refuses to trim if the result would be < 2 points (returns source unchanged)', () => {
    const pts = makePoints(3);
    // side='end' at index 0 → 1 point left; reject.
    expect(trimShapeAtIndex(pts, 'end', 0)).toBe(pts);
    // side='start' at last index → 1 point left; reject.
    expect(trimShapeAtIndex(pts, 'start', pts.length - 1)).toBe(pts);
  });

  it('refuses with out-of-range indices', () => {
    const pts = makePoints(3);
    expect(trimShapeAtIndex(pts, 'end', -1)).toBe(pts);
    expect(trimShapeAtIndex(pts, 'end', 99)).toBe(pts);
  });

  it('returns source unchanged when the shape itself has < 2 points', () => {
    const pts: ShapePoint[] = [makePoints(1)[0]];
    expect(trimShapeAtIndex(pts, 'end', 0)).toBe(pts);
  });
});

describe('trimShapeAtPoint', () => {
  it('snaps the click to the nearest vertex and applies the trim', () => {
    const shape: Shape = { shape_id: 'sh1', points: makePoints(5) };
    // Click at (0.0029, 0.0031) — closest vertex is index 3.
    const trimmed = trimShapeAtPoint(shape, 'end', 0.0029, 0.0031);
    expect(trimmed.length).toBe(4);
    expect(trimmed[trimmed.length - 1].shape_pt_lat).toBeCloseTo(0.003);
  });

  it("returns the original points on a no-op (would-be-degenerate) trim", () => {
    const shape: Shape = { shape_id: 'sh1', points: makePoints(2) };
    // Click closest to index 0; side='end' would leave 1 point → reject.
    const trimmed = trimShapeAtPoint(shape, 'end', -0.001, -0.001);
    expect(trimmed).toBe(shape.points);
  });
});

// End-to-end-ish scenarios — these don't render React but do compose the
// helpers in the same order the Routes Shapes subpanel does, so a future
// refactor that breaks "duplicate then trim" gets caught in CI.
describe('compose: duplicate then trim (the common Mark-flow)', () => {
  it('clones a shape, trims its tail, and leaves the original untouched', () => {
    const original = makePoints(6);
    const dup = duplicateShapePoints(original);
    const trimmed = trimShapeAtIndex(dup, 'end', 3);
    expect(trimmed.length).toBe(4);
    // Original is still 6 points — only the clone was trimmed.
    expect(original.length).toBe(6);
  });

  it('produces an inbound-style shape by trimming the duplicate from the start', () => {
    const original = makePoints(6);
    const dup = duplicateShapePoints(original);
    const inboundShape = trimShapeAtIndex(dup, 'start', 2);
    expect(inboundShape.length).toBe(4);
    expect(inboundShape[0].shape_pt_lat).toBeCloseTo(0.002);
  });
});
