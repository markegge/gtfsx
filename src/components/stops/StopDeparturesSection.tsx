import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { formatTimeShort, gtfsTimeToSeconds } from '../../utils/time';
import { directionName } from '../../utils/constants';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';

const PEAK_WINDOWS: Array<[number, number]> = [[6 * 3600, 9 * 3600], [15 * 3600, 18 * 3600]];
const OFFPEAK_WINDOWS: Array<[number, number]> = [[10 * 3600, 14 * 3600]];

function medianGapMin(secs: number[], windows: Array<[number, number]>): number | null {
  const gaps: number[] = [];
  for (const [start, end] of windows) {
    const inWin = secs.filter((s) => s >= start && s < end).sort((a, b) => a - b);
    for (let i = 1; i < inWin.length; i++) gaps.push(inWin[i] - inWin[i - 1]);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const m = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
  return med / 60;
}

type SortMode = 'time' | 'route';
type TimeField = 'departure' | 'arrival';

interface Departure {
  time: string;
  timeSortKey: string;
  routeName: string;
  routeColor: string;
  direction: string;
  tripId: string;
}

function parseTimeToMinutes(gtfsTime: string): number {
  const parts = gtfsTime.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

/**
 * Per-stop arrival / departure schedule rendered inside the right-rail
 * StopEditPanel. The bottom-panel "Stops" tab used to host this view; now
 * the table lives next to the stop it describes, so the user doesn't have
 * to bounce between two panels. The stop is implicit (the stop being
 * edited) so this surface has no stop picker — just service / sort /
 * dep-or-arr / all-routes controls.
 */
export function StopDeparturesSection() {
  const editingStopId = useStore((s) => s.editingStopId);
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const calendars = useStore((s) => s.calendars);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  const { byTrip: stopTimesByTrip, byStop: stopTimesByStop } = useStopTimesIndex();

  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [timeField, setTimeField] = useState<TimeField>('departure');

  const hiddenRouteSet = useMemo(() => new Set(hiddenRouteIds), [hiddenRouteIds]);

  const activeServiceId = useMemo(() => {
    if (selectedServiceId && calendars.some((c) => c.service_id === selectedServiceId)) return selectedServiceId;
    return calendars[0]?.service_id || null;
  }, [selectedServiceId, calendars]);

  const departures = useMemo<Departure[]>(() => {
    if (!editingStopId) return [];

    const deps: Departure[] = [];
    const tripFirstLast = new Map<string, { first: number; last: number }>();
    for (const [tripId, tripSTs] of stopTimesByTrip) {
      let first = Infinity;
      let last = -Infinity;
      for (const st of tripSTs) {
        if (st.stop_sequence < first) first = st.stop_sequence;
        if (st.stop_sequence > last) last = st.stop_sequence;
      }
      if (first !== Infinity) tripFirstLast.set(tripId, { first, last });
    }

    const relevant = (stopTimesByStop.get(editingStopId) || [])
      .filter((st) => !!(st.arrival_time || st.departure_time));
    for (const st of relevant) {
      const trip = trips.find((t) => t.trip_id === st.trip_id);
      if (!trip) continue;
      if (activeServiceId && trip.service_id !== activeServiceId) continue;
      const route = routes.find((r) => r.route_id === trip.route_id);
      if (!route) continue;
      if (!showAllRoutes && hiddenRouteSet.has(route.route_id)) continue;

      const fl = tripFirstLast.get(st.trip_id);
      const isFirstStop = fl && st.stop_sequence === fl.first;
      const isLastStop = fl && st.stop_sequence === fl.last;

      let timeValue: string;
      if (timeField === 'departure') {
        if (isLastStop) continue;
        timeValue = st.departure_time || st.arrival_time;
      } else {
        if (isFirstStop) continue;
        timeValue = st.arrival_time || st.departure_time;
      }
      if (!timeValue) continue;

      deps.push({
        time: formatTimeShort(timeValue),
        timeSortKey: timeValue,
        routeName: route.route_short_name || route.route_long_name || route.route_id,
        routeColor: route.route_color,
        direction: directionName(route, trip.direction_id),
        tripId: trip.trip_id,
      });
    }

    if (sortMode === 'time') {
      deps.sort((a, b) => a.timeSortKey.localeCompare(b.timeSortKey));
    } else {
      deps.sort((a, b) => a.routeName.localeCompare(b.routeName) || a.timeSortKey.localeCompare(b.timeSortKey));
    }
    return deps;
  }, [editingStopId, stopTimesByTrip, stopTimesByStop, trips, routes, activeServiceId, sortMode, showAllRoutes, hiddenRouteSet, timeField]);

  const stats = useMemo(() => {
    if (departures.length < 2) return null;
    const routeGroups = new Map<string, number>();
    const tripIds = new Set<string>();
    const secs: number[] = [];
    for (const d of departures) {
      routeGroups.set(d.routeName, (routeGroups.get(d.routeName) || 0) + 1);
      tripIds.add(d.tripId);
      secs.push(gtfsTimeToSeconds(d.timeSortKey));
    }
    // Sort ascending for a clean first/last regardless of the table's sort mode.
    const sortedTimes = [...departures].sort((a, b) => a.timeSortKey.localeCompare(b.timeSortKey));
    return {
      total: departures.length,
      tripsPerDay: tripIds.size,
      routeCount: routeGroups.size,
      first: sortedTimes[0]?.time,
      last: sortedTimes[sortedTimes.length - 1]?.time,
      headwayPeak: medianGapMin(secs, PEAK_WINDOWS),
      headwayOffpeak: medianGapMin(secs, OFFPEAK_WINDOWS),
    };
  }, [departures]);

  if (!editingStopId) return null;
  // If the stop has zero stop_times across all services, no point showing
  // the controls — keep the panel compact.
  const hasAnyServiceData = (stopTimesByStop.get(editingStopId) || []).length > 0;

  return (
    <div>
      <h4 className="font-heading font-bold text-sm text-dark-brown mb-2">
        Trips
      </h4>

      {!hasAnyServiceData ? (
        <p className="text-xs text-warm-gray">
          No trips currently include this stop. Add the stop to a route and build a timetable to see departures here.
        </p>
      ) : (
        <>
          {/* Compact controls — stacked rows so they fit a ~460px rail. */}
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {calendars.length > 0 && (
              <select
                value={activeServiceId || ''}
                onChange={(e) => setSelectedServiceId(e.target.value)}
                className="px-2 py-1 border border-sand rounded-md text-[11px] bg-cream focus:outline-none focus:border-coral min-w-0 flex-1"
              >
                {calendars.map((cal) => (
                  <option key={cal.service_id} value={cal.service_id}>
                    {cal._description || cal.service_id}
                  </option>
                ))}
              </select>
            )}
            <div className="flex rounded-md border border-sand overflow-hidden">
              <button
                onClick={() => setSortMode('time')}
                className={`px-2 py-1 text-[11px] font-semibold transition-colors ${
                  sortMode === 'time' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
                }`}
              >Time</button>
              <button
                onClick={() => setSortMode('route')}
                className={`px-2 py-1 text-[11px] font-semibold transition-colors border-l border-sand ${
                  sortMode === 'route' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
                }`}
              >Route</button>
            </div>
            <div className="flex rounded-md border border-sand overflow-hidden">
              <button
                onClick={() => setTimeField('departure')}
                className={`px-2 py-1 text-[11px] font-semibold transition-colors ${
                  timeField === 'departure' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
                }`}
              >Dep</button>
              <button
                onClick={() => setTimeField('arrival')}
                className={`px-2 py-1 text-[11px] font-semibold transition-colors border-l border-sand ${
                  timeField === 'arrival' ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'
                }`}
              >Arr</button>
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-warm-gray mb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showAllRoutes}
              onChange={(e) => setShowAllRoutes(e.target.checked)}
              className="accent-coral"
            />
            Show hidden routes
          </label>

          {stats && (
            <div className="mb-2 space-y-0.5">
              <p className="text-[11px] text-warm-gray">
                {stats.total} departure{stats.total === 1 ? '' : 's'} · {stats.tripsPerDay} trips/day across {stats.routeCount} route{stats.routeCount === 1 ? '' : 's'} · {stats.first}–{stats.last}
              </p>
              <p className="text-[11px] text-warm-gray">
                Headway — peak {stats.headwayPeak == null ? '—' : `~${Math.round(stats.headwayPeak)} min`} · off-peak {stats.headwayOffpeak == null ? '—' : `~${Math.round(stats.headwayOffpeak)} min`}
              </p>
            </div>
          )}

          {departures.length === 0 ? (
            <p className="text-xs text-warm-gray italic">
              No departures match the selected service / route filters.
            </p>
          ) : (
            <div className="border border-sand rounded-lg overflow-hidden">
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="bg-cream text-warm-gray uppercase tracking-wide">
                    <th className="px-2 py-1.5 text-left font-semibold">{timeField === 'departure' ? 'Dep' : 'Arr'}</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Route</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Direction</th>
                  </tr>
                </thead>
                <tbody>
                  {departures.map((dep, i) => {
                    const prev = i > 0 && sortMode === 'time' ? departures[i - 1] : null;
                    const hasGap = prev && dep.timeSortKey > prev.timeSortKey
                      && (parseTimeToMinutes(dep.timeSortKey) - parseTimeToMinutes(prev.timeSortKey)) > 30;
                    return (
                      <tr
                        key={`${dep.tripId}-${i}`}
                        className={`${i % 2 === 0 ? '' : 'bg-cream/50'} ${hasGap ? 'border-t-2 border-amber-200' : ''}`}
                      >
                        <td className="px-2 py-1 font-mono tabular-nums text-dark-brown">{dep.time}</td>
                        <td className="px-2 py-1">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="w-2 h-2 rounded-full shrink-0 inline-block"
                              style={{ backgroundColor: `#${dep.routeColor}` }}
                            />
                            <span className="text-dark-brown truncate">{dep.routeName}</span>
                          </span>
                        </td>
                        <td className="px-2 py-1 text-warm-gray truncate">{dep.direction}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
