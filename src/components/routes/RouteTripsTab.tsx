import { useStore } from '../../store';
import { directionName } from '../../utils/constants';

function fmtTime(t: string | undefined): string {
  if (!t) return '—';
  // GTFS times are HH:MM:SS, optionally H:MM:SS — display HH:MM.
  const parts = t.split(':');
  if (parts.length < 2) return t;
  const h = parts[0]?.padStart(2, '0') ?? '00';
  const m = parts[1] ?? '00';
  return `${h}:${m}`;
}

function timeToSeconds(t: string | undefined): number {
  if (!t) return Number.MAX_SAFE_INTEGER;
  const parts = t.split(':').map(Number);
  return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
}

export function RouteTripsTab() {
  const route = useStore((s) => s.routes.find((r) => r.route_id === s.editingRouteId));
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const calendars = useStore((s) => s.calendars);
  const updateTrip = useStore((s) => s.updateTrip);

  if (!route) return null;

  const routeTrips = trips.filter((t) => t.route_id === route.route_id);

  const tripsWithMeta = routeTrips
    .map((trip) => {
      const tripStops = stopTimes
        .filter((st) => st.trip_id === trip.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      const start = tripStops[0]?.departure_time;
      const end = tripStops[tripStops.length - 1]?.arrival_time;
      const cal = calendars.find((c) => c.service_id === trip.service_id);
      return { trip, start, end, cal };
    })
    .sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start));

  const handleEditTimetable = () => {
    useStore.getState().setBottomPanelOpen(true);
    useStore.getState().setBottomPanelTab('timetable');
  };

  return (
    <div>
      {tripsWithMeta.length === 0 ? (
        <div className="rounded-lg bg-cream p-4 text-sm text-warm-gray mb-3">
          No trips defined yet.
        </div>
      ) : (
        <div className="rounded-lg border border-sand overflow-hidden mb-3">
          <table className="w-full text-sm">
            <thead className="bg-cream text-[10px] uppercase tracking-wide text-warm-gray">
              <tr>
                <th className="text-left px-2.5 py-1.5 font-semibold">Direction</th>
                <th className="text-left px-2.5 py-1.5 font-semibold">Service</th>
                <th className="text-left px-2.5 py-1.5 font-semibold">Start</th>
                <th className="text-left px-2.5 py-1.5 font-semibold">End</th>
                <th className="text-left px-2.5 py-1.5 font-semibold" title="Vehicle blocking — group consecutive trips on the same vehicle">Block</th>
              </tr>
            </thead>
            <tbody>
              {tripsWithMeta.slice(0, 50).map(({ trip, start, end, cal }) => (
                <tr key={trip.trip_id} className="border-t border-sand">
                  <td className="px-2.5 py-1.5 text-dark-brown truncate">
                    {trip.trip_headsign || directionName(route, trip.direction_id)}
                  </td>
                  <td className="px-2.5 py-1.5 text-warm-gray truncate">
                    {cal?.service_id || trip.service_id}
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-dark-brown tabular-nums">
                    {fmtTime(start)}
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-warm-gray tabular-nums">
                    {fmtTime(end)}
                  </td>
                  <td className="px-1.5 py-1">
                    <input
                      defaultValue={trip.block_id || ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (trip.block_id || '')) {
                          updateTrip(trip.trip_id, { block_id: v || undefined });
                        }
                      }}
                      placeholder="—"
                      className="w-20 px-1.5 py-0.5 text-xs border border-transparent hover:border-sand focus:border-coral focus:bg-white rounded bg-transparent font-mono"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tripsWithMeta.length > 50 && (
            <div className="px-2.5 py-1.5 text-[11px] text-warm-gray bg-cream border-t border-sand">
              Showing 50 of {tripsWithMeta.length} trips. Open the timetable to edit.
            </div>
          )}
        </div>
      )}
      <button
        onClick={handleEditTimetable}
        className="w-full px-4 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
      >
        Open timetable editor →
      </button>
    </div>
  );
}
