import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { FormField } from '../ui/FormField';
import { WHEELCHAIR_BOARDING, LOCATION_TYPES, directionName } from '../../utils/constants';
import type { Stop } from '../../types/gtfs';

type DirectionFilter = 'both' | 0 | 1;

/**
 * Global Stops inventory. Lists every stop in the feed with optional filters
 * by route, direction, and calendar service_id. Selecting a row expands the
 * stop-property editor inline. Per-route stop assignment (placement, ordering,
 * adding/removing) now lives in the route's own Stops tab — this panel does
 * not place stops on a route.
 */
export function StopList() {
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const calendars = useStore((s) => s.calendars);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectStop = useStore((s) => s.selectStop);
  const updateStop = useStore((s) => s.updateStop);
  const removeStop = useStore((s) => s.removeStop);
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);

  const [routeFilter, setRouteFilter] = useState<string>('');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('both');
  const [serviceFilter, setServiceFilter] = useState<string>('');

  // Clear direction/service filters when the route is cleared — they only make
  // sense scoped to a route.
  const effectiveDirection: DirectionFilter = routeFilter ? directionFilter : 'both';
  const effectiveService = routeFilter ? serviceFilter : '';

  const selectedRoute = routeFilter ? routes.find((r) => r.route_id === routeFilter) : null;

  // Compute the set of stop_ids matching the active filters.
  const filteredStops = useMemo<Stop[]>(() => {
    if (!routeFilter) return stops;

    // Stops assigned to this route+direction via route_stops.
    const assignedStopIds = new Set<string>();
    for (const rs of routeStops) {
      if (rs.route_id !== routeFilter) continue;
      if (effectiveDirection !== 'both' && rs.direction_id !== effectiveDirection) continue;
      assignedStopIds.add(rs.stop_id);
    }

    if (!effectiveService) {
      return stops.filter((s) => assignedStopIds.has(s.stop_id));
    }

    // Service-pattern filter: keep only stops that have a stop_time on a trip
    // belonging to this route+direction(s) AND the selected service_id.
    const matchingTripIds = new Set<string>();
    for (const t of trips) {
      if (t.route_id !== routeFilter) continue;
      if (t.service_id !== effectiveService) continue;
      if (effectiveDirection !== 'both' && t.direction_id !== effectiveDirection) continue;
      matchingTripIds.add(t.trip_id);
    }
    const servicedStopIds = new Set<string>();
    for (const st of stopTimes) {
      if (matchingTripIds.has(st.trip_id)) servicedStopIds.add(st.stop_id);
    }
    return stops.filter(
      (s) => assignedStopIds.has(s.stop_id) && servicedStopIds.has(s.stop_id),
    );
  }, [stops, routeFilter, effectiveDirection, effectiveService, routeStops, trips, stopTimes]);

  // Sort filtered list by name for browsing predictability.
  const sortedStops = useMemo(
    () => [...filteredStops].sort(
      (a, b) => (a.stop_name || a.stop_id).localeCompare(b.stop_name || b.stop_id),
    ),
    [filteredStops],
  );

  const selectedStop = selectedStopId
    ? stops.find((s) => s.stop_id === selectedStopId)
    : null;

  const handleSelect = (stopId: string) => {
    selectStop(stopId === selectedStopId ? null : stopId);
    const stop = stops.find((s) => s.stop_id === stopId);
    const flyTo = (window as { __mapFlyTo?: (lng: number, lat: number) => void }).__mapFlyTo;
    if (stop && flyTo) flyTo(stop.stop_lon, stop.stop_lat);
  };

  // Direction/service-id options are only meaningful when a route is picked,
  // but it's still useful for the user to know what services exist feed-wide.
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
      <div className="mb-3 space-y-2">
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
              onChange={(e) => {
                setRouteFilter(e.target.value);
                // Reset dependent filters when the route changes.
                setServiceFilter('');
              }}
              className="flex-1 min-w-0 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">All stops in feed</option>
              {routes.map((r) => (
                <option key={r.route_id} value={r.route_id}>
                  {r.route_short_name || r.route_long_name || 'Untitled Route'}
                </option>
              ))}
            </select>
          </div>
        </div>

        {routeFilter && (
          <>
            <div>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                Direction
              </label>
              <div className="flex rounded-md border border-sand overflow-hidden">
                {(['both', 0, 1] as const).map((d) => (
                  <button
                    key={String(d)}
                    onClick={() => setDirectionFilter(d)}
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
                  onChange={(e) => setServiceFilter(e.target.value)}
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
      </div>

      {/* Stop list */}
      {sortedStops.length === 0 ? (
        <EmptyState
          icon="🚏"
          title={stops.length === 0 ? 'No stops in this feed' : 'No stops match these filters'}
          description={stops.length === 0
            ? 'Stops are added to the feed from a route\'s Stops tab — open Routes, edit a route, and place stops along it.'
            : 'Loosen the filters above, or open the route\'s Stops tab to add stops to this route + direction.'}
        />
      ) : (
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Stops ({sortedStops.length}{stops.length !== sortedStops.length ? ` of ${stops.length}` : ''})
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {sortedStops.map((stop) => {
              const isSelected = selectedStopId === stop.stop_id;
              return (
                <div key={stop.stop_id}>
                  <button
                    onClick={() => handleSelect(stop.stop_id)}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-lg transition-colors text-left
                      ${isSelected ? 'bg-sand' : 'hover:bg-cream'}`}
                  >
                    <div
                      className="w-2.5 h-2.5 rounded-full border-2 shrink-0"
                      style={{
                        borderColor: '#E8734A',
                        backgroundColor: isSelected ? '#E8734A' : 'white',
                      }}
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="text-xs font-medium text-dark-brown truncate">
                        {stop.stop_name || 'Unnamed Stop'}
                      </span>
                      {stop.stop_code && (
                        <span className="text-[10px] text-warm-gray">Code: {stop.stop_code}</span>
                      )}
                    </div>
                  </button>

                  {/* Inline stop-property editor for the selected row */}
                  {isSelected && (
                    <div className="mt-2 mb-3 ml-1 pl-3 border-l-2 border-coral/40">
                      <FormField
                        label="Stop Name"
                        value={stop.stop_name}
                        onChange={(v) => updateStop(stop.stop_id, { stop_name: v })}
                        placeholder="e.g., Main St & 1st Ave"
                        required
                      />
                      <FormField
                        label="Stop Code"
                        value={stop.stop_code || ''}
                        onChange={(v) => updateStop(stop.stop_id, { stop_code: v })}
                        placeholder="Rider-facing code"
                      />
                      <FormField
                        label="Description"
                        value={stop.stop_desc || ''}
                        onChange={(v) => updateStop(stop.stop_id, { stop_desc: v })}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <FormField
                          label="Latitude"
                          value={String(stop.stop_lat)}
                          onChange={(v) => updateStop(stop.stop_id, { stop_lat: Number(v) })}
                          type="number"
                        />
                        <FormField
                          label="Longitude"
                          value={String(stop.stop_lon)}
                          onChange={(v) => updateStop(stop.stop_id, { stop_lon: Number(v) })}
                          type="number"
                        />
                      </div>

                      <button
                        onClick={() => setMapMode(mapMode === 'move_stop' ? 'select' : 'move_stop')}
                        className={`w-full mb-1 px-4 py-2 rounded-lg font-heading font-bold text-sm transition-colors
                          ${mapMode === 'move_stop'
                            ? 'bg-coral text-white hover:opacity-90'
                            : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
                          }`}
                      >
                        {mapMode === 'move_stop' ? '✓ Save Location' : 'Move Stop Location'}
                      </button>
                      {mapMode === 'move_stop' && (
                        <p className="text-[11px] text-warm-gray mb-3 px-1">
                          Drag the stop on the map, or click a new location. Your changes save automatically — press Save Location when you're done.
                        </p>
                      )}

                      <div className="mb-3">
                        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                          Wheelchair Boarding
                        </label>
                        <select
                          value={stop.wheelchair_boarding}
                          onChange={(e) => updateStop(stop.stop_id, { wheelchair_boarding: Number(e.target.value) })}
                          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
                        >
                          {Object.entries(WHEELCHAIR_BOARDING).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                      </div>

                      <div className="mb-3">
                        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                          Location Type
                        </label>
                        <select
                          value={stop.location_type}
                          onChange={(e) => updateStop(stop.stop_id, { location_type: Number(e.target.value) })}
                          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
                        >
                          {Object.entries(LOCATION_TYPES).map(([val, label]) => (
                            <option key={val} value={val}>{label}</option>
                          ))}
                        </select>
                      </div>

                      <button
                        onClick={() => {
                          removeStop(stop.stop_id);
                          selectStop(null);
                        }}
                        className="text-xs text-red-400 hover:text-red-600"
                      >
                        Delete stop
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* If a stop is selected but no longer in the filtered list, surface its
          editor at the bottom so the user can still see / edit it. */}
      {selectedStop && !sortedStops.some((s) => s.stop_id === selectedStop.stop_id) && (
        <div className="mt-4 pt-4 border-t border-sand">
          <h4 className="font-heading font-bold text-sm text-dark-brown mb-2">
            Selected: {selectedStop.stop_name || selectedStop.stop_id}
          </h4>
          <p className="text-[11px] text-warm-gray mb-3">
            This stop isn't in the filtered list above. Clear the filters to bring it back, or edit it below.
          </p>
          <FormField
            label="Stop Name"
            value={selectedStop.stop_name}
            onChange={(v) => updateStop(selectedStop.stop_id, { stop_name: v })}
            required
          />
          <FormField
            label="Latitude"
            value={String(selectedStop.stop_lat)}
            onChange={(v) => updateStop(selectedStop.stop_id, { stop_lat: Number(v) })}
            type="number"
          />
          <FormField
            label="Longitude"
            value={String(selectedStop.stop_lon)}
            onChange={(v) => updateStop(selectedStop.stop_id, { stop_lon: Number(v) })}
            type="number"
          />
        </div>
      )}
    </div>
  );
}
