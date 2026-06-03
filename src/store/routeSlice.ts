import type { StateCreator } from 'zustand';
import type { Route, RouteStop } from '../types/gtfs';
import type { TripSlice } from './tripSlice';
import type { ShapeSlice } from './shapeSlice';
import type { FareSlice } from './fareSlice';
import type { StopSlice } from './stopSlice';
import type { FlexSlice } from './flexSlice';

// Cross-slice mutations need to see fields from neighbouring slices.
// Casting state to this intersection is narrower than `any` and surfaces
// real typos in field names.
type CrossSliceState = RouteSlice & TripSlice & ShapeSlice & FareSlice & StopSlice & FlexSlice;

export interface RouteSlice {
  routes: Route[];
  routeStops: RouteStop[];
  addRoute: (route: Route) => void;
  updateRoute: (route_id: string, updates: Partial<Route>) => void;
  removeRoute: (route_id: string, opts?: { deleteOrphanedStops?: boolean }) => void;
  duplicateRoute: (route_id: string) => string | null;
  setRoutes: (routes: Route[]) => void;
  addRouteStop: (rs: RouteStop) => void;
  removeRouteStop: (route_id: string, stop_id: string, direction_id: 0 | 1, shape_id?: string) => void;
  reorderRouteStops: (route_id: string, direction_id: 0 | 1, stopIds: string[], shape_id?: string) => void;
  /** Flip a shape's direction: retag its trips + route stops to the new
   *  direction, optionally reversing the stop order. Powers the
   *  draw → add stops → duplicate → flip-to-inbound workflow. */
  setShapeDirection: (shape_id: string, direction_id: 0 | 1, opts?: { invertStops?: boolean }) => void;
  setRouteStops: (routeStops: RouteStop[]) => void;
}

