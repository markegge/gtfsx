import type { StateCreator } from 'zustand';
import type { Route, RouteStop } from '../types/gtfs';
import type { TripSlice } from './tripSlice';
import type { ShapeSlice } from './shapeSlice';
import type { FareSlice } from './fareSlice';
import type { StopSlice } from './stopSlice';

export interface RouteSlice {
  routes: Route[];
  routeStops: RouteStop[];
  addRoute: (route: Route) => void;
  updateRoute: (route_id: string, updates: Partial<Route>) => void;
  removeRoute: (route_id: string) => void;
  setRoutes: (routes: Route[]) => void;
  addRouteStop: (rs: RouteStop) => void;
  removeRouteStop: (route_id: string, stop_id: string, direction_id: 0 | 1) => void;
  reorderRouteStops: (route_id: string, direction_id: 0 | 1, stopIds: string[]) => void;
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
  removeRoute: (route_id) => set((state) => {
    // Remove the route itself
    state.routes = state.routes.filter((r) => r.route_id !== route_id);
    // Remove route-stop associations
    state.routeStops = state.routeStops.filter((rs) => rs.route_id !== route_id);

    // Cascade: remove trips for this route and their stop_times
    const fullState = get() as unknown as RouteSlice & TripSlice & ShapeSlice & FareSlice;
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
    (state as any).trips = fullState.trips.filter((t) => t.route_id !== route_id);
    // Remove stop_times for deleted trips
    (state as any).stopTimes = fullState.stopTimes.filter((st) => !tripIds.has(st.trip_id));
    // Remove shapes only used by this route
    const shapesToRemove = new Set(
      [...routeShapeIds].filter((sid) => !otherShapeIds.has(sid))
    );
    if (shapesToRemove.size > 0) {
      (state as any).shapes = fullState.shapes.filter((s) => !shapesToRemove.has(s.shape_id));
    }
    // Remove fare rules for this route
    (state as any).fareRules = fullState.fareRules.filter((fr) => fr.route_id !== route_id);

    // Remove stops that are unique to this route (not shared with other routes)
    const fullWithStops = get() as unknown as RouteSlice & TripSlice & ShapeSlice & FareSlice & StopSlice;
    const thisRouteStopIds = new Set(
      fullWithStops.routeStops
        .filter((rs) => rs.route_id === route_id)
        .map((rs) => rs.stop_id)
    );
    const otherRouteStopIds = new Set(
      fullWithStops.routeStops
        .filter((rs) => rs.route_id !== route_id)
        .map((rs) => rs.stop_id)
    );
    const uniqueStopIds = new Set(
      [...thisRouteStopIds].filter((sid) => !otherRouteStopIds.has(sid))
    );
    if (uniqueStopIds.size > 0) {
      (state as any).stops = fullWithStops.stops.filter((s) => !uniqueStopIds.has(s.stop_id));
    }
  }),
  setRoutes: (routes) => set((state) => { state.routes = routes; }),
  addRouteStop: (rs) => set((state) => { state.routeStops.push(rs); }),
  removeRouteStop: (route_id, stop_id, direction_id) => set((state) => {
    state.routeStops = state.routeStops.filter(
      (rs) => !(rs.route_id === route_id && rs.stop_id === stop_id && rs.direction_id === direction_id)
    );
    // Also remove stop_times for this stop on trips in this route+direction
    const fullState = get() as unknown as RouteSlice & TripSlice;
    const affectedTripIds = new Set(
      fullState.trips
        .filter((t) => t.route_id === route_id && t.direction_id === direction_id)
        .map((t) => t.trip_id),
    );
    if (affectedTripIds.size > 0) {
      (state as any).stopTimes = fullState.stopTimes.filter(
        (st) => !(affectedTripIds.has(st.trip_id) && st.stop_id === stop_id)
      );
    }
  }),
  reorderRouteStops: (route_id, direction_id, stopIds) => set((state) => {
    const others = state.routeStops.filter(
      (rs) => rs.route_id !== route_id || rs.direction_id !== direction_id
    );
    const reordered = stopIds.map((sid, i) => {
      const existing = state.routeStops.find(
        (rs) => rs.route_id === route_id && rs.stop_id === sid && rs.direction_id === direction_id
      );
      return { ...(existing || { route_id, stop_id: sid, direction_id, _snapped: true }), stop_sequence: i };
    });
    state.routeStops = [...others, ...reordered];
  }),
  setRouteStops: (routeStops) => set((state) => { state.routeStops = routeStops; }),
});
