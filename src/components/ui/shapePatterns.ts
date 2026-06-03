// A route's distinct shapes are its "patterns" (one shape_id per direction
// variant). Shared by the Timetable tab and Routes > Stops subpanel to decide
// when the 2-way Direction toggle should give way to a dropdown (3+ patterns).

import type { RouteStop, Trip } from '../../types/gtfs';

export interface ShapePattern {
  shapeId: string;
  directionId: 0 | 1;
}

/**
 * Distinct shape patterns for a route: one entry per shape_id the route
 * references, carrying that shape's direction. Sorted by direction then
 * shape_id for a stable dropdown order. Returns [] when no route is given.
 *
 * Shapes are sourced from BOTH the route's trips and its routeStops, so a
 * shape whose last trip was deleted (but whose stops remain) is still a
 * first-class pattern — letting the user rebuild a timetable from scratch:
 * change stop order → remove all trips → add one trip → replicate by headway.
 *
 * A shape that has trips takes its direction from those trips (first trip
 * wins). A trip-less shape takes its direction from a routeStop's
 * direction_id for that (route, shape).
 */
export function computeShapePatterns(
  routeId: string | null | undefined,
  trips: Trip[],
  routeStops: RouteStop[] = [],
): ShapePattern[] {
  if (!routeId) return [];
  const seen = new Map<string, 0 | 1>();
  // Trips win for direction (a shape with trips keeps its existing behaviour).
  for (const t of trips) {
    if (t.route_id !== routeId) continue;
    if (!t.shape_id) continue;
    if (!seen.has(t.shape_id)) seen.set(t.shape_id, t.direction_id);
  }
  // Then fold in shapes that only appear in routeStops (trip-less but
  // stop-bearing), taking their direction from the routeStop.
  for (const rs of routeStops) {
    if (rs.route_id !== routeId) continue;
    if (!rs.shape_id) continue;
    if (!seen.has(rs.shape_id)) seen.set(rs.shape_id, rs.direction_id);
  }
  return [...seen.entries()]
    .map(([shapeId, directionId]) => ({ shapeId, directionId }))
    .sort((a, b) => a.directionId - b.directionId || a.shapeId.localeCompare(b.shapeId));
}
