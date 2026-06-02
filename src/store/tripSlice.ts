import type { StateCreator } from 'zustand';
import type { Trip, StopTime } from '../types/gtfs';
import type { RouteSlice } from './routeSlice';
import type { ShapeSlice } from './shapeSlice';
import type { StopSlice } from './stopSlice';
import { gtfsTimeToSeconds, secondsToGtfsTime } from '../utils/time';

export interface TripSlice {
  trips: Trip[];
  stopTimes: StopTime[];
  addTrip: (trip: Trip) => void;
  updateTrip: (trip_id: string, updates: Partial<Trip>) => void;
  removeTrip: (trip_id: string) => void;
  setTrips: (trips: Trip[]) => void;
  setStopTime: (trip_id: string, stop_id: string, stop_sequence: number, updates: Partial<StopTime>) => void;
  setStopTimes: (stopTimes: StopTime[]) => void;
  renameTripId: (oldId: string, newId: string) => void;
  duplicateTrip: (trip_id: string, newTripId: string, offsetMinutes: number) => void;
  /** Re-lay each target trip's stop_times to match the template trip's stop
   *  sequence + relative timings, shifted so each target keeps its own start
   *  time. Used to push a schedule edit (added stop / changed timing) to all
   *  trips on a route/direction without delete-and-regenerate. */
  applyTripPattern: (templateTripId: string, targetTripIds: string[]) => void;
  interpolateStopTimes: (tripId: string) => void;
}

function addMinutesToGtfsTime(time: string, minutes: number): string {
  const parts = time.split(':').map(Number);
  const totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2] + minutes * 60;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function addSecondsToGtfsTime(time: string, seconds: number): string {
  const total = gtfsTimeToSeconds(time) + seconds;
  return secondsToGtfsTime(total);
}

/** A trip's anchor = the earliest-sequence stop_time that has a time set
 *  (its start). Returns null if the trip has no times at all. */
function tripAnchorSeconds(times: StopTime[]): number | null {
  const ordered = [...times].sort((a, b) => a.stop_sequence - b.stop_sequence);
  const anchor = ordered.find((st) => st.arrival_time)?.arrival_time
    ?? ordered.find((st) => st.departure_time)?.departure_time;
  return anchor ? gtfsTimeToSeconds(anchor) : null;
}

