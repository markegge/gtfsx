import { useMemo } from 'react';
import { Popup } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import { ROUTE_TYPES } from '../../utils/constants';

interface RoutePopupProps {
  routeId: string;
  directionId: 0 | 1;
  /** shape_id of the clicked polyline, when the popup originated from a
   *  route-line click. Used to drive the "Edit Shape" button — when absent
   *  (e.g. the popup ever opens from another source) the button hides. */
  shapeId?: string;
  lngLat: { lng: number; lat: number };
  onClose: () => void;
}

export function RoutePopup({ routeId, directionId, shapeId, lngLat, onClose }: RoutePopupProps) {
  const route = useStore((s) => s.routes.find((r) => r.route_id === routeId));
  const trips = useStore((s) => s.trips);
  const routeStops = useStore((s) => s.routeStops);
  const {
    setSidebarSection,
    selectRoute,
    setEditingRouteId,
    setRouteDetailTab,
    setPendingShapeEditId,
  } = useStore();

  // Intentionally does NOT touch stopTimes. The old popup listed each trip's
  // first departure, which meant filtering the entire stop_times table once per
  // trip (O(trips × stop_times)) — ~150M comparisons on a busy RTD route, a
  // 2–3s hang on click. Trip count + stop count are cheap and enough here.
  const info = useMemo(() => {
    if (!route) return null;
    const dirTrips = trips.filter((t) => t.route_id === routeId && t.direction_id === directionId);
    const stopCount = new Set(
      routeStops.filter((rs) => rs.route_id === routeId && rs.direction_id === directionId).map((rs) => rs.stop_id)
    ).size;
    return { tripCount: dirTrips.length, stopCount };
  }, [route, routeId, directionId, trips, routeStops]);

  if (!route || !info) return null;

  const handleEditShape = () => {
    if (!shapeId) return;
    // Suppress the next route-fit BEFORE we change any state that would trigger
    // it. useFocusRouteOnMap reads + clears this flag the first time it runs.
    // Window-based one-shot rather than store-based: it has to outlive the
    // effect-ordering race between RouteShapesTab (which clears pendingShapeEditId
    // synchronously) and RouteDetailPanel (whose useFocusRouteOnMap reads after).
    window.__suppressNextRouteFit = true;
    selectRoute(routeId);
    setEditingRouteId(routeId);
    setSidebarSection('routes');
    setRouteDetailTab('shapes');
    setPendingShapeEditId(shapeId);
    onClose();
  };

  return (
    <Popup
      longitude={lngLat.lng}
      latitude={lngLat.lat}
      onClose={onClose}
      closeButton={true}
      closeOnClick={false}
      anchor="bottom"
      offset={8}
      className="route-popup"
    >
      <div className="min-w-[220px] max-w-[300px]">
        <div className="flex items-center gap-2 mb-1 pr-5">
          <div
            className="w-4 h-4 rounded shrink-0"
            style={{ backgroundColor: `#${route.route_color}` }}
          />
          <h3 className="font-heading font-bold text-sm text-dark-brown truncate min-w-0">
            {route.route_short_name || route.route_long_name}
          </h3>
          {shapeId && (
            <button
              onClick={handleEditShape}
              title="Edit shape"
              aria-label="Edit shape"
              className="ml-auto shrink-0 p-1 rounded text-warm-gray hover:text-coral hover:bg-coral-light transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
            </button>
          )}
        </div>
        {route.route_long_name && route.route_short_name && (
          <p className="text-xs text-warm-gray mb-1">{route.route_long_name}</p>
        )}
        {route.route_desc && (
          <p className="text-[11px] text-warm-gray mb-1">{route.route_desc}</p>
        )}
        <p className="text-[11px] text-warm-gray mb-2">
          {ROUTE_TYPES[route.route_type] || 'Transit'} · {info.stopCount} stops · {info.tripCount} trips
        </p>

        {/* Action buttons — shape editing lives in the small pencil icon in the
            header above, so the bottom row stays Edit Route / Edit Timetable. */}
        <div className="border-t border-sand pt-2 flex gap-2">
          <button
            onClick={() => {
              selectRoute(routeId);
              setEditingRouteId(routeId);
              setSidebarSection('routes');
              onClose();
            }}
            className="flex-1 px-3 py-1.5 bg-coral-light text-coral rounded-lg text-xs font-heading font-bold hover:bg-coral hover:text-white transition-colors"
          >
            Edit Route
          </button>
          <button
            onClick={() => {
              selectRoute(routeId);
              useStore.getState().setBottomPanelOpen(true);
              useStore.getState().setBottomPanelTab('timetable');
              onClose();
            }}
            className="flex-1 px-3 py-1.5 bg-purple-light text-purple rounded-lg text-xs font-heading font-bold hover:bg-purple hover:text-white transition-colors"
          >
            Edit Timetable
          </button>
        </div>
      </div>
    </Popup>
  );
}
