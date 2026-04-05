import { useMemo } from 'react';
import { Popup } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import { formatTimeShort } from '../../utils/time';
import { ROUTE_TYPES, directionName } from '../../utils/constants';

interface RoutePopupProps {
  routeId: string;
  directionId: 0 | 1;
  lngLat: { lng: number; lat: number };
  onClose: () => void;
}

export function RoutePopup({ routeId, directionId, lngLat, onClose }: RoutePopupProps) {
  const route = useStore((s) => s.routes.find((r) => r.route_id === routeId));
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const routeStops = useStore((s) => s.routeStops);
  const { setSidebarSection, selectRoute, setEditingRouteId } = useStore();

  const info = useMemo(() => {
    if (!route) return null;

    const routeTrips = trips.filter((t) => t.route_id === routeId);
    const dirTrips = routeTrips.filter((t) => t.direction_id === directionId);

    // Get first stop time of each trip as the "start time"
    const startTimes = dirTrips
      .map((t) => {
        const firstSt = stopTimes
          .filter((st) => st.trip_id === t.trip_id)
          .sort((a, b) => a.stop_sequence - b.stop_sequence)[0];
        return {
          time: firstSt?.arrival_time || '',
          headsign: t.trip_headsign || '',
        };
      })
      .filter((t) => t.time)
      .sort((a, b) => a.time.localeCompare(b.time));

    const headsign = dirTrips[0]?.trip_headsign || directionName(route, directionId);

    // Stop count for this direction
    const stopCount = new Set(
      routeStops.filter((rs) => rs.route_id === routeId && rs.direction_id === directionId).map((rs) => rs.stop_id)
    ).size;

    return { headsign, tripCount: dirTrips.length, startTimes: startTimes.slice(0, 4), stopCount };
  }, [route, routeId, directionId, trips, stopTimes, routeStops]);

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

        <div className="border-t border-sand pt-2 mb-2">
          <p className="text-[10px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            {info.headsign} ({info.tripCount} trips)
          </p>
          {info.startTimes.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {info.startTimes.map((t, i) => (
                <span key={i} className="text-xs font-mono tabular-nums text-dark-brown">
                  {formatTimeShort(t.time)}
                </span>
              ))}
              {info.tripCount > 4 && (
                <span className="text-[11px] text-warm-gray">+{info.tripCount - 4} more</span>
              )}
            </div>
          )}
        </div>

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