export const createTripSlice: StateCreator<TripSlice, [['zustand/immer', never]], [], TripSlice> = (set, get) => ({
  trips: [],
  stopTimes: [],
  addTrip: (trip) => set((state) => { state.trips.push(trip); }),
  updateTrip: (trip_id, updates) => set((state) => {
    const idx = state.trips.findIndex((t) => t.trip_id === trip_id);
    if (idx !== -1) Object.assign(state.trips[idx], updates);
  }),
  removeTrip: (trip_id) => set((state) => {
    state.trips = state.trips.filter((t) => t.trip_id !== trip_id);
    state.stopTimes = state.stopTimes.filter((st) => st.trip_id !== trip_id);
  }),
  setTrips: (trips) => set((state) => { state.trips = trips; }),
  setStopTime: (trip_id, stop_id, stop_sequence, updates) => set((state) => {
    // Match on trip_id + stop_id (stop_sequence may differ between visual index and stored value)
    const idx = state.stopTimes.findIndex(
      (st) => st.trip_id === trip_id && st.stop_id === stop_id
    );
    if (idx !== -1) {
      Object.assign(state.stopTimes[idx], updates);
    } else {
      state.stopTimes.push({
        trip_id, stop_id, stop_sequence,
        arrival_time: '', departure_time: '',
        ...updates,
      });
    }
  }),
  setStopTimes: (stopTimes) => set((state) => { state.stopTimes = stopTimes; }),
  renameTripId: (oldId, newId) => set((state) => {
    const trip = state.trips.find((t) => t.trip_id === oldId);
    if (!trip) return;
    trip.trip_id = newId;
    for (const st of state.stopTimes) {
      if (st.trip_id === oldId) st.trip_id = newId;
    }
  }),
  duplicateTrip: (trip_id, newTripId, offsetMinutes) => set((state) => {
    const trip = state.trips.find((t) => t.trip_id === trip_id);
    if (!trip) return;
    state.trips.push({ ...trip, trip_id: newTripId });
    const times = state.stopTimes.filter((st) => st.trip_id === trip_id);
    for (const st of times) {
      state.stopTimes.push({
        ...st,
        trip_id: newTripId,
        arrival_time: st.arrival_time ? addMinutesToGtfsTime(st.arrival_time, offsetMinutes) : '',
        departure_time: st.departure_time ? addMinutesToGtfsTime(st.departure_time, offsetMinutes) : '',
      });
    }
  }),
  applyTripPattern: (templateTripId, targetTripIds) => set((state) => {
    const tmplTimes = state.stopTimes
      .filter((st) => st.trip_id === templateTripId)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    const tmplAnchor = tripAnchorSeconds(tmplTimes);
    if (tmplTimes.length === 0 || tmplAnchor === null) return;

    const targets = new Set(targetTripIds.filter((id) => id !== templateTripId));
    if (targets.size === 0) return;

    // Capture each target's current start BEFORE we replace its times, so the
    // re-laid pattern preserves that trip's departure time (and thus headway).
    const offsetByTarget = new Map<string, number>();
    for (const id of targets) {
      const anchor = tripAnchorSeconds(state.stopTimes.filter((st) => st.trip_id === id));
      offsetByTarget.set(id, (anchor ?? tmplAnchor) - tmplAnchor);
    }

    // Drop the targets' old stop_times, then re-lay from the template shifted.
    state.stopTimes = state.stopTimes.filter((st) => !targets.has(st.trip_id));
    for (const id of targets) {
      const offset = offsetByTarget.get(id) ?? 0;
      for (const st of tmplTimes) {
        state.stopTimes.push({
          ...st,
          trip_id: id,
          arrival_time: st.arrival_time ? addSecondsToGtfsTime(st.arrival_time, offset) : '',
          departure_time: st.departure_time ? addSecondsToGtfsTime(st.departure_time, offset) : '',
        });
      }
    }
  }),
  interpolateStopTimes: (tripId) => set((state) => {
    const fullState = get() as unknown as TripSlice & RouteSlice & ShapeSlice & StopSlice;
    const trip = state.trips.find((t) => t.trip_id === tripId);
    if (!trip) return;

    // Get the ordered route stops for this trip's direction
    const orderedRouteStops = fullState.routeStops
      .filter((rs) => rs.route_id === trip.route_id && rs.direction_id === trip.direction_id)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);

    if (orderedRouteStops.length < 2) return;

    // Get stop times for this trip, indexed by stop_id
    const tripStopTimes = state.stopTimes.filter((st) => st.trip_id === tripId);
    const stByStopId = new Map(tripStopTimes.map((st) => [st.stop_id, st]));

    // Find the first and last stops that have times filled in
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < orderedRouteStops.length; i++) {
      const st = stByStopId.get(orderedRouteStops[i].stop_id);
      if (st && st.arrival_time) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1 || lastIdx === -1 || firstIdx === lastIdx) return;

    const firstTime = gtfsTimeToSeconds(stByStopId.get(orderedRouteStops[firstIdx].stop_id)!.arrival_time);
    const lastTime = gtfsTimeToSeconds(stByStopId.get(orderedRouteStops[lastIdx].stop_id)!.arrival_time);
    const totalTimeSec = lastTime - firstTime;
    if (totalTimeSec <= 0) return;

    // Try to get shape distances for proportional interpolation
    const shape = trip.shape_id
      ? fullState.shapes.find((s) => s.shape_id === trip.shape_id)
      : undefined;

    // Build cumulative distances for each route stop
    // If shape distances available, use nearest shape point; otherwise use equal spacing
    const distances: number[] = [];
    if (shape && shape.points.length >= 2) {
      const stops = fullState.stops;
      for (const rs of orderedRouteStops) {
        const stop = stops.find((s) => s.stop_id === rs.stop_id);
        if (!stop) { distances.push(0); continue; }
        // Find the nearest shape point to this stop
        let bestDist = Infinity;
        let bestShapeDist = 0;
        for (const pt of shape.points) {
          const dlat = pt.shape_pt_lat - stop.stop_lat;
          const dlon = pt.shape_pt_lon - stop.stop_lon;
          const d = dlat * dlat + dlon * dlon;
          if (d < bestDist) {
            bestDist = d;
            bestShapeDist = pt.shape_dist_traveled;
          }
        }
        distances.push(bestShapeDist);
      }
    } else {
      // Fall back to equal spacing
      for (let i = 0; i < orderedRouteStops.length; i++) {
        distances.push(i);
      }
    }

    const firstDist = distances[firstIdx];
    const lastDist = distances[lastIdx];
    const totalDist = lastDist - firstDist;
    if (totalDist <= 0) return;

    // Interpolate intermediate stops
    for (let i = firstIdx + 1; i < lastIdx; i++) {
      const ratio = (distances[i] - firstDist) / totalDist;
      const interpolatedSec = Math.round(firstTime + ratio * totalTimeSec);
      const timeStr = secondsToGtfsTime(interpolatedSec);
      const stopId = orderedRouteStops[i].stop_id;
      const existing = state.stopTimes.findIndex(
        (st) => st.trip_id === tripId && st.stop_id === stopId
      );
      if (existing !== -1) {
        state.stopTimes[existing].arrival_time = timeStr;
        state.stopTimes[existing].departure_time = timeStr;
      } else {
        state.stopTimes.push({
          trip_id: tripId,
          stop_id: stopId,
          stop_sequence: orderedRouteStops[i].stop_sequence,
          arrival_time: timeStr,
          departure_time: timeStr,
        });
      }
    }
  }),
});
