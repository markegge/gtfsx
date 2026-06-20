import type { Shape, Trip, RouteStop } from '../types/gtfs';
import { useStore } from '../store';
import { generateId } from './idGenerator';
import { simplifyShapePoints } from './simplifyShape';

/**
 * Create a shape from drawn coordinates for a route — WITHOUT a stub trip.
 *
 * A freshly drawn route shape used to come with a placeholder trip (no
 * stop_times) so the shape would be associated to its route (route↔shape links
 * are derived from trips). That stub showed up as an empty trip in the
 * timetable. Instead we tag the shape with the editor-only `_route_id`, which
 * the Route Shapes panel, map RouteLayer, and stop-placement read so the drawn
 * shape still appears / renders / is snap-able before it has any stops or trips.
 * `_route_id` is never written to shapes.txt (the exporter emits explicit
 * columns), so GTFS export is unaffected.
 *
 * Returns the new shape_id.
 */
export function createDrawnShape(coords: [number, number][], routeId: string): string {
  const shapeId = generateId('shape');
  let points = coords.map((c, i) => ({
    shape_pt_lat: c[1],
    shape_pt_lon: c[0],
    shape_pt_sequence: i,
    shape_dist_traveled: 0,
  }));
  // Auto-simplify if the drawn line has too many points (freehand creates ~1 per pixel)
  if (points.length > 20) {
    points = simplifyShapePoints(points, 0.00005); // Light simplify ~5m
  }

  const st = useStore.getState();
  st.addShape({ shape_id: shapeId, points, _route_id: routeId });
  st.recalcShapeDistances(shapeId);
  return shapeId;
}

/**
 * The shape_ids that belong to a route, as the UNION of:
 *   (a) its trips' shape_ids,
 *   (b) its route_stops' shape_ids (a shape with stops on this route stays
 *       listed even after its last trip is deleted), and
 *   (c) freshly drawn shapes tagged with this route via `Shape._route_id` but
 *       not yet given a trip or route_stop.
 *
 * (c) keeps a just-drawn shape from vanishing before stops/trips exist; it's
 * redundant once the shape gains either (the Set dedupes, so it's effectively
 * ignored) and is never exported.
 */
export function deriveRouteShapeIds(
  routeId: string | null,
  trips: Trip[],
  routeStops: RouteStop[],
  shapes: Shape[],
): string[] {
  if (!routeId) return [];
  const ids = new Set<string>();
  for (const t of trips) if (t.route_id === routeId && t.shape_id) ids.add(t.shape_id);
  for (const rs of routeStops) if (rs.route_id === routeId && rs.shape_id) ids.add(rs.shape_id);
  for (const sh of shapes) if (sh._route_id === routeId) ids.add(sh.shape_id);
  return [...ids];
}
