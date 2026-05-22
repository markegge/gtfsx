import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES, directionName } from '../../utils/constants';
import type { Stop } from '../../types/gtfs';

type DirectionFilter = 'both' | 0 | 1;

// Sentinel route-filter value: stops not assigned to any route.
const UNASSIGNED = '__unassigned__';

/**
 * Global Stops inventory. Lists every stop in the feed with optional filters
 * by route, direction, calendar service_id, wheelchair boarding, and location
 * type. Selecting a row opens the stop in the dedicated edit sub-panel
 * (see StopEditPanel / RightRail StopEditHeader) — this component does not
 * render the property editor inline.
 *
 * Per-route stop *assignment* (placement, ordering, adding/removing) lives in
 * a route's own Stops tab.
 */
export function StopList() {
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const calendars = useStore((s) => s.calendars);
  const setEditingStopId = useStore((s) => s.setEditingStopId);
  const setCreatingStop = useStore((s) => s.setCreatingStop);
  const selectStop = useStore((s) => s.selectStop);
  const setMapStopFilter = useStore((s) => s.setMapStopFilter);
  const removeStop = useStore((s) => s.removeStop);

  const [routeFilter, setRouteFilter] = useState<string>('');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('both');
  const [serviceFilter, setServiceFilter] = useState<string>('');
  // -1 means "Any" for the integer-enum filters.
  const [wheelchairFilter, setWheelchairFilter] = useState<number>(-1);
  const [locationTypeFilter, setLocationTypeFilter] = useState<number>(-1);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // True only when a real route is selected (not "All" or "Unassigned").
  const routeSelected = !!routeFilter && routeFilter !== UNASSIGNED;

  // Direction/service filters only make sense scoped to a route.
  const effectiveDirection: DirectionFilter = routeSelected ? directionFilter : 'both';
  const effectiveService = routeSelected ? serviceFilter : '';

  const selectedRoute = routeSelected ? routes.find((r) => r.route_id === routeFilter) : null;

  const filteredStops = useMemo<Stop[]>(() => {
    let pool = stops;

    if (routeFilter === UNASSIGNED) {
      const assignedIds = new Set(routeStops.map((rs) => rs.stop_id));
      pool = pool.filter((s) => !assignedIds.has(s.stop_id));
    } else if (routeFilter) {
      const assignedIds = new Set<string>();
      for (const rs of routeStops) {
        if (rs.route_id !== routeFilter) continue;
        if (effectiveDirection !== 'both' && rs.direction_id !== effectiveDirection) continue;
        assignedIds.add(rs.stop_id);
      }
      pool = pool.filter((s) => assignedIds.has(s.stop_id));

      if (effectiveService) {
        const matchingTripIds = new Set<string>();
        for (const t of trips) {
          if (t.route_id !== routeFilter) continue;
          if (t.service_id !== effectiveService) continue;
          if (effectiveDirection !== 'both' && t.direction_id !== effectiveDirection) continue;
          matchingTripIds.add(t.trip_id);
        }
        const servicedIds = new Set<string>();
        for (const st of stopTimes) {
          if (matchingTripIds.has(st.trip_id)) servicedIds.add(st.stop_id);
        }
        pool = pool.filter((s) => servicedIds.has(s.stop_id));
      }
    }

    if (wheelchairFilter >= 0) {
      pool = pool.filter((s) => s.wheelchair_boarding === wheelchairFilter);
    }
    if (locationTypeFilter >= 0) {
      pool = pool.filter((s) => s.location_type === locationTypeFilter);
    }

    return pool;
  }, [
    stops, routeFilter, effectiveDirection, effectiveService,
    routeStops, trips, stopTimes,
    wheelchairFilter, locationTypeFilter,
  ]);

  const sortedStops = useMemo(
    () => [...filteredStops].sort(
      (a, b) => (a.stop_name || a.stop_id).localeCompare(b.stop_name || b.stop_id),
    ),
    [filteredStops],
  );

  // Filters at their defaults mean "show everything" — no need to overlay
  // the map. Anything else writes the matched stop_ids to the store so the
  // StopLayer can fade non-matches.
  const filtersActive =
    !!routeFilter
    || wheelchairFilter >= 0
    || locationTypeFilter >= 0;

  useEffect(() => {
    if (filtersActive) {
      setMapStopFilter({ matched: filteredStops.map((s) => s.stop_id) });
    } else {
      setMapStopFilter(null);
    }
  }, [filtersActive, filteredStops, setMapStopFilter]);

  // Drop the overlay when the panel unmounts (section change, rail close).
  useEffect(() => () => setMapStopFilter(null), [setMapStopFilter]);

  // Any change to which stops are shown invalidates a pending delete confirm,
  // so route every filter mutation through these wrappers.
  const changeRouteFilter = (value: string) => {
    setRouteFilter(value);
    setServiceFilter('');
    setConfirmingDelete(false);
  };
  const changeDirectionFilter = (value: DirectionFilter) => {
    setDirectionFilter(value);
    setConfirmingDelete(false);
  };
  const changeServiceFilter = (value: string) => {
    setServiceFilter(value);
    setConfirmingDelete(false);
  };
  const changeWheelchairFilter = (value: number) => {
    setWheelchairFilter(value);
    setConfirmingDelete(false);
  };
  const changeLocationTypeFilter = (value: number) => {
    setLocationTypeFilter(value);
    setConfirmingDelete(false);
  };

  const clearFilters = () => {
    setRouteFilter('');
    setDirectionFilter('both');
    setServiceFilter('');
    setWheelchairFilter(-1);
    setLocationTypeFilter(-1);
    setConfirmingDelete(false);
  };

  const deleteAllShown = () => {
    // Snapshot ids first — removeStop mutates the store and cascades into
    // stop_times / route_stops / transfers per stop.
    const ids = sortedStops.map((s) => s.stop_id);
    for (const id of ids) removeStop(id);
    setConfirmingDelete(false);
    setEditingStopId(null);
  };

  const openStopEditor = (stopId: string) => {
    setEditingStopId(stopId);
    selectStop(stopId);
    const stop = stops.find((s) => s.stop_id === stopId);
    const flyTo = (window as { __mapFlyTo?: (lng: number, lat: number) => void }).__mapFlyTo;
    if (stop && flyTo) flyTo(stop.stop_lon, stop.stop_lat);
  };

  const availableServiceIds = useMemo(() => {
    if (!routeFilter) return [] as string[];
    const ids = new Set<string>();
    for (const t of trips) {
      if (t.route_id !== routeFilter) continue;
      if (effectiveDirection !== 'both' && t.direction_id !== effectiveDirection) continue;
      ids.add(t.service_id);
    }
    return [...ids].sort();
  }, [trips, routeFilter, effectiveDirection]);

  return (
    <div>
      <button
        onClick={() => setCreatingStop(true)}
        className="w-full mb-3 px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors"
      >
        + Create new stop
      </button>

      <div className="mb-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
            Filters
          </span>
          {filtersActive && (
            <button
              onClick={clearFilters}
              className="text-[11px] font-semibold text-coral hover:text-[#d4603a] transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Route
          </label>
          <div className="flex items-center gap-2">
            {selectedRoute && (
              <span
                className="w-3.5 h-3.5 rounded shrink-0"
                style={{ background: `#${selectedRoute.route_color}` }}
                aria-hidden
              />
            )}
            <select
              value={routeFilter}
              onChange={(e) => changeRouteFilter(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">All stops</option>
              <option value={UNASSIGNED}>Unassigned stops</option>
              {routes.map((r) => (
                <option key={r.route_id} value={r.route_id}>
                  {r.route_short_name || r.route_long_name || 'Untitled Route'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {routeSelected && (
          <>
            <div>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                Direction
              </label>
              <div className="flex rounded-md border border-sand overflow-hidden">
                {(['both', 0, 1] as const).map((d) => (
                  <button
                    key={String(d)}
                    onClick={() => changeDirectionFilter(d)}
                    className={`flex-1 px-2 py-1.5 text-xs font-semibold transition-colors
                      ${directionFilter === d ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}
                      ${d !== 'both' ? 'border-l border-sand' : ''}`}
                  >
                    {d === 'both' ? 'Both' : directionName(selectedRoute, d)}
                  </button>
                ))}
              </div>
            </div>

            {availableServiceIds.length > 0 && (
              <div>
                <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                  Service pattern
                </label>
                <select
                  value={serviceFilter}
                  onChange={(e) => changeServiceFilter(e.target.value)}
                  className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
                >
                  <option value="">Any service</option>
                  {availableServiceIds.map((sid) => {
                    const cal = calendars.find((c) => c.service_id === sid);
                    const label = cal
                      ? [
                          cal.monday && 'Mo',
                          cal.tuesday && 'Tu',
                          cal.wednesday && 'We',
                          cal.thursday && 'Th',
                          cal.friday && 'Fr',
                          cal.saturday && 'Sa',
                          cal.sunday && 'Su',
                        ].filter(Boolean).join(' ')
                      : '';
                    return (
                      <option key={sid} value={sid}>
                        {sid}{label ? ` — ${label}` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
          </>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Wheelchair
            </label>
            <select
              value={wheelchairFilter}
              onChange={(e) => changeWheelchairFilter(Number(e.target.value))}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value={-1}>Any</option>
              {Object.entries(WHEELCHAIR_BOARDING).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Location type
            </label>
            <select
              value={locationTypeFilter}
              onChange={(e) => changeLocationTypeFilter(Number(e.target.value))}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value={-1}>Any</option>
              {Object.entries(LOCATION_TYPES).map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {sortedStops.length === 0 ? (
        <EmptyState
          icon="🚏"
          title={stops.length === 0 ? 'No stops in this feed' : 'No stops match these filters'}
          description={stops.length === 0
            ? 'Stops are added from a route\'s Stops tab — open Routes, edit a route, and place stops along it.'
            : 'Loosen the filters above to see more stops.'}
        />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Stops ({sortedStops.length}{stops.length !== sortedStops.length ? ` of ${stops.length}` : ''})
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {sortedStops.map((stop) => (
              <button
                key={stop.stop_id}
                onClick={() => openStopEditor(stop.stop_id)}
                className="flex items-center gap-2 w-full px-2 py-1.5 rounded-lg transition-colors text-left hover:bg-cream group"
              >
                <div
                  className="w-2.5 h-2.5 rounded-full border-2 shrink-0"
                  style={{ borderColor: '#E8734A', backgroundColor: 'white' }}
                />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-xs font-medium text-dark-brown truncate">
                    {stop.stop_name || 'Unnamed Stop'}
                  </span>
                  {stop.stop_code && (
                    <span className="text-[10px] text-warm-gray">Code: {stop.stop_code}</span>
                  )}
                </div>
                <span className="text-[10px] text-warm-gray opacity-0 group-hover:opacity-100 transition-opacity">
                  Edit →
                </span>
              </button>
            ))}
          </div>

          <div className="mt-3 pt-3 border-t border-sand">
            {confirmingDelete ? (
              <div className="flex flex-col gap-2">
                <p className="text-[11px] text-warm-gray">
                  Delete {sortedStops.length} shown stop{sortedStops.length === 1 ? '' : 's'}?
                  This also removes their stop times, route placements, and transfers.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={deleteAllShown}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors"
                  >
                    Delete {sortedStops.length}
                  </button>
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-sand text-warm-gray hover:text-dark-brown transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-[11px] font-semibold text-red-600 hover:text-red-700 transition-colors"
              >
                Delete all shown stops
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
