import { useMemo } from 'react';
import { Popup } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import { formatTimeShort } from '../../utils/time';

function scrollToStopProperties() {
  // Double rAF ensures we're past React's render cycle before scrolling
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById('stop-properties')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

interface StopPopupProps {
  stopId: string;
  onClose: () => void;
}

export function StopPopup({ stopId, onClose }: StopPopupProps) {
  const stop = useStore((s) => s.stops.find((st) => st.stop_id === stopId));
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const selectStop = useStore((s) => s.selectStop);
  const setSidebarSection = useStore((s) => s.setSidebarSection);

  const handleEdit = () => {
    selectStop(stopId);
    setSidebarSection('stops');
    onClose();
    scrollToStopProperties();
  };

  const info = useMemo(() => {
    if (!stop) return null;

    // Find which routes serve this stop
    const servingRouteIds = [...new Set(routeStops
      .filter((rs) => rs.stop_id === stopId)
      .map((rs) => rs.route_id))];
    const servingRoutes = routes.filter((r) => servingRouteIds.includes(r.route_id));

    // Get next few stop times (sorted by arrival)
    const times = stopTimes
      .filter((st) => st.stop_id === stopId && st.arrival_time)
      .sort((a, b) => a.arrival_time.localeCompare(b.arrival_time))
      .slice(0, 6);

    // Enrich times with trip/route info
    const enrichedTimes = times.map((st) => {
      const trip = trips.find((t) => t.trip_id === st.trip_id);
      const route = trip ? routes.find((r) => r.route_id === trip.route_id) : null;
      return {
        time: formatTimeShort(st.arrival_time),
        routeName: route?.route_short_name || route?.route_long_name || '',
        routeColor: route?.route_color || '888888',
        headsign: trip?.trip_headsign || '',
      };
    });

    return { servingRoutes, enrichedTimes };
  }, [stop, stopId, routes, routeStops, trips, stopTimes]);

  if (!stop || !info) return null;

  return (
    <Popup
      longitude={stop.stop_lon}
      latitude={stop.stop_lat}
      onClose={onClose}
      closeButton={true}
      closeOnClick={false}
      anchor="bottom"
      offset={12}
      className="stop-popup"
    >
      <div className="min-w-[200px] max-w-[280px]">
        <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">{stop.stop_name}</h3>
        {stop.stop_code && (
          <p className="text-[11px] text-warm-gray mb-2">Stop #{stop.stop_code}</p>
        )}

        {/* Serving routes */}
        {info.servingRoutes.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {info.servingRoutes.map((r) => (
              <span
                key={r.route_id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold"
                style={{
                  backgroundColor: `#${r.route_color}20`,
                  color: `#${r.route_color}`,
                }}
              >
                <span
                  className="w-2 h-2 rounded-sm"
                  style={{ backgroundColor: `#${r.route_color}` }}
                />
                {r.route_short_name || r.route_long_name}
              </span>
            ))}
          </div>
        )}

        {/* Stop times */}
        {info.enrichedTimes.length > 0 && (
          <div className="border-t border-sand pt-2">
            <p className="text-[10px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Departures
            </p>
            <div className="flex flex-col gap-0.5">
              {info.enrichedTimes.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span
                    className="w-2 h-2 rounded-sm shrink-0"
                    style={{ backgroundColor: `#${t.routeColor}` }}
                  />
                  <span className="font-mono font-semibold tabular-nums w-10">{t.time}</span>
                  <span className="text-warm-gray truncate">
                    {t.routeName}{t.headsign ? ` → ${t.headsign}` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Edit button */}
        <div className="border-t border-sand pt-2 mt-2">
          <button
            onClick={handleEdit}
            className="w-full px-3 py-1.5 text-xs font-semibold text-coral bg-coral-light hover:bg-coral hover:text-white rounded-md transition-colors"
          >
            Edit Stop Properties
          </button>
        </div>
      </div>
    </Popup>
  );
}