export const createRouteSlice: StateCreator<RouteSlice, [['zustand/immer', never]], [], RouteSlice> = (set, get) => ({
  routes: [],
  routeStops: [],
  addRoute: (route) => set((state) => { state.routes.push(route); }),
  updateRoute: (route_id, updates) => set((state) => {
    const idx = state.routes.findIndex((r) => r.route_id === route_id);
    if (idx !== -1) Object.assign(state.routes[idx], updates);
  }),
  removeRoute: (route_id, opts) => set((state) => {
    const deleteOrphanedStops = opts?.deleteOrphanedStops ?? true;

    // Snapshot the routeStops BEFORE we remove this route's associations,
    // so we can compute "unique to this route" against the original graph.
    const fullState = get() as unknown as CrossSliceState;
    const thisRouteStopIds = new Set(
      fullState.routeStops
        .filter((rs) => rs.route_id === route_id)
        .map((rs) => rs.stop_id)
    );
    const otherRouteStopIds = new Set(
      fullState.routeStops
        .filter((rs) => rs.route_id !== route_id)
        .map((rs) => rs.stop_id)
    );
    const uniqueStopIds = new Set(
      [...thisRouteStopIds].filter((sid) => !otherRouteStopIds.has(sid))
    );

    // Remove the route itself
    state.routes = state.routes.filter((r) => r.route_id !== route_id);
    // Remove route-stop associations
    state.routeStops = state.routeStops.filter((rs) => rs.route_id !== route_id);

    // Cascade: remove trips for this route and their stop_times
    const tripIds = new Set(
      fullState.trips.filter((t) => t.route_id === route_id).map((t) => t.trip_id)
    );
    // Collect shape IDs used only by this route's trips
    const routeShapeIds = new Set(
      fullState.trips
        .filter((t) => t.route_id === route_id && t.shape_id)
        .map((t) => t.shape_id!)
    );
    // Don't delete shapes used by other routes' trips
    const otherShapeIds = new Set(
      fullState.trips
        .filter((t) => t.route_id !== route_id && t.shape_id)
        .map((t) => t.shape_id!)
    );

    // Remove trips
    (state as CrossSliceState).trips = fullState.trips.filter((t) => t.route_id !== route_id);
    // Remove stop_times for deleted trips
    (state as CrossSliceState).stopTimes = fullState.stopTimes.filter((st) => !tripIds.has(st.trip_id));
    // Remove shapes only used by this route
    const shapesToRemove = new Set(
      [...routeShapeIds].filter((sid) => !otherShapeIds.has(sid))
    );
    if (shapesToRemove.size > 0) {
      (state as CrossSliceState).shapes = fullState.shapes.filter((s) => !shapesToRemove.has(s.shape_id));
    }
    // Remove fare rules for this route
    (state as CrossSliceState).fareRules = fullState.fareRules.filter((fr) => fr.route_id !== route_id);
    // A flex zone is materialized as a route; deleting that route must also drop
    // the zone, or it orphans — left on the map with a dangling routeId and no
    // longer reachable from the Flex Zones panel's delete.
    (state as CrossSliceState).flexZones = fullState.flexZones.filter((z) => z.routeId !== route_id);

    // Optionally remove the stops that are now orphaned (not used by any
    // other route). When `deleteOrphanedStops` is false, the stops stay
    // in stops.txt as standalone points — useful for users planning to
    // assign them to a different route.
    if (deleteOrphanedStops && uniqueStopIds.size > 0) {
      (state as CrossSliceState).stops = fullState.stops.filter((s) => !uniqueStopIds.has(s.stop_id));
    }
  }),
  duplicateRoute: (route_id) => {
    const fullState = get() as unknown as RouteSlice & TripSlice & ShapeSlice;
    const original = fullState.routes.find((r) => r.route_id === route_id);
    if (!original) return null;

    const stamp = Date.now().toString(36);
    const newRouteId = `${original.route_id}-copy-${stamp}`;

    // Map old shape_id → new shape_id (one new shape per shape used by this route).
    const shapeIdMap = new Map<string, string>();
    const originalShapes = fullState.shapes.filter((s) =>
      fullState.trips.some((t) => t.route_id === route_id && t.shape_id === s.shape_id),
    );
    for (const s of originalShapes) {
      shapeIdMap.set(s.shape_id, `${s.shape_id}-copy-${stamp}`);
    }

    const tripIdMap = new Map<string, string>();
    const originalTrips = fullState.trips.filter((t) => t.route_id === route_id);
    for (const t of originalTrips) {
      tripIdMap.set(t.trip_id, `${t.trip_id}-copy-${stamp}`);
    }

    set((state) => {
      // Clone the route itself.
      const newName = original.route_short_name
        ? `${original.route_short_name} (copy)`
        : original.route_short_name;
      const newLongName = original.route_long_name
        ? `${original.route_long_name} (copy)`
        : original.route_long_name;
      state.routes.push({
        ...original,
        route_id: newRouteId,
        route_short_name: newName,
        route_long_name: newLongName,
      });

      // Clone route_stops, remapping shape_id to the duplicated shapes so the
      // copy's per-shape stop lists resolve (route stops are keyed per shape).
      for (const rs of fullState.routeStops) {
        if (rs.route_id !== route_id) continue;
        state.routeStops.push({
          ...rs,
          route_id: newRouteId,
          shape_id: rs.shape_id && shapeIdMap.has(rs.shape_id) ? shapeIdMap.get(rs.shape_id) : rs.shape_id,
        });
      }

      // Clone shapes (only those exclusively used by this route's trips).
      for (const s of originalShapes) {
        const newShapeId = shapeIdMap.get(s.shape_id)!;
        (state as CrossSliceState).shapes.push({
          ...s,
          shape_id: newShapeId,
          points: s.points.map((p) => ({ ...p })),
        });
      }

      // Clone trips and remap shape_id.
      for (const t of originalTrips) {
        (state as CrossSliceState).trips.push({
          ...t,
          trip_id: tripIdMap.get(t.trip_id)!,
          route_id: newRouteId,
          shape_id: t.shape_id ? shapeIdMap.get(t.shape_id) : undefined,
        });
      }

      // Clone stop_times.
      for (const st of fullState.stopTimes) {
        if (!tripIdMap.has(st.trip_id)) continue;
        (state as CrossSliceState).stopTimes.push({
          ...st,
          trip_id: tripIdMap.get(st.trip_id)!,
        });
      }
    });
    return newRouteId;
  },
  setRoutes: (routes) => set((state) => { state.routes = routes; }),
  addRouteStop: (rs) => set((state) => { state.routeStops.push(rs); }),
  removeRouteStop: (route_id, stop_id, direction_id, shape_id) => set((state) => {
    // Scope removal to the shape when given (per-shape stops), else to the
    // direction (legacy / shapeless feeds).
    state.routeStops = state.routeStops.filter((rs) => {
      if (rs.route_id !== route_id || rs.stop_id !== stop_id) return true;
      return shape_id ? rs.shape_id !== shape_id : rs.direction_id !== direction_id;
    });
    // Also remove stop_times for this stop on the affected trips.
    const fullState = get() as unknown as RouteSlice & TripSlice;
    const affectedTripIds = new Set(
      fullState.trips
        .filter((t) => t.route_id === route_id
          && (shape_id ? t.shape_id === shape_id : t.direction_id === direction_id))
        .map((t) => t.trip_id),
    );
    if (affectedTripIds.size > 0) {
      (state as CrossSliceState).stopTimes = fullState.stopTimes.filter(
        (st) => !(affectedTripIds.has(st.trip_id) && st.stop_id === stop_id)
      );
    }
  }),
  reorderRouteStops: (route_id, direction_id, stopIds, shape_id) => set((state) => {
    const inGroup = (rs: RouteStop) => rs.route_id === route_id
      && (shape_id ? rs.shape_id === shape_id : rs.direction_id === direction_id);
    const others = state.routeStops.filter((rs) => !inGroup(rs));
    const reordered = stopIds.map((sid, i) => {
      const existing = state.routeStops.find((rs) => inGroup(rs) && rs.stop_id === sid);
      return {
        ...(existing || { route_id, stop_id: sid, direction_id, _snapped: true, shape_id }),
        stop_sequence: i,
      };
    });
    state.routeStops = [...others, ...reordered];
  }),
  setShapeDirection: (shape_id, direction_id, opts) => set((state) => {
    // Retag trips on this shape to the new direction.
    for (const t of (state as unknown as CrossSliceState).trips) {
      if (t.shape_id === shape_id) t.direction_id = direction_id;
    }
    // Retag this shape's route stops; optionally reverse their order so an
    // inbound copy reads end-to-start.
    const shapeStops = state.routeStops.filter((rs) => rs.shape_id === shape_id);
    if (opts?.invertStops && shapeStops.length > 1) {
      const ordered = [...shapeStops].sort((a, b) => a.stop_sequence - b.stop_sequence);
      const n = ordered.length;
      ordered.forEach((rs, i) => { rs.stop_sequence = n - 1 - i; });
    }
    for (const rs of shapeStops) rs.direction_id = direction_id;
  }),
  setRouteStops: (routeStops) => set((state) => { state.routeStops = routeStops; }),
});
