import type { RouteStop, Trip } from '../types/gtfs';

/**
 * Backfill `shape_id` on route stops saved before stops were keyed per shape.
 *
 * Today's per-shape work made the timetable and stops panel filter route stops
 * strictly on `rs.shape_id === <selected shape>`. Feeds saved before that change
 * have route stops with no `shape_id`, so those views find none and show
 * "Add stops to this route first" even though the stops are still there.
 *
 * Assign each shape-less stop the first `shape_id` used by a trip on its
 * (route_id, direction_id) — the representative shape for that direction, which
 * is what legacy single-shape-per-direction feeds expect. Stops that already
 * carry a shape_id, and feeds whose trips have no shapes, pass through unchanged.
 *
 * Run on EVERY load path (local IndexedDB draft AND server working state) so the
 * two can't drift apart — the original bug was the server loader missing this.
 */
export function backfillRouteStopShapeIds(routeStops: RouteStop[], trips: Trip[]): RouteStop[] {
  // Fast path: nothing to migrate (new feeds — every stop already keyed).
  if (routeStops.length === 0 || routeStops.every((rs) => rs.shape_id)) return routeStops;

  const shapeForRouteDir = new Map<string, string>();
  for (const t of trips) {
    if (!t.shape_id) continue;
    const k = `${t.route_id}|${t.direction_id}`;
    if (!shapeForRouteDir.has(k)) shapeForRouteDir.set(k, t.shape_id);
  }

  return routeStops.map((rs) =>
    rs.shape_id
      ? rs
      : { ...rs, shape_id: shapeForRouteDir.get(`${rs.route_id}|${rs.direction_id}`) },
  );
}
