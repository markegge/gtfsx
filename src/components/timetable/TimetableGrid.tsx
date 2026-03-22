import React, { useMemo, useCallback, useState, useRef } from 'react';
import { useStore } from '../../store';
import { formatTimeShort, normalizeTimeInput } from '../../utils/time';
import { generateId } from '../../services/idGenerator';

export function TimetableGrid() {
  const {
    selectedRouteId, routes, trips, stopTimes, stops, routeStops, calendars,
    setStopTime, addTrip, duplicateTrip, removeTrip, setStopTimes,
    interpolateStopTimes,
  } = useStore();

  const route = routes.find((r) => r.route_id === selectedRouteId);

  // Direction toggle state
  const [directionId, setDirectionId] = useState<0 | 1>(0);

  // Repeat-every form state
  const [showRepeatForm, setShowRepeatForm] = useState(false);
  const [repeatHeadway, setRepeatHeadway] = useState(15);
  const [repeatCopies, setRepeatCopies] = useState(5);

  // Ref map for Tab navigation between cells
  const cellRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const cellKey = (tripIdx: number, stopIdx: number) => `${tripIdx}-${stopIdx}`;

  // Get ordered stops for this route filtered by direction
  const orderedStops = useMemo(() => {
    if (!selectedRouteId) return [];
    return routeStops
      .filter((rs) => rs.route_id === selectedRouteId && rs.direction_id === directionId)
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map((rs) => stops.find((s) => s.stop_id === rs.stop_id))
      .filter(Boolean) as typeof stops;
  }, [selectedRouteId, routeStops, stops, directionId]);

  // Timepoint lookup: set of stop_ids that have timepoint=1 in any stop_time for current route
  const timepointStopIds = useMemo(() => {
    const ids = new Set<string>();
    for (const st of stopTimes) {
      if (st.timepoint === 1) ids.add(st.stop_id);
    }
    // If no timepoints are explicitly set, treat first and last as timepoints
    if (ids.size === 0 && orderedStops.length >= 2) {
      ids.add(orderedStops[0].stop_id);
      ids.add(orderedStops[orderedStops.length - 1].stop_id);
    }
    return ids;
  }, [stopTimes, orderedStops]);

  // Get trips for this route filtered by direction
  const routeTrips = useMemo(() => {
    if (!selectedRouteId) return [];
    return trips
      .filter((t) => t.route_id === selectedRouteId && t.direction_id === directionId)
      .sort((a, b) => {
        const aFirst = stopTimes.find((st) => st.trip_id === a.trip_id);
        const bFirst = stopTimes.find((st) => st.trip_id === b.trip_id);
        return (aFirst?.arrival_time || '').localeCompare(bFirst?.arrival_time || '');
      });
  }, [selectedRouteId, trips, stopTimes, directionId]);

  // Normalize time on blur
  const handleTimeBlur = useCallback((tripId: string, stopId: string, seq: number, value: string) => {
    const normalized = normalizeTimeInput(value);
    if (normalized) {
      setStopTime(tripId, stopId, seq, { arrival_time: normalized, departure_time: normalized });
    }
  }, [setStopTime]);

  const handleTimeChange = useCallback((tripId: string, stopId: string, seq: number, value: string) => {
    setStopTime(tripId, stopId, seq, { arrival_time: value, departure_time: value });
  }, [setStopTime]);

  // Tab key navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>, tripIdx: number, stopIdx: number) => {
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
        const el = cellRefs.current.get(key);
        if (el) el.focus();
      }
    }
  }, [orderedStops.length, routeTrips.length]);

  const handleAddTrip = () => {
    if (!selectedRouteId) return;
    const tripId = generateId('trip');
    addTrip({
      trip_id: tripId,
      route_id: selectedRouteId,
      service_id: calendars[0]?.service_id || '',
      direction_id: directionId,
      trip_headsign: route?.route_short_name || '',
      shape_id: trips.find((t) => t.route_id === selectedRouteId)?.shape_id,
    });
  };

  const handleDuplicate = (tripId: string) => {
    const newId = generateId('trip');
    duplicateTrip(tripId, newId, 60);
  };

  const handleRepeatSubmit = () => {
    if (routeTrips.length === 0) return;
    const lastTrip = routeTrips[routeTrips.length - 1];
    for (let i = 0; i < repeatCopies; i++) {
      const newId = generateId('trip');
      duplicateTrip(lastTrip.trip_id, newId, repeatHeadway * (i + 1));
    }
    setShowRepeatForm(false);
  };

  if (!route) {
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        Select a route to view its timetable
      </div>
    );
  }

  if (orderedStops.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {/* Direction toggle even when no stops */}
        <div className="flex items-center gap-3 px-2">
          <DirectionToggle directionId={directionId} onChange={setDirectionId} />
        </div>
        <div className="flex items-center justify-center h-32 text-warm-gray text-sm">
          Add stops to this route{directionId === 1 ? ' (inbound direction)' : ''} first
        </div>
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="flex items-center gap-3 mb-2 px-2">
        <DirectionToggle directionId={directionId} onChange={setDirectionId} />
        <span className="text-xs text-warm-gray">
          {route.route_short_name || route.route_long_name} — {routeTrips.length} trips
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setShowRepeatForm((v) => !v)}
          className="px-3 py-1 border-2 border-dashed border-sand rounded-md text-xs font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors"
        >
          Repeat Every...
        </button>
        <button
          onClick={handleAddTrip}
          className="px-3 py-1 border-2 border-dashed border-sand rounded-md text-xs font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors"
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

      <div className="overflow-x-auto">
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
                <td className="sticky left-0 bg-white px-3 py-1.5 font-semibold text-dark-brown border-b border-[#F5F0EB] z-10">
                  {trip.trip_id.length > 10 ? trip.trip_id.slice(0, 8) + '\u2026' : trip.trip_id}
                </td>
                {orderedStops.map((stop, stopIdx) => {
                  const st = stopTimes.find(
                    (s) => s.trip_id === trip.trip_id && s.stop_id === stop.stop_id
                  );
                  const isTimepoint = timepointStopIds.has(stop.stop_id);
                  return (
                    <td
                      key={stop.stop_id}
                      className={`px-1 py-0.5 border-b border-[#F5F0EB] ${isTimepoint ? 'bg-coral/10' : ''}`}
                    >
                      <input
                        ref={(el) => {
                          const key = cellKey(tripIdx, stopIdx);
                          if (el) cellRefs.current.set(key, el);
                          else cellRefs.current.delete(key);
                        }}
                        value={st ? formatTimeShort(st.arrival_time) : ''}
                        onChange={(e) => handleTimeChange(trip.trip_id, stop.stop_id, stopIdx, e.target.value)}
                        onBlur={(e) => handleTimeBlur(trip.trip_id, stop.stop_id, stopIdx, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(e, tripIdx, stopIdx)}
                        placeholder="\u2014"
                        className="w-14 px-1.5 py-1 text-xs rounded border border-transparent hover:border-sand focus:border-coral focus:outline-none bg-transparent tabular-nums"
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 border-b border-[#F5F0EB]">
                  <div className="flex gap-1">
                    <button
                      onClick={() => interpolateStopTimes(trip.trip_id)}
                      title="Interpolate stop times"
                      className="text-warm-gray hover:text-coral text-[11px]"
                    >
                      ⟿
                    </button>
                    <button
                      onClick={() => handleDuplicate(trip.trip_id)}
                      title="Duplicate (+60 min)"
                      className="text-warm-gray hover:text-coral text-[11px]"
                    >
                      ⧉
                    </button>
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
      </div>
    </div>
  );
}

/** Direction toggle component */
function DirectionToggle({
  directionId,
  onChange,
}: {
  directionId: 0 | 1;
  onChange: (d: 0 | 1) => void;
}) {
  return (
    <div className="flex rounded-md border border-sand overflow-hidden">
      <button
        onClick={() => onChange(0)}
        className={`px-3 py-1 text-xs font-semibold transition-colors ${
          directionId === 0
            ? 'bg-coral text-white'
            : 'bg-white text-warm-gray hover:text-dark-brown'
        }`}
      >
        Outbound
      </button>
      <button
        onClick={() => onChange(1)}
        className={`px-3 py-1 text-xs font-semibold transition-colors border-l border-sand ${
          directionId === 1
            ? 'bg-coral text-white'
            : 'bg-white text-warm-gray hover:text-dark-brown'
        }`}
      >
        Inbound
      </button>
    </div>
  );
}
