import { type KeyboardEvent, useEffect, useMemo, useCallback, useState, useRef } from 'react';
import { useStore } from '../../store';
import { ensureDefaultCalendar } from '../../services/defaultCalendar';
import { formatTimeShort, normalizeTimeInput, gtfsTimeToSeconds, secondsToGtfsTime } from '../../utils/time';
import { directionName } from '../../utils/constants';
import { PatternSelector } from '../ui/ShapePatternSelector';
import { computeShapePatterns } from '../ui/shapePatterns';
import type { Route, StopTime } from '../../types/gtfs';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { estimateStopTravelSeconds, layoutStopTimes } from '../../services/travelTime';

function generateTripName(routeName: string, departureTime: string, serviceIndex: number): string {
  const prefix = (routeName || 'trip').replace(/\s+/g, '').slice(0, 4).toLowerCase();
  if (!departureTime) return `${serviceIndex}${prefix}`;
  const parts = departureTime.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  return `${serviceIndex}${prefix}${h}${String(m).padStart(2, '0')}`;
}

const cellKey = (tripIdx: number, stopIdx: number) => `${tripIdx}-${stopIdx}`;

/** Get the 1-based index of a service_id in the calendars list */
function getServiceIndex(serviceId: string, calendars: { service_id: string }[]): number {
  const idx = calendars.findIndex((c) => c.service_id === serviceId);
  return idx >= 0 ? idx + 1 : 1;
}

/** Generate a unique trip ID, appending suffix if needed */
function uniqueTripId(baseId: string, existingIds: Set<string>): string {
  if (!existingIds.has(baseId)) return baseId;
  let suffix = 2;
  while (existingIds.has(`${baseId}-${suffix}`)) suffix++;
  return `${baseId}-${suffix}`;
}

