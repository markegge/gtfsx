// A route's distinct shapes are its "patterns" (one shape_id per direction
// variant). Shared by the Timetable tab and Routes > Stops subpanel to decide
// when the 2-way Direction toggle should give way to a dropdown (3+ patterns).

import type { RouteStop, Trip, Shape } from '../../types/gtfs';

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
 * direction_id for that (route, shape). A freshly DRAWN shape with neither
 * (linked to the route only by `shape._route_id`) is folded in last so it's
 * selectable in the Stops subpanel's "Assign to" dropdown before it has any
 * stops — each takes the first direction not already used by a real pattern.
 */
export function computeShapePatterns(
  routeId: string | null | undefined,
  trips: Trip[],
  routeStops: RouteStop[] = [],
  shapes: Shape[] = [],
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
  // Finally, freshly drawn shapes that belong to this route (shape._route_id)
  // but have no trip or route_stop yet. Without this, a just-drawn second shape
  // can't be selected to place stops on (chicken-and-egg). Each gets the first
  // free direction, so an out-and-back's two shapes land on 0 then 1.
  const usedDirs = new Set<0 | 1>(seen.values());
  for (const s of shapes) {
    if (s._route_id !== routeId) continue;
    if (seen.has(s.shape_id)) continue;
    const dir: 0 | 1 = usedDirs.has(0) ? 1 : 0;
    seen.set(s.shape_id, dir);
    usedDirs.add(dir);
  }
  return [...seen.entries()]
    .map(([shapeId, directionId]) => ({ shapeId, directionId }))
    .sort((a, b) => a.directionId - b.directionId || a.shapeId.localeCompare(b.shapeId));
}

/**
 * The shape the Routes > Stops subpanel is currently editing. A pinned
 * selection (e.g. "Edit Stops" on a specific shape row) wins while it's still
 * one of the route's patterns; otherwise it follows the active direction, so
 * changing the Direction dropdown moves the active shape — and the map
 * highlight, which keys off this same shape. Null when the route has no
 * shaped patterns.
 */
export function activeStopsShapeId(
  patterns: ShapePattern[],
  selectedShapeId: string | null,
  directionId: 0 | 1,
): string | null {
  if (selectedShapeId && patterns.some((p) => p.shapeId === selectedShapeId)) {
    return selectedShapeId;
  }
  return patterns.find((p) => p.directionId === directionId)?.shapeId ?? null;
}
