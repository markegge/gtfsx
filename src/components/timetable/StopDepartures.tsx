import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { formatTimeShort } from '../../utils/time';
import { directionName } from '../../utils/constants';

type SortMode = 'time' | 'route';
type TimeField = 'departure' | 'arrival';

interface Departure {
  time: string;
  timeSortKey: string;
  routeName: string;
  routeColor: string;
  direction: string;
  serviceId: string;
  tripId: string;
}

export function StopDepartures() {
  const {
    stops, routes, trips, stopTimes, calendars,
    selectedStopId, selectStop,
    hiddenRouteIds,
  } = useStore();

  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [timeField, setTimeField] = useState<TimeField>('departure');

  const hiddenRouteSet = useMemo(() => new Set(hiddenRouteIds), [hiddenRouteIds]);

  // Auto-select first calendar if none selected
  const activeServiceId = useMemo(() => {
    if (selectedServiceId && calendars.some((c) => c.service_id === selectedServiceId)) return selectedServiceId;
    return calendars[0]?.service_id || null;
  }, [selectedServiceId, calendars]);

  // Build departures for the selected stop
  const departures = useMemo(() => {
    if (!selectedStopId) return [];

    const deps: Departure[] = [];
    // Find all stop_times for this stop
    // Build first/last stop_sequence per trip for GTFS convention
    const tripFirstLast = new Map<string, { first: number; last: number }>();
    for (const st of stopTimes) {
      const entry = tripFirstLast.get(st.trip_id);
      if (!entry) {
        tripFirstLast.set(st.trip_id, { first: st.stop_sequence, last: st.stop_sequence });
      } else {
        if (st.stop_sequence < entry.first) entry.first = st.stop_sequence;
        if (st.stop_sequence > entry.last) entry.last = st.stop_sequence;
      }
    }

    const relevantStopTimes = stopTimes.filter((st) => {
      if (st.stop_id !== selectedStopId) return false;
      return !!(st.arrival_time || st.departure_time);
    });

    for (const st of relevantStopTimes) {
      const trip = trips.find((t) => t.trip_id === st.trip_id);
      if (!trip) continue;
      if (activeServiceId && trip.service_id !== activeServiceId) continue;

      const route = routes.find((r) => r.route_id === trip.route_id);
      if (!route) continue;
      if (!showAllRoutes && hiddenRouteSet.has(route.route_id)) continue;

      // Apply GTFS convention: first stop = departure only, last stop = arrival only
      const fl = tripFirstLast.get(st.trip_id);
      const isFirstStop = fl && st.stop_sequence === fl.first;
      const isLastStop = fl && st.stop_sequence === fl.last;

      let timeValue: string;
      if (timeField === 'departure') {
        if (isLastStop) continue; // last stop has no departure
        timeValue = st.departure_time || st.arrival_time;
      } else {
        if (isFirstStop) continue; // first stop has no arrival
        timeValue = st.arrival_time || st.departure_time;
      }
      if (!timeValue) continue;

      deps.push({
        time: formatTimeShort(timeValue),
        timeSortKey: timeValue,
        routeName: route.route_short_name || route.route_long_name || route.route_id,
        routeColor: route.route_color,
        direction: directionName(route, trip.direction_id),
        serviceId: trip.service_id,
        tripId: trip.trip_id,
      });
    }

    // Sort
    if (sortMode === 'time') {
      deps.sort((a, b) => a.timeSortKey.localeCompare(b.timeSortKey));
    } else {
      deps.sort((a, b) => a.routeName.localeCompare(b.routeName) || a.timeSortKey.localeCompare(b.timeSortKey));
    }

    return deps;
  }, [selectedStopId, stopTimes, trips, routes, activeServiceId, sortMode, showAllRoutes, hiddenRouteSet, timeField]);

  // Compute frequency stats
  const stats = useMemo(() => {
    if (departures.length < 2) return null;
    const routeGroups = new Map<string, number>();
    for (const d of departures) {
      routeGroups.set(d.routeName, (routeGroups.get(d.routeName) || 0) + 1);
    }
    return {
      totalDepartures: departures.length,
      routeCount: routeGroups.size,
      firstDeparture: departures[0]?.time,
      lastDeparture: departures[departures.length - 1]?.time,
    };
  }, [departures]);

  // Stops that have any stop_times (for the dropdown)
  const stopsWithService = useMemo(() => {
    const ids = new Set(stopTimes.map((st) => st.stop_id));
    return stops.filter((s) => ids.has(s.stop_id)).sort((a, b) => a.stop_name.localeCompare(b.stop_name));
  }, [stops, stopTimes]);

  const selectedStop = selectedStopId ? stops.find((s) => s.stop_id === selectedStopId) : null;

  return (
    <div className="p-2 flex flex-col min-h-0 flex-1">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2 px-2 shrink-0">
        {/* Stop selector */}
        <select
          value={selectedStopId || ''}
          onChange={(e) => selectStop(e.target.value || null)}
          className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral max-w-[250px]"
        >
          <option value="">Select a stop...</option>
          {stopsWithService.map((s) => (
            <option key={s.stop_id} value={s.stop_id}>
              {s.stop_name || s.stop_id}
            </option>
          ))}
        </select>

        {/* Service pattern */}
        {calendars.length > 0 && (
          <select
            value={activeServiceId || ''}
            onChange={(e) => setSelectedServiceId(e.target.value)}
            className="px-2 py-1 border border-sand rounded-md text-xs bg-cream focus:outline-none focus:border-coral"
          >
            {calendars.map((cal) => (
              <option key={cal.service_id} value={cal.service_id}>
                {cal._description || cal.service_id}
              </option>
            ))}
          </select>
        )}

        {/* Sort toggle */}
        <div className="flex rounded-md border border-sand overflow-hidden">
          <button
            onClick={() => setSortMode('time')}
            className={`px-3 py-1 text-xs font-semibold transition-colors ${
              sortMode === 'time' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
            }`}
          >
            By Time
          </button>
          <button
            onClick={() => setSortMode('route')}
            className={`px-3 py-1 text-xs font-semibold transition-colors border-l border-sand ${
              sortMode === 'route' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
            }`}
          >
            By Route
          </button>
        </div>

        {/* Arrival/departure toggle */}
        <div className="flex rounded-md border border-sand overflow-hidden">
          <button
            onClick={() => setTimeField('departure')}
            className={`px-2 py-1 text-xs font-semibold transition-colors ${
              timeField === 'departure' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
            }`}
          >
            Dep
          </button>
          <button
            onClick={() => setTimeField('arrival')}
            className={`px-2 py-1 text-xs font-semibold transition-colors border-l border-sand ${
              timeField === 'arrival' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
            }`}
          >
            Arr
          </button>
        </div>

        {/* Visible/all routes toggle */}
        <label className="flex items-center gap-1.5 text-xs text-warm-gray whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={showAllRoutes}
            onChange={(e) => setShowAllRoutes(e.target.checked)}
            className="accent-coral"
          />
          All routes
        </label>

        {stats && (
          <span className="text-xs text-warm-gray whitespace-nowrap">
            {stats.totalDepartures} departures ({stats.routeCount} route{stats.routeCount !== 1 ? 's' : ''}) &middot; {stats.firstDeparture}&ndash;{stats.lastDeparture}
          </span>
        )}
      </div>

      {/* Departures list */}
      {!selectedStopId ? (
        <div className="flex items-center justify-center flex-1 text-warm-gray text-sm">
          Select a stop to view departures
        </div>
      ) : departures.length === 0 ? (
        <div className="flex items-center justify-center flex-1 text-warm-gray text-sm">
          No departures for {selectedStop?.stop_name || 'this stop'} on this service pattern
        </div>
      ) : (
        <div className="overflow-auto flex-1 min-h-0">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="sticky top-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand">
                  {timeField === 'departure' ? 'Departure' : 'Arrival'}
                </th>
                <th className="sticky top-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand">
                  Route
                </th>
                <th className="sticky top-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand">
                  Direction
                </th>
                <th className="sticky top-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand">
                  Trip
                </th>
              </tr>
            </thead>
            <tbody>
              {departures.map((dep, i) => {
                // Highlight gaps > 30 min between consecutive departures (sorted by time)
                const prevDep = i > 0 && sortMode === 'time' ? departures[i - 1] : null;
                const hasGap = prevDep && dep.timeSortKey > prevDep.timeSortKey &&
                  (parseTimeToMinutes(dep.timeSortKey) - parseTimeToMinutes(prevDep.timeSortKey)) > 30;

                return (
                  <tr
                    key={`${dep.tripId}-${i}`}
                    className={`hover:bg-cream ${hasGap ? 'border-t-2 border-amber-200' : ''}`}
                  >
                    <td className="px-3 py-1.5 font-mono tabular-nums text-dark-brown border-b border-[#F5F0EB] font-medium">
                      {dep.time}
                    </td>
                    <td className="px-3 py-1.5 border-b border-[#F5F0EB]">
                      <span className="flex items-center gap-1.5">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 inline-block"
                          style={{ backgroundColor: `#${dep.routeColor}` }}
                        />
                        <span className="text-dark-brown font-medium">{dep.routeName}</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-warm-gray border-b border-[#F5F0EB]">
                      {dep.direction}
                    </td>
                    <td className="px-3 py-1.5 text-warm-gray border-b border-[#F5F0EB] font-mono text-[11px]">
                      {dep.tripId}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function parseTimeToMinutes(gtfsTime: string): number {
  const parts = gtfsTime.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}