export function TimetableGrid() {
  const {
    selectedRouteId, selectRoute, routes, trips, stops, routeStops, calendars, shapes,
    setStopTime, addTrip, duplicateTrip, applyTripPattern, removeTrip, updateTrip, renameTripId,
    interpolateStopTimes,
  } = useStore();
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();

  const route = routes.find((r) => r.route_id === selectedRouteId);

  // Direction toggle state — synced to store so RouteLayer can read it
  const directionId = useStore((s) => s.timetableDirectionId);
  const setDirectionId = useStore((s) => s.setTimetableDirectionId);

  // Advanced: when true, every stop cell shows two inputs (arr / dep) so
  // dwell time can be authored. Persisted in the UI slice.
  const splitArrDep = useStore((s) => s.timetableSplitArrDep);
  const setSplitArrDep = useStore((s) => s.setTimetableSplitArrDep);

  // Service pattern selector — lives in the store so cross-panel handlers
  // (Calendars > Routes > "View timetable") can switch the timetable to the
  // calendar the user just clicked. null falls back to the first calendar.
  const selectedServiceId = useStore((s) => s.timetableServiceId);
  const setSelectedServiceId = useStore((s) => s.setTimetableServiceId);
  // Trip-pattern (shape) selector — only meaningful when the route has 3+
  // distinct shape_ids. The legacy direction toggle still drives ≤2-shape
  // routes via timetableDirectionId.
  const selectedShapeId = useStore((s) => s.timetableShapeId);
  const setSelectedShapeId = useStore((s) => s.setTimetableShapeId);

  // Safety net: a user who somehow lands on the timetable with no calendars
  // gets one auto-created. The primary path (draw_route's finishDrawing)
  // already materializes a Default Calendar via the same helper, so this
  // mostly fires on imported feeds with zero calendars or as defensive
  // coverage if the route-create path is bypassed.
  useEffect(() => {
    if (calendars.length > 0) return;
    if (!selectedRouteId || routes.length === 0) return;
    ensureDefaultCalendar();
  }, [calendars.length, selectedRouteId, routes.length]);

  // Active service pattern — allow any calendar, default to first
  const activeServiceId = useMemo(() => {
    if (selectedServiceId && calendars.some((c) => c.service_id === selectedServiceId)) return selectedServiceId;
    return calendars[0]?.service_id || null;
  }, [selectedServiceId, calendars]);

  // Trip-pattern selector contents. Each pattern is a unique non-empty
  // shape_id used by this route's trips, tagged with its trips' direction_id
  // (read from the first trip — trips on the same shape generally share a
  // direction). Sorted by direction (0/outbound first) then shape_id.
  //
  // The selector UI adapts to the count, per Mark's spec:
  //   1 pattern  → render the pattern name as a static label (no toggle)
  //   2 patterns → render the legacy two-button toggle (current behaviour)
  //   3+ patterns → render a dropdown
  //
  // A route with 0 shapes (e.g. trips with empty shape_id) falls back to the
  // legacy direction-only toggle so we keep authoring useful for in-progress
  // feeds before a shape exists.
  const patterns = useMemo(
    () => computeShapePatterns(selectedRouteId, trips),
    [selectedRouteId, trips],
  );

  // When the route changes or the pattern list updates, sync the store's
  // selected shape to a valid entry. Three behaviours:
  //   - patterns.length <= 2: clear the shape filter (legacy toggle handles
  //     filtering via direction_id alone — same-direction-only-2-shape edge
  //     case is rare; if it bites, bump to 3+ logic later).
  //   - patterns.length >= 3 AND no current selection / stale selection:
  //     auto-pick the first pattern, AND set directionId so the existing
  //     stop-ordering / route_stops filtering keeps working.
  useEffect(() => {
    if (patterns.length === 0) {
      if (selectedShapeId !== null) setSelectedShapeId(null);
      return;
    }
    // Any route with shapes drives the timetable off the selected shape (one
    // dropdown entry per shape), so a stale/empty selection picks the first
    // and syncs directionId for route_stops + the map highlight.
    const current = patterns.find((p) => p.shapeId === selectedShapeId);
    if (!current) {
      const first = patterns[0];
      setSelectedShapeId(first.shapeId);
      if (first.directionId !== directionId) setDirectionId(first.directionId);
    }
    // Only re-run when the route or patterns list actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRouteId, patterns]);

  // Service patterns that have trips for this route+direction (for "copy from" feature)
  const serviceIdsWithTrips = useMemo(() => {
    if (!selectedRouteId) return [];
    return [...new Set(
      trips
        .filter((t) => t.route_id === selectedRouteId && t.direction_id === directionId)
        .map((t) => t.service_id)
    )];
  }, [selectedRouteId, trips, directionId]);

  // Repeat-every form state
  const [showRepeatForm, setShowRepeatForm] = useState(false);
  const [repeatHeadway, setRepeatHeadway] = useState(15);
  const [repeatCopies, setRepeatCopies] = useState(5);

  // Duplicate trip prompt state
  const [dupPrompt, setDupPrompt] = useState<{ tripId: string; defaultStartTime: string } | null>(null);
  const [dupStartTime, setDupStartTime] = useState('');

  // "Apply to all trips" confirm state — holds the template trip id.
  const [applyPrompt, setApplyPrompt] = useState<string | null>(null);

  // "Estimate times" dialog — holds the trip id being timed + its config.
  const [estimatePrompt, setEstimatePrompt] = useState<string | null>(null);
  const [estStart, setEstStart] = useState('08:00');
  const [estDwell, setEstDwell] = useState(18);
  const [estSpeed, setEstSpeed] = useState(1.3);
  const [estimating, setEstimating] = useState(false);
  const [estError, setEstError] = useState<string | null>(null);

  // Ref map for Tab navigation between cells
  const cellRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  // Get ordered stops for this route filtered by direction
  const orderedStops = useMemo(() => {
    if (!selectedRouteId) return [];
    // Columns are the selected shape's own stops (per-shape). Shapeless routes
    // (no shape selected) fall back to direction-keyed stops.
    const list = selectedShapeId
      ? routeStops.filter((rs) => rs.route_id === selectedRouteId && rs.shape_id === selectedShapeId)
      : routeStops.filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === directionId);
    return [...list]
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as typeof stops;
  }, [selectedRouteId, selectedShapeId, directionId, routeStops, stops]);

  // Helper: find a specific stop_time by trip+stop using the byTrip index
  const findStopTime = useCallback((tripId: string, stopId: string): StopTime | undefined => {
    const tripStopTimes = stopTimesByTrip.get(tripId);
    if (!tripStopTimes) return undefined;
    return tripStopTimes.find((st) => st.stop_id === stopId);
  }, [stopTimesByTrip]);

  // Timepoint lookup: set of stop_ids that have timepoint=1 in any stop_time for current route
  const timepointStopIds = useMemo(() => {
    const ids = new Set<string>();
    // Only scan stop_times for trips that belong to this route
    if (selectedRouteId) {
      const routeTripIds = trips
        .filter((t) => t.route_id === selectedRouteId)
        .map((t) => t.trip_id);
      for (const tripId of routeTripIds) {
        const tripSTs = stopTimesByTrip.get(tripId);
        if (tripSTs) {
          for (const st of tripSTs) {
            if (st.timepoint === 1) ids.add(st.stop_id);
          }
        }
      }
    }
    // If no timepoints are explicitly set, treat first and last as timepoints
    if (ids.size === 0 && orderedStops.length >= 2) {
      ids.add(orderedStops[0].stop_id);
      ids.add(orderedStops[orderedStops.length - 1].stop_id);
    }
    return ids;
  }, [stopTimesByTrip, orderedStops, selectedRouteId, trips]);

  // Get trips for this route filtered by direction and service pattern.
  // When a specific shape is selected (3+ pattern case), also filter by
  // shape_id so the same-direction-multiple-shapes scenario picks the
  // right subset.
  const routeTrips = useMemo(() => {
    if (!selectedRouteId) return [];
    return trips
      .filter((t) => t.route_id === selectedRouteId
        && (!activeServiceId || t.service_id === activeServiceId)
        // Filter by the selected shape when there is one (so two shapes sharing
        // a direction don't pile into one view); otherwise by direction.
        && (selectedShapeId ? t.shape_id === selectedShapeId : t.direction_id === directionId))
      .sort((a, b) => {
        // Sort by earliest assigned arrival; trips with no times yet go last.
        const earliest = (tripId: string) => {
          let best = '';
          for (const st of stopTimesByTrip.get(tripId) ?? []) {
            if (st.arrival_time && (!best || st.arrival_time.localeCompare(best) < 0)) {
              best = st.arrival_time;
            }
          }
          return best;
        };
        const aTime = earliest(a.trip_id);
        const bTime = earliest(b.trip_id);
        if (!aTime || !bTime) return (aTime ? 0 : 1) - (bTime ? 0 : 1);
        return aTime.localeCompare(bTime);
      });
  }, [selectedRouteId, trips, stopTimesByTrip, directionId, activeServiceId, selectedShapeId]);

  // Tab key navigation
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>, tripIdx: number, stopIdx: number) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const totalStops = orderedStops.length;
      const totalTrips = routeTrips.length;

      let nextTripIdx = tripIdx;
      let nextStopIdx = stopIdx + (e.shiftKey ? -1 : 1);

      if (nextStopIdx >= totalStops) {
        nextStopIdx = 0;
        nextTripIdx++;
      } else if (nextStopIdx < 0) {
        nextStopIdx = totalStops - 1;
        nextTripIdx--;
      }

      if (nextTripIdx >= 0 && nextTripIdx < totalTrips) {
        const key = cellKey(nextTripIdx, nextStopIdx);
        // Defer focus until after the commit-triggered re-render completes.
        // If the commit renames a `_new` trip, the row's key changes and React
        // unmounts it — focusing the old element synchronously is a no-op.
        // Two rAFs is the reliable way to land after React's effect phase.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el = cellRefs.current.get(key);
            if (el) el.focus();
          });
        });
      }
    }
  }, [orderedStops.length, routeTrips.length]);

  const handleAddTrip = () => {
    if (!selectedRouteId) return;
    const routeName = route?.route_short_name || route?.route_long_name || '';
    const svcIdx = getServiceIndex(activeServiceId || '', calendars);
    const existingIds = new Set(trips.map((t) => t.trip_id));
    const tripId = uniqueTripId(generateTripName(routeName, '', svcIdx) + '_new', existingIds);
    addTrip({
      trip_id: tripId,
      route_id: selectedRouteId,
      service_id: activeServiceId || calendars[0]?.service_id || '',
      direction_id: directionId,
      trip_headsign: route?.route_short_name || '',
      shape_id: selectedShapeId ?? trips.find((t) => t.route_id === selectedRouteId && t.direction_id === directionId)?.shape_id,
    });
  };

  // Find the first displayed (non-blank) time for a trip using the timetable's stop order
  const getFirstDisplayedTime = useCallback((tripId: string) => {
    for (const stop of orderedStops) {
      const st = findStopTime(tripId, stop.stop_id);
      if (st?.arrival_time) return st.arrival_time;
    }
    return '';
  }, [orderedStops, findStopTime]);

  const handleDuplicate = (tripId: string) => {
    const firstTime = getFirstDisplayedTime(tripId);
    const defaultStart = firstTime ? formatTimeShort(secondsToGtfsTime(gtfsTimeToSeconds(firstTime) + 3600)) : '';
    setDupStartTime(defaultStart);
    setDupPrompt({ tripId, defaultStartTime: defaultStart });
  };

  const handleDupConfirm = () => {
    if (!dupPrompt) return;
    const normalized = normalizeTimeInput(dupStartTime);
    if (!normalized) return;
    // Calculate offset from the first displayed stop time
    const firstTime = getFirstDisplayedTime(dupPrompt.tripId);
    const offsetSeconds = gtfsTimeToSeconds(normalized) - gtfsTimeToSeconds(firstTime);
    const offsetMinutes = Math.round(offsetSeconds / 60);
    // Generate a descriptive trip_id
    const routeName = route?.route_short_name || route?.route_long_name || '';
    const srcTrip = trips.find((t) => t.trip_id === dupPrompt.tripId);
    const svcIdx = getServiceIndex(srcTrip?.service_id || activeServiceId || '', calendars);
    const existingIds = new Set(trips.map((t) => t.trip_id));
    const newId = uniqueTripId(generateTripName(routeName, normalized, svcIdx), existingIds);
    duplicateTrip(dupPrompt.tripId, newId, offsetMinutes);
    setDupPrompt(null);
  };

  // Other trips this template would push its pattern to (the current view).
  const applyTargets = useMemo(
    () => (applyPrompt ? routeTrips.filter((t) => t.trip_id !== applyPrompt) : []),
    [applyPrompt, routeTrips],
  );

  const handleApplyConfirm = () => {
    if (!applyPrompt || applyTargets.length === 0) { setApplyPrompt(null); return; }
    applyTripPattern(applyPrompt, applyTargets.map((t) => t.trip_id));
    setApplyPrompt(null);
  };

  // Ordered [lng, lat] vertices of a trip's drawn shape (empty if none).
  const shapeCoordsForTrip = useCallback((tripId: string): [number, number][] => {
    const trip = trips.find((t) => t.trip_id === tripId);
    const shape = trip?.shape_id ? shapes.find((s) => s.shape_id === trip.shape_id) : undefined;
    if (!shape || shape.points.length < 2) return [];
    return [...shape.points]
      .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
      .map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
  }, [trips, shapes]);

  const handleEstimate = (tripId: string) => {
    const firstTime = getFirstDisplayedTime(tripId);
    setEstStart(firstTime ? formatTimeShort(firstTime) : '08:00');
    setEstError(null);
    setEstimatePrompt(tripId);
  };

  // Estimate stop times from the drawn route's road-network travel time, plus
  // a per-stop dwell and a bus-vs-car speed factor, then write them to the trip.
  const handleEstimateConfirm = async () => {
    if (!estimatePrompt) return;
    const normalized = normalizeTimeInput(estStart);
    if (!normalized) { setEstError('Enter a valid start time, e.g. 08:00.'); return; }
    const shapeCoords = shapeCoordsForTrip(estimatePrompt);
    if (shapeCoords.length < 2) { setEstError('This trip has no drawn route shape to follow.'); return; }
    if (orderedStops.length < 2) { setEstError('Add at least two stops to this route first.'); return; }

    setEstimating(true);
    setEstError(null);
    try {
      const stopCoords = orderedStops.map((s) => [s.stop_lon, s.stop_lat] as [number, number]);
      const cum = await estimateStopTravelSeconds(shapeCoords, stopCoords);
      if (!cum) {
        setEstError("Couldn't match this route to the road network. Try again, or set times manually.");
        return;
      }
      const timings = layoutStopTimes(cum, {
        startSec: gtfsTimeToSeconds(normalized),
        dwellSec: Math.max(0, estDwell),
        speedFactor: Math.max(0.1, estSpeed),
      });
      timings.forEach((t, i) => {
        setStopTime(estimatePrompt, orderedStops[i].stop_id, i, {
          arrival_time: secondsToGtfsTime(t.arrivalSec),
          departure_time: secondsToGtfsTime(t.departureSec),
        });
      });
      setEstimatePrompt(null);
    } catch {
      setEstError('Something went wrong estimating times. Please try again.');
    } finally {
      setEstimating(false);
    }
  };

  const handleCopyFromService = (sourceServiceId: string) => {
    if (!selectedRouteId || !activeServiceId) return;
    const routeName = route?.route_short_name || route?.route_long_name || '';
    const svcIdx = getServiceIndex(activeServiceId, calendars);
    const existingIds = new Set(trips.map((t) => t.trip_id));
    const sourceTrips = trips.filter(
      (t) => t.route_id === selectedRouteId && t.direction_id === directionId && t.service_id === sourceServiceId
    );
    for (const trip of sourceTrips) {
      const firstTime = getFirstDisplayedTime(trip.trip_id);
      const newId = uniqueTripId(generateTripName(routeName, firstTime, svcIdx), existingIds);
      existingIds.add(newId);
      duplicateTrip(trip.trip_id, newId, 0);
      updateTrip(newId, { service_id: activeServiceId });
    }
  };

  const handleRepeatSubmit = () => {
    if (routeTrips.length === 0) return;
    const lastTrip = routeTrips[routeTrips.length - 1];
    const routeName = route?.route_short_name || route?.route_long_name || '';
    const svcIdx = getServiceIndex(lastTrip.service_id || activeServiceId || '', calendars);
    const firstTime = getFirstDisplayedTime(lastTrip.trip_id);
    const existingIds = new Set(trips.map((t) => t.trip_id));

    for (let i = 0; i < repeatCopies; i++) {
      const offsetMinutes = repeatHeadway * (i + 1);
      let newId: string;
      if (firstTime) {
        const newTimeSeconds = gtfsTimeToSeconds(firstTime) + offsetMinutes * 60;
        const newTimeStr = secondsToGtfsTime(newTimeSeconds);
        newId = uniqueTripId(generateTripName(routeName, newTimeStr, svcIdx), existingIds);
      } else {
        newId = uniqueTripId(generateTripName(routeName, '', svcIdx), existingIds);
      }
      existingIds.add(newId);
      duplicateTrip(lastTrip.trip_id, newId, offsetMinutes);
    }
    setShowRepeatForm(false);
  };

  if (!route) {
    // Auto-select first route if available
    if (routes.length > 0) {
      selectRoute(routes[0].route_id);
    }
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        {routes.length === 0 ? 'Create a route first' : 'Select a route to view its timetable'}
      </div>
    );
  }

  const hasStops = orderedStops.length > 0;

  return (
    <div className="p-2 flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2 mb-2 px-2 shrink-0">
        {/* Route selector */}
        <select
          value={selectedRouteId || ''}
          onChange={(e) => selectRoute(e.target.value || null)}
          className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
        >
          {routes.map((r) => (
            <option key={r.route_id} value={r.route_id}>
              {r.route_short_name || r.route_long_name || r.route_id}
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
        {/* Adaptive trip-pattern selector. Falls back to the legacy direction
            toggle when the route has 0-2 shape patterns; for 3+ patterns it
            renders a dropdown so same-direction variants are reachable. */}
        {patterns.length >= 1 ? (
          <PatternSelector
            patterns={patterns}
            selectedShapeId={selectedShapeId}
            route={route}
            shapes={shapes}
            onChange={(p) => {
              setSelectedShapeId(p.shapeId);
              if (p.directionId !== directionId) setDirectionId(p.directionId);
            }}
          />
        ) : (
          <DirectionSelect directionId={directionId} onChange={setDirectionId} route={route} />
        )}
        <span className="text-xs text-warm-gray whitespace-nowrap">
          {routeTrips.length} trips
        </span>
        <div className="flex-1" />
        <label
          className="flex items-center gap-1.5 text-[11px] text-warm-gray cursor-pointer select-none whitespace-nowrap"
          title="Show separate arrival and departure inputs for each stop. Use this for services with dwell time at intermediate stops (e.g. ferries, long-distance rail)."
        >
          <input
            type="checkbox"
            checked={splitArrDep}
            onChange={(e) => setSplitArrDep(e.target.checked)}
            className="accent-coral"
          />
          Arr / Dep
        </label>
        <button
          onClick={() => setShowRepeatForm((v) => !v)}
          disabled={!hasStops}
          className="px-3 py-1 border-2 border-dashed border-sand rounded-md text-xs font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors whitespace-nowrap disabled:opacity-40 disabled:hover:border-sand disabled:hover:text-warm-gray"
        >
          Repeat Every...
        </button>
        <button
          onClick={handleAddTrip}
          disabled={!hasStops}
          className="px-3 py-1 border-2 border-dashed border-sand rounded-md text-xs font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors whitespace-nowrap disabled:opacity-40 disabled:hover:border-sand disabled:hover:text-warm-gray"
        >
          + Add Trip
        </button>
      </div>

      {/* Repeat Every inline form */}
      {showRepeatForm && (
        <div className="mx-2 mb-2 p-3 bg-cream rounded-lg border border-sand">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-xs text-dark-brown font-semibold">Headway</label>
            <input
              type="number"
              min={1}
              value={repeatHeadway}
              onChange={(e) => setRepeatHeadway(Math.max(1, Number(e.target.value)))}
              className="w-16 px-2 py-1 text-xs rounded border border-sand focus:border-coral focus:outline-none bg-white"
            />
            <span className="text-xs text-warm-gray">min</span>
            <label className="text-xs text-dark-brown font-semibold ml-2">Copies</label>
            <input
              type="number"
              min={1}
              max={100}
              value={repeatCopies}
              onChange={(e) => setRepeatCopies(Math.max(1, Math.min(100, Number(e.target.value))))}
              className="w-16 px-2 py-1 text-xs rounded border border-sand focus:border-coral focus:outline-none bg-white"
            />
            <button
              onClick={handleRepeatSubmit}
              disabled={routeTrips.length === 0}
              className="px-3 py-1 bg-coral text-white text-xs font-semibold rounded hover:bg-coral/90 transition-colors disabled:opacity-40"
            >
              Generate
            </button>
            <button
              onClick={() => setShowRepeatForm(false)}
              className="px-3 py-1 text-xs text-warm-gray hover:text-dark-brown transition-colors"
            >
              Cancel
            </button>
          </div>
          {routeTrips.length === 0 && (
            <p className="text-[11px] text-warm-gray mt-1">Add at least one trip first to duplicate from.</p>
          )}
        </div>
      )}

      {routeTrips.length === 0 && serviceIdsWithTrips.length > 0 && (
        <div className="mx-2 mb-2 p-3 bg-cream rounded-lg border border-sand shrink-0">
          <p className="text-xs text-warm-gray mb-2">
            No trips for this service pattern. Copy from:
          </p>
          <div className="flex gap-2 flex-wrap">
            {serviceIdsWithTrips
              .filter((sid) => sid !== activeServiceId)
              .map((sid) => {
                const cal = calendars.find((c) => c.service_id === sid);
                const count = trips.filter((t) => t.route_id === selectedRouteId && t.direction_id === directionId && t.service_id === sid).length;
                return (
                  <button
                    key={sid}
                    onClick={() => handleCopyFromService(sid)}
                    className="px-3 py-1.5 bg-coral text-white rounded-lg text-xs font-bold hover:bg-[#d4603a] transition-colors"
                  >
                    {cal?._description || sid} ({count} trips)
                  </button>
                );
              })}
          </div>
        </div>
      )}

      <div className="overflow-auto flex-1 min-h-0">
        {!hasStops ? (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className="sticky left-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand z-10">
                  Trip
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-3 py-6 text-center text-warm-gray text-sm">
                  Add stops to this route{directionId === 1 ? ' (inbound direction)' : ''} first
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
        <table className="w-full text-xs border-collapse min-w-[600px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-cream px-3 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand z-10">
                Trip
              </th>
              {orderedStops.map((stop) => {
                const isTimepoint = timepointStopIds.has(stop.stop_id);
                return (
                  <th
                    key={stop.stop_id}
                    className={`px-2 py-2 text-left font-semibold text-warm-gray text-[11px] border-b border-sand whitespace-nowrap ${
                      isTimepoint ? 'bg-coral/10' : ''
                    }`}
                  >
                    {stop.stop_name.length > 20 ? stop.stop_name.slice(0, 18) + '\u2026' : stop.stop_name}
                  </th>
                );
              })}
              <th className="px-2 py-2 border-b border-sand" />
            </tr>
          </thead>
          <tbody>
            {routeTrips.map((trip, tripIdx) => (
              <tr key={trip.trip_id} className="hover:bg-cream">
                <TripIdCell
                  tripId={trip.trip_id}
                  allTripIds={trips.map((t) => t.trip_id)}
                  onRename={(newId) => renameTripId(trip.trip_id, newId)}
                />

                {(() => {
                  // Compute time-order errors: a cell is invalid if its time is <= the previous non-blank time
                  const times = orderedStops.map((stop) => {
                    const st = findStopTime(trip.trip_id, stop.stop_id);
                    return st?.arrival_time || '';
                  });
                  let prevSeconds = -1;
                  const errors = times.map((t) => {
                    if (!t) return false; // blank — no error
                    const sec = gtfsTimeToSeconds(t);
                    if (prevSeconds >= 0 && sec <= prevSeconds) return true; // out of order
                    prevSeconds = sec;
                    return false;
                  });

                  return orderedStops.map((stop, stopIdx) => {
                    const st = findStopTime(trip.trip_id, stop.stop_id);
                    const isTimepoint = timepointStopIds.has(stop.stop_id);
                    // Shared commit callback factory. In single-time mode,
                    // both fields move together; in split mode the caller
                    // names which field to update and we preserve the other.
                    const commit = (field: 'both' | 'arrival_time' | 'departure_time', normalized: string) => {
                      if (!normalized) {
                        // Blanking either side blanks both — partial timing
                        // (only arrival or only departure) is invalid for
                        // intermediate stops in practice and is a spec
                        // violation for first/last stops.
                        setStopTime(trip.trip_id, stop.stop_id, stopIdx, { arrival_time: '', departure_time: '' });
                        return;
                      }
                      let updates: Partial<typeof st & { arrival_time: string; departure_time: string }>;
                      if (field === 'both') {
                        updates = { arrival_time: normalized, departure_time: normalized };
                      } else if (field === 'arrival_time') {
                        // First time entered? mirror to departure so cells
                        // collapse cleanly when the user later turns the
                        // toggle off. If departure already exists, leave it.
                        const dep = st?.departure_time || normalized;
                        updates = { arrival_time: normalized, departure_time: dep };
                      } else {
                        const arr = st?.arrival_time || normalized;
                        updates = { arrival_time: arr, departure_time: normalized };
                      }
                      setStopTime(trip.trip_id, stop.stop_id, stopIdx, updates);
                      // Auto-rename trip if it's a new trip with placeholder name
                      if (trip.trip_id.includes('_new')) {
                        const rName = route?.route_short_name || route?.route_long_name || '';
                        const sIdx = getServiceIndex(trip.service_id, calendars);
                        const existingIds = new Set(useStore.getState().trips.map((t) => t.trip_id));
                        const newId = uniqueTripId(generateTripName(rName, normalized, sIdx), existingIds);
                        renameTripId(trip.trip_id, newId);
                      }
                    };

                    return (
                      <td
                        key={stop.stop_id}
                        className={`px-1 py-0.5 border-b border-[#F5F0EB] ${isTimepoint ? 'bg-coral/10' : ''}`}
                      >
                        {splitArrDep ? (
                          <SplitTimeCell
                            arrival={st?.arrival_time || ''}
                            departure={st?.departure_time || ''}
                            onCommitArrival={(n) => commit('arrival_time', n)}
                            onCommitDeparture={(n) => commit('departure_time', n)}
                            inputRef={(el) => {
                              const key = cellKey(tripIdx, stopIdx);
                              if (el) cellRefs.current.set(key, el);
                              else cellRefs.current.delete(key);
                            }}
                            onKeyDown={(e) => handleKeyDown(e, tripIdx, stopIdx)}
                            timeError={errors[stopIdx]}
                          />
                        ) : (
                          <TimeCell
                            value={st?.arrival_time || st?.departure_time || ''}
                            onCommit={(normalized) => commit('both', normalized)}
                            inputRef={(el) => {
                              const key = cellKey(tripIdx, stopIdx);
                              if (el) cellRefs.current.set(key, el);
                              else cellRefs.current.delete(key);
                            }}
                            onKeyDown={(e) => handleKeyDown(e, tripIdx, stopIdx)}
                            isTimepoint={isTimepoint}
                            timeError={errors[stopIdx]}
                          />
                        )}
                      </td>
                    );
                  });
                })()}
                <td className="px-2 py-1.5 border-b border-[#F5F0EB]">
                  <div className="flex gap-1">
                    <button
                      onClick={() => interpolateStopTimes(trip.trip_id)}
                      title="Interpolate stop times"
                      className="text-warm-gray hover:text-coral text-[11px]"
                    >
                      ⟿
                    </button>
                    {trip.shape_id
                      && (shapes.find((s) => s.shape_id === trip.shape_id)?.points.length ?? 0) >= 2 && (
                      <button
                        onClick={() => handleEstimate(trip.trip_id)}
                        title="Estimate stop times from the road network (Mapbox)"
                        className="text-warm-gray hover:text-coral text-[11px]"
                      >
                        ◷
                      </button>
                    )}
                    <button
                      onClick={() => handleDuplicate(trip.trip_id)}
                      title="Duplicate (+60 min)"
                      className="text-warm-gray hover:text-coral text-[11px]"
                    >
                      ⧉
                    </button>
                    {routeTrips.length > 1 && (
                      <button
                        onClick={() => setApplyPrompt(trip.trip_id)}
                        title="Apply this trip's stops + timing to all other trips on this route/direction (each keeps its own start time)"
                        className="text-warm-gray hover:text-coral text-[11px]"
                      >
                        ⇶
                      </button>
                    )}
                    <button
                      onClick={() => removeTrip(trip.trip_id)}
                      title="Delete trip"
                      className="text-warm-gray hover:text-red-500 text-[11px]"
                    >
                      ×
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>

      {/* Duplicate trip prompt */}
      {dupPrompt && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="absolute inset-0 bg-black/20" onClick={() => setDupPrompt(null)} />
          <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-xs mx-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
              Duplicate Trip
            </h3>
            <p className="text-sm text-warm-gray mb-3">
              Start time for the new trip:
            </p>
            <input
              autoFocus
              value={dupStartTime}
              onChange={(e) => setDupStartTime(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleDupConfirm(); }}
              placeholder="e.g. 08:00"
              className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral mb-3 tabular-nums"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setDupPrompt(null)}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDupConfirm}
                className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
              >
                Add Trip
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Apply-to-all-trips confirm */}
      {applyPrompt && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="absolute inset-0 bg-black/20" onClick={() => setApplyPrompt(null)} />
          <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-sm mx-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
              Apply to all trips
            </h3>
            <p className="text-sm text-warm-gray mb-4">
              Re-lay the {applyTargets.length} other {directionName(route, directionId).toLowerCase()} trip
              {applyTargets.length === 1 ? '' : 's'} on this route to match this trip&rsquo;s stops and
              timing. Each keeps its own start time — headways and departures stay the same; only the
              stop sequence and run/dwell times change.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setApplyPrompt(null)}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyConfirm}
                disabled={applyTargets.length === 0}
                className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
              >
                Apply to {applyTargets.length}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Estimate times dialog */}
      {estimatePrompt && (
        <div className="fixed inset-0 flex items-center justify-center z-50">
          <div className="absolute inset-0 bg-black/20" onClick={() => { if (!estimating) setEstimatePrompt(null); }} />
          <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-sm mx-4">
            <h3 className="font-heading font-bold text-base text-dark-brown mb-1">
              Estimate times
            </h3>
            <p className="text-sm text-warm-gray mb-4">
              Fill this trip&rsquo;s stop times from the drawn route&rsquo;s road-network travel time, plus a
              dwell at each stop. Then use&nbsp;⇶ to apply it to the route&rsquo;s other trips.
            </p>
            <div className="space-y-3 mb-4">
              <label className="block">
                <span className="text-xs font-semibold text-dark-brown">Start time</span>
                <input
                  autoFocus
                  value={estStart}
                  onChange={(e) => setEstStart(e.target.value)}
                  placeholder="08:00"
                  className="mt-1 w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral tabular-nums"
                />
              </label>
              <div className="flex gap-3">
                <label className="flex-1">
                  <span className="text-xs font-semibold text-dark-brown">Dwell / stop (sec)</span>
                  <input
                    type="number"
                    min={0}
                    value={estDwell}
                    onChange={(e) => setEstDwell(Math.max(0, Number(e.target.value)))}
                    className="mt-1 w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral tabular-nums"
                  />
                </label>
                <label className="flex-1">
                  <span
                    className="text-xs font-semibold text-dark-brown"
                    title="Multiplier on car travel time. Buses are slower than free-flow cars; ~1.3 is a reasonable urban default."
                  >
                    Speed factor
                  </span>
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={estSpeed}
                    onChange={(e) => setEstSpeed(Math.max(0.1, Number(e.target.value)))}
                    className="mt-1 w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral tabular-nums"
                  />
                </label>
              </div>
            </div>
            {estError && <p className="text-xs text-red-500 mb-3">{estError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setEstimatePrompt(null)}
                disabled={estimating}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEstimateConfirm}
                disabled={estimating}
                className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
              >
                {estimating ? 'Estimating…' : 'Estimate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Time cell with local editing state — formats on blur, red outline if invalid */
function TimeCell({
  value,
  onCommit,
  inputRef: externalRef,
  onKeyDown,
  isTimepoint: _isTimepoint,
  timeError,
  compact,
}: {
  value: string; // stored arrival_time (HH:MM:SS or raw)
  onCommit: (normalized: string) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  isTimepoint: boolean;
  timeError?: boolean;
  /** Narrower variant used inside SplitTimeCell where two cells share a column. */
  compact?: boolean;
}) {
  const [localValue, setLocalValue] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const localValueRef = useRef<string | null>(null);
  const inputElRef = useRef<HTMLInputElement | null>(null);

  const displayValue = value ? formatTimeShort(value) : '';
  const isEditing = localValue !== null;

  const commit = useCallback(() => {
    const raw = localValueRef.current;
    if (raw === null) return;
    const trimmed = raw.trim();
    localValueRef.current = null;
    if (!trimmed) {
      onCommit('');
      setInvalid(false);
    } else {
      const normalized = normalizeTimeInput(trimmed);
      if (normalized) {
        onCommit(normalized);
        setInvalid(false);
      } else {
        setInvalid(true);
      }
    }
  }, [onCommit]);

  const handleFocus = () => {
    setLocalValue(displayValue);
    localValueRef.current = displayValue;
    setInvalid(false);
    // Select contents after React re-renders with the local value
    requestAnimationFrame(() => inputElRef.current?.select());
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value);
    localValueRef.current = e.target.value;
  };

  const handleBlur = () => {
    commit();
    setLocalValue(null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Commit before Tab/Enter so the value is saved before focus moves
    if (e.key === 'Tab' || e.key === 'Enter') {
      commit();
      setLocalValue(null);
    }
    onKeyDown?.(e);
  };

  return (
    <input
      ref={(el) => {
        inputElRef.current = el;
        externalRef?.(el);
      }}
      value={isEditing ? localValue : displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder="--:--"
      className={`${compact ? 'w-12 px-1' : 'w-20 px-1.5'} py-1 text-xs rounded border hover:border-sand focus:border-coral focus:outline-none bg-transparent tabular-nums
        ${invalid || timeError ? 'border-red-400 bg-red-50' : 'border-transparent'}`}
    />
  );
}

/** Two stacked time inputs (arrival on top, departure below) used when the
 *  Arr / Dep toggle is on. Layout matches TimeCell width so column widths
 *  don't reflow when the toggle flips. */
function SplitTimeCell({
  arrival,
  departure,
  onCommitArrival,
  onCommitDeparture,
  inputRef: externalRef,
  onKeyDown,
  timeError,
}: {
  arrival: string;
  departure: string;
  onCommitArrival: (normalized: string) => void;
  onCommitDeparture: (normalized: string) => void;
  inputRef?: (el: HTMLInputElement | null) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  timeError?: boolean;
}) {
  return (
    <div className="flex flex-row items-center gap-0.5">
      <TimeCell
        value={arrival}
        onCommit={onCommitArrival}
        inputRef={externalRef}
        onKeyDown={onKeyDown}
        isTimepoint={false}
        timeError={timeError}
        compact
      />
      <span className="text-warm-gray text-[9px] shrink-0">→</span>
      <TimeCell
        value={departure}
        onCommit={onCommitDeparture}
        isTimepoint={false}
        compact
      />
    </div>
  );
}

/** Editable trip ID cell with uniqueness validation */
function TripIdCell({ tripId, allTripIds, onRename }: {
  tripId: string;
  allTripIds: string[];
  onRename: (newId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState(tripId);
  const isDuplicate = !editing && allTripIds.filter((id) => id === tripId).length > 1;

  const handleFocus = () => {
    setEditing(true);
    setLocalValue(tripId);
  };

  const handleBlur = () => {
    setEditing(false);
    const trimmed = localValue.trim();
    if (!trimmed || trimmed === tripId) return;
    // Check uniqueness before renaming
    if (allTripIds.some((id) => id === trimmed && id !== tripId)) return;
    onRename(trimmed);
  };

  return (
    <td className="sticky left-0 bg-white px-1 py-0.5 font-semibold text-dark-brown border-b border-[#F5F0EB] z-10">
      <input
        value={editing ? localValue : tripId}
        onChange={(e) => setLocalValue(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        className={`w-full px-1.5 py-1 text-xs rounded border hover:border-sand focus:border-coral focus:outline-none bg-transparent font-semibold
          ${isDuplicate ? 'border-red-400 bg-red-50' : 'border-transparent'}`}
        title={isDuplicate ? 'Duplicate trip ID' : tripId}
      />
    </td>
  );
}

/** Direction dropdown for routes with no shapes yet (in-progress feeds).
 *  Routes that have shapes use the shape-based PatternSelector instead. */
function DirectionSelect({
  directionId,
  onChange,
  route,
}: {
  directionId: 0 | 1;
  onChange: (d: 0 | 1) => void;
  route?: Route | null;
}) {
  return (
    <select
      value={directionId}
      onChange={(e) => onChange(Number(e.target.value) as 0 | 1)}
      className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
    >
      <option value={0}>{directionName(route, 0)}</option>
      <option value={1}>{directionName(route, 1)}</option>
    </select>
  );
}
