import type { Shape, ShapePoint } from '../types/gtfs';

/**
 * Pure shape mutation helpers — kept out of the React components so they
 * can be tested directly without a store / map mock. Each function returns
 * a fresh array; callers feed the result back through updateShapePoints
 * (or addShape) to commit.
 */

/** Deep-copy a shape's points under a new shape_id. Sequence numbers are
 *  renumbered from 0 and shape_dist_traveled is preserved — callers typically
 *  invoke recalcShapeDistances() afterwards anyway, but keeping the existing
 *  distances means the duplicate behaves identically until edited. */
export function duplicateShapePoints(source: ShapePoint[]): ShapePoint[] {
  return source.map((p, i) => ({
    shape_pt_lat: p.shape_pt_lat,
    shape_pt_lon: p.shape_pt_lon,
    shape_pt_sequence: i,
    shape_dist_traveled: p.shape_dist_traveled,
  }));
}

/** Find the index of the vertex on `points` closest (great-circle, but a flat
 *  approximation is fine for the local scale of a transit shape) to the given
 *  lng/lat. Returns -1 if the points array is empty. */
export function nearestVertexIndex(points: ShapePoint[], lng: number, lat: number): number {
  let bestIdx = -1;
  let bestSq = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dLng = points[i].shape_pt_lon - lng;
    const dLat = points[i].shape_pt_lat - lat;
    const sq = dLng * dLng + dLat * dLat;
    if (sq < bestSq) {
      bestSq = sq;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Trim a shape at a given vertex index. `side: 'start'` removes everything
 * before the cut, `side: 'end'` removes everything after. The cut vertex
 * itself is included in the surviving slice — i.e. the kept portion always
 * touches the click point so the visible shape doesn't appear to gap.
 *
 * Always returns a fresh ShapePoint[] with renumbered sequence. Returns the
 * source array unchanged if the slice would leave fewer than two points
 * (a degenerate shape) — callers can detect that and surface a warning.
 */
export function trimShapeAtIndex(
  points: ShapePoint[],
  side: 'start' | 'end',
  cutIndex: number,
): ShapePoint[] {
  if (points.length < 2) return points;
  if (cutIndex < 0 || cutIndex >= points.length) return points;
  const sliced = side === 'start' ? points.slice(cutIndex) : points.slice(0, cutIndex + 1);
  if (sliced.length < 2) return points;
  return sliced.map((p, i) => ({
    shape_pt_lat: p.shape_pt_lat,
    shape_pt_lon: p.shape_pt_lon,
    shape_pt_sequence: i,
    shape_dist_traveled: p.shape_dist_traveled,
  }));
}

/** Convenience wrapper: trim by click coordinates. Returns the new points
 *  array (or the source unchanged if the click yields a degenerate result). */
export function trimShapeAtPoint(
  shape: Shape,
  side: 'start' | 'end',
  lng: number,
  lat: number,
): ShapePoint[] {
  const idx = nearestVertexIndex(shape.points, lng, lat);
  if (idx === -1) return shape.points;
  return trimShapeAtIndex(shape.points, side, idx);
}
