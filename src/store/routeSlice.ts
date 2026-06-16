import type { StateCreator } from 'zustand';
import type { Route, RouteStop } from '../types/gtfs';
import { generateId } from '../services/idGenerator';
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
  /** Remove a single route_stop instance, identified by its `_uid`. A pattern
   *  may list the same stop_id more than once, so removal is per-instance. */
  removeRouteStop: (route_id: string, _uid: string) => void;
  /** Reorder a route's stops by a list of route_stop `_uid`s (per-instance, so
   *  a repeated stop's two entries reorder independently). */
  reorderRouteStops: (route_id: string, direction_id: 0 | 1, uids: string[], shape_id?: string) => void;
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
          // Fresh per-instance handle so the copy's stops are independent of
          // the original's (otherwise remove/reorder would hit both).
          _uid: generateId('rs'),
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
  addRouteStop: (rs) => set((state) => {
    // Stamp a per-instance handle so a stop listed twice in one pattern stays
    // individually addressable (remove/reorder one without touching the other).
    const stamped = rs._uid ? rs : { ...rs, _uid: generateId('rs') };
    state.routeStops.push(stamped);
    // A stop added to a pattern that ALREADY has trips defaults to SERVED — we
    // seed a blank (no-time) stop_time row on every matching trip. Without a
    // row the timetable would render the new stop as "skipped" on those trips
    // (a missing row = skipped). Import uses setRouteStops (not addRouteStop),
    // so genuinely-skipped stops in an imported feed are preserved. When no
    // trips exist yet (the normal draw → add stops → add trips order) this is
    // a no-op.
    const cs = state as unknown as CrossSliceState;
    const haveAtSeq = new Set(
      cs.stopTimes
        .filter((st) => st.stop_sequence === stamped.stop_sequence)
        .map((st) => st.trip_id),
    );
    for (const t of cs.trips) {
      if (t.route_id !== stamped.route_id) continue;
      const matches = stamped.shape_id
        ? t.shape_id === stamped.shape_id
        : t.direction_id === stamped.direction_id;
      if (!matches || haveAtSeq.has(t.trip_id)) continue;
      cs.stopTimes.push({
        trip_id: t.trip_id,
        stop_id: stamped.stop_id,
        stop_sequence: stamped.stop_sequence,
        arrival_time: '',
        departure_time: '',
      });
    }
  }),
  removeRouteStop: (route_id, _uid) => set((state) => {
    // Remove exactly one instance (by _uid). Capture it first so we know which
    // stop / shape / direction / sequence to clean up in stop_times.
    const target = state.routeStops.find((rs) => rs.route_id === route_id && rs._uid === _uid);
    state.routeStops = state.routeStops.filter((rs) => !(rs.route_id === route_id && rs._uid === _uid));
    if (!target) return;
    // Drop the matching stop_time on each affected trip — the row at this
    // instance's stop_sequence (per-instance, so a duplicate stop's other
    // instance survives). Falls back to stop_id match for trips whose
    // stop_times predate this sequence (defensive; normal feeds align).
    const fullState = get() as unknown as RouteSlice & TripSlice;
    const { shape_id, direction_id, stop_id, stop_sequence } = target;
    const affectedTripIds = new Set(
      fullState.trips
        .filter((t) => t.route_id === route_id
          && (shape_id ? t.shape_id === shape_id : t.direction_id === direction_id))
        .map((t) => t.trip_id),
    );
    if (affectedTripIds.size > 0) {
      // If the stop_id still appears elsewhere in this pattern, scope removal to
      // the specific sequence so we don't nuke the surviving instance's times.
      const stopRepeats = state.routeStops.some(
        (rs) => rs.route_id === route_id
          && (shape_id ? rs.shape_id === shape_id : rs.direction_id === direction_id)
          && rs.stop_id === stop_id,
      );
      (state as CrossSliceState).stopTimes = fullState.stopTimes.filter((st) => {
        if (!affectedTripIds.has(st.trip_id) || st.stop_id !== stop_id) return true;
        return stopRepeats ? st.stop_sequence !== stop_sequence : false;
      });
    }
  }),
  reorderRouteStops: (route_id, direction_id, uids, shape_id) => set((state) => {
    const inGroup = (rs: RouteStop) => rs.route_id === route_id
      && (shape_id ? rs.shape_id === shape_id : rs.direction_id === direction_id);
    const others = state.routeStops.filter((rs) => !inGroup(rs));
    // old stop_sequence → new stop_sequence, so we can keep each trip's
    // stop_times aligned to the column they belong to (the timetable aligns
    // route_stops ↔ stop_times by stop_sequence, the per-instance key).
    const seqRemap = new Map<number, number>();
    const reordered = uids
      .map((uid, i) => {
        const existing = state.routeStops.find((rs) => inGroup(rs) && rs._uid === uid);
        if (!existing) return null;
        if (existing.stop_sequence !== i) seqRemap.set(existing.stop_sequence, i);
        return { ...existing, stop_sequence: i };
      })
      .filter((rs): rs is RouteStop => rs !== null);
    state.routeStops = [...others, ...reordered];

    // Renumber the affected trips' stop_times to the new sequence so existing
    // times follow their stop through the reorder (and export in the new order).
    if (seqRemap.size > 0) {
      const fullState = get() as unknown as RouteSlice & TripSlice;
      const affectedTripIds = new Set(
        fullState.trips
          .filter((t) => t.route_id === route_id
            && (shape_id ? t.shape_id === shape_id : t.direction_id === direction_id))
          .map((t) => t.trip_id),
      );
      if (affectedTripIds.size > 0) {
        for (const st of (state as CrossSliceState).stopTimes) {
          if (!affectedTripIds.has(st.trip_id)) continue;
          const next = seqRemap.get(st.stop_sequence);
          if (next !== undefined) st.stop_sequence = next;
        }
      }
    }
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
  setRouteStops: (routeStops) => set((state) => {
    // Stamp a stable _uid on any route_stop that lacks one (imported feeds,
    // older snapshots). An imported feed may already repeat a stop within one
    // pattern, so each instance needs its own handle.
    state.routeStops = routeStops.map((rs) => (rs._uid ? rs : { ...rs, _uid: generateId('rs') }));
  }),
});
