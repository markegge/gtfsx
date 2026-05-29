// A route's distinct shapes are its "patterns" (one shape_id per direction
// variant). Shared by the Timetable tab and Routes > Stops subpanel to decide
// when the 2-way Direction toggle should give way to a dropdown (3+ patterns).

import type { Trip } from '../../types/gtfs';

export interface ShapePattern {
  shapeId: string;
  directionId: 0 | 1;
}

/**
 * Distinct shape patterns for a route: one entry per shape_id its trips
 * reference, carrying that shape's direction. Sorted by direction then
 * shape_id for a stable dropdown order. Returns [] when no route is given.
 */
export function computeShapePatterns(
  routeId: string | null | undefined,
  trips: Trip[],
): ShapePattern[] {
  if (!routeId) return [];
  const seen = new Map<string, 0 | 1>();
  for (const t of trips) {
    if (t.route_id !== routeId) continue;
    if (!t.shape_id) continue;
    if (!seen.has(t.shape_id)) seen.set(t.shape_id, t.direction_id);
  }
  return [...seen.entries()]
    .map(([shapeId, directionId]) => ({ shapeId, directionId }))
    .sort((a, b) => a.directionId - b.directionId || a.shapeId.localeCompare(b.shapeId));
}
