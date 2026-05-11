import { useStore } from '../../store';

/**
 * Open the delete-route confirmation dialog. If the user has previously checked
 * "Don't warn me again" AND the route has no trips/orphan-stops to worry about,
 * the route is deleted immediately.
 */
export function requestDeleteRoute(routeId: string) {
  const skipWarning = localStorage.getItem('gtfs-skip-route-delete-warning') === 'true';
  if (skipWarning) {
    const { trips, routeStops } = useStore.getState();
    const tripCount = trips.filter((t) => t.route_id === routeId).length;
    const thisRouteStopIds = new Set(
      routeStops.filter((rs) => rs.route_id === routeId).map((rs) => rs.stop_id),
    );
    const otherRouteStopIds = new Set(
      routeStops.filter((rs) => rs.route_id !== routeId).map((rs) => rs.stop_id),
    );
    const uniqueCount = [...thisRouteStopIds].filter((sid) => !otherRouteStopIds.has(sid)).length;
    if (tripCount === 0 && uniqueCount === 0) {
      const { removeRoute, selectRoute, setEditingRouteId } = useStore.getState();
      removeRoute(routeId, { deleteOrphanedStops: true });
      selectRoute(null);
      setEditingRouteId(null);
      return;
    }
  }
  useStore.getState().setRouteDeleteConfirmId(routeId);
}
