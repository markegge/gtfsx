import { useMemo } from 'react';
import { useStore } from '../store';

/**
 * Feed slices scoped to routes whose visibility is toggled ON (i.e. not in
 * `hiddenRouteIds`). The analysis panels (Costs, Coverage, Title VI, Stop
 * Analysis) compute over these instead of the full feed, so toggling routes
 * off on the map lets you compare scenarios.
 *
 * Scoping cascades route → trip → stop_time → stop, so `stops` includes only
 * stops served by a visible route. When nothing is hidden it returns the full
 * arrays unchanged (and the same references, so memoized analyses don't
 * recompute).
 */
export function useVisibleFeed() {
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const stops = useStore((s) => s.stops);
  const stopTimes = useStore((s) => s.stopTimes);
  const routeStops = useStore((s) => s.routeStops);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);

  return useMemo(() => {
    const anyHidden = hiddenRouteIds.length > 0;
    if (!anyHidden) {
      return {
        routes, trips, stops, stopTimes, routeStops,
        anyHidden: false, visibleRouteCount: routes.length, totalRouteCount: routes.length,
      };
    }
    const hidden = new Set(hiddenRouteIds);
    const vRoutes = routes.filter((r) => !hidden.has(r.route_id));
    const vTrips = trips.filter((t) => !t.route_id || !hidden.has(t.route_id));
    const vTripIds = new Set(vTrips.map((t) => t.trip_id));
    const vStopTimes = stopTimes.filter((st) => vTripIds.has(st.trip_id));
    const vStopIds = new Set(vStopTimes.map((st) => st.stop_id));
    const vStops = stops.filter((s) => vStopIds.has(s.stop_id));
    const vRouteStops = routeStops.filter((rs) => !hidden.has(rs.route_id));
    return {
      routes: vRoutes, trips: vTrips, stops: vStops, stopTimes: vStopTimes, routeStops: vRouteStops,
      anyHidden: true, visibleRouteCount: vRoutes.length, totalRouteCount: routes.length,
    };
  }, [routes, trips, stops, stopTimes, routeStops, hiddenRouteIds]);
}
