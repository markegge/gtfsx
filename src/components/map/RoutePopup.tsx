import { useMemo } from 'react';
import { Popup } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import { ROUTE_TYPES } from '../../utils/constants';

interface RoutePopupProps {
  routeId: string;
  directionId: 0 | 1;
  lngLat: { lng: number; lat: number };
  onClose: () => void;
}

export function RoutePopup({ routeId, directionId, lngLat, onClose }: RoutePopupProps) {
  const route = useStore((s) => s.routes.find((r) => r.route_id === routeId));
  const trips = useStore((s) => s.trips);
  const routeStops = useStore((s) => s.routeStops);
  const { setSidebarSection, selectRoute, setEditingRouteId } = useStore();

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
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-4 h-4 rounded"
            style={{ backgroundColor: `#${route.route_color}` }}
          />
          <h3 className="font-heading font-bold text-sm text-dark-brown">
            {route.route_short_name || route.route_long_name}
          </h3>
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

        {/* Action buttons */}
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
