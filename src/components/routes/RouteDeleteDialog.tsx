import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { Modal } from '../ui/Modal';
import { AuthButton } from '../auth/AuthButton';

export function RouteDeleteDialog() {
  const routeId = useStore((s) => s.routeDeleteConfirmId);
  const setRouteDeleteConfirmId = useStore((s) => s.setRouteDeleteConfirmId);
  const route = useStore((s) =>
    routeId ? s.routes.find((r) => r.route_id === routeId) ?? null : null,
  );
  const trips = useStore((s) => s.trips);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const removeRoute = useStore((s) => s.removeRoute);
  const selectRoute = useStore((s) => s.selectRoute);
  const setEditingRouteId = useStore((s) => s.setEditingRouteId);

  const [deleteOrphanedStops, setDeleteOrphanedStops] = useState(true);
  const [dontWarnDelete, setDontWarnDelete] = useState(false);

  const deleteInfo = useMemo(() => {
    if (!route) return { tripCount: 0, uniqueStops: [] as typeof stops };
    const routeTripCount = trips.filter((t) => t.route_id === route.route_id).length;
    const thisRouteStopIds = new Set(
      routeStops.filter((rs) => rs.route_id === route.route_id).map((rs) => rs.stop_id),
    );
    const otherRouteStopIds = new Set(
      routeStops.filter((rs) => rs.route_id !== route.route_id).map((rs) => rs.stop_id),
    );
    const uniqueStopIds = [...thisRouteStopIds].filter((sid) => !otherRouteStopIds.has(sid));
    const uniqueStops = uniqueStopIds
      .map((sid) => stops.find((s) => s.stop_id === sid))
      .filter(Boolean) as typeof stops;
    return { tripCount: routeTripCount, uniqueStops };
  }, [route, trips, routeStops, stops]);

  if (!route) return null;

  const close = () => setRouteDeleteConfirmId(null);
  const executeDelete = () => {
    if (dontWarnDelete) {
      localStorage.setItem('gtfs-skip-route-delete-warning', 'true');
    }
    removeRoute(route.route_id, { deleteOrphanedStops });
    selectRoute(null);
    setEditingRouteId(null);
    close();
  };

  return (
    <Modal
      open
      onClose={close}
      title={`Delete "${route.route_short_name || route.route_long_name || 'Untitled Route'}"?`}
      footer={
        <>
          <AuthButton variant="secondary" onClick={close}>
            Cancel
          </AuthButton>
          <AuthButton variant="danger" onClick={executeDelete}>
            Delete
          </AuthButton>
        </>
      }
    >
      {deleteInfo.tripCount > 0 && (
        <>
          <p className="text-sm text-warm-gray mb-2">This will also delete:</p>
          <ul className="text-sm text-dark-brown mb-3 space-y-1">
            <li>
              • {deleteInfo.tripCount} trip{deleteInfo.tripCount !== 1 ? 's' : ''} and their stop times
            </li>
          </ul>
        </>
      )}

      {deleteInfo.uniqueStops.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-cream border border-sand">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={deleteOrphanedStops}
              onChange={(e) => setDeleteOrphanedStops(e.target.checked)}
              className="mt-0.5 rounded"
            />
            <span className="text-sm text-dark-brown">
              <span className="font-semibold">
                Also delete {deleteInfo.uniqueStops.length} orphaned stop
                {deleteInfo.uniqueStops.length !== 1 ? 's' : ''}
              </span>
              <span className="block text-xs text-warm-gray mt-0.5">
                {deleteOrphanedStops
                  ? 'These stops are not used by any other route and will be removed.'
                  : 'These stops will stay in stops.txt without a route — useful if you plan to reassign them.'}
              </span>
            </span>
          </label>
          <div className="ml-6 mt-2 max-h-24 overflow-y-auto">
            {deleteInfo.uniqueStops.slice(0, 10).map((s) => (
              <div key={s.stop_id} className="text-xs text-warm-gray">
                {s.stop_name || s.stop_id}
              </div>
            ))}
            {deleteInfo.uniqueStops.length > 10 && (
              <div className="text-xs text-warm-gray italic">
                …and {deleteInfo.uniqueStops.length - 10} more
              </div>
            )}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-xs text-warm-gray cursor-pointer">
        <input
          type="checkbox"
          checked={dontWarnDelete}
          onChange={(e) => setDontWarnDelete(e.target.checked)}
          className="rounded"
        />
        Don't warn me again
      </label>
    </Modal>
  );
}

