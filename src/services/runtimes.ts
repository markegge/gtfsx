/**
 * B2 — pattern running times.
 *
 * Let a planner set the scheduled running time of a (route, direction, shape)
 * pattern and re-lay every trip on it to that run time WITHOUT moving any
 * trip's start — so headways stay intact. Intermediate stops are re-interpolated
 * (distance-aware) via the store's interpolateStopTimes.
 *
 * Manual only — no AVL. This is the editable-runtime layer the generated
 * timetable (B1) and the blocks (B3) reflect.
 */
import { useStore } from '../store';
import { gtfsTimeToSeconds, secondsToGtfsTime } from '../utils/time';
import { layoutStopTimes } from './travelTime';
import type { RouteStop, StopTime } from '../types/gtfs';

export interface PatternRef {
  routeId: string;
  directionId: 0 | 1;
  shapeId?: string;
  /** Limit to one service day-type; omit to apply to every trip on the pattern. */
  serviceId?: string;
}

function patternRouteStops(routeId: string, directionId: 0 | 1, shapeId?: string): RouteStop[] {
  const rs = useStore.getState().routeStops.filter(
    (r) => r.route_id === routeId && r.direction_id === directionId && (shapeId ? r.shape_id === shapeId : true),
  );
  return [...rs].sort((a, b) => a.stop_sequence - b.stop_sequence);
}

function patternTrips(ref: PatternRef) {
  return useStore.getState().trips.filter(
    (t) => t.route_id === ref.routeId
      && t.direction_id === ref.directionId
      && (ref.shapeId ? t.shape_id === ref.shapeId : true)
      && (ref.serviceId ? t.service_id === ref.serviceId : true),
  );
}

/** The earliest set time (start) of a trip, in seconds, or null. */
function tripStartSec(times: StopTime[]): number | null {
  const ordered = [...times].sort((a, b) => a.stop_sequence - b.stop_sequence);
  const t = ordered.find((st) => st.arrival_time || st.departure_time);
  return t ? gtfsTimeToSeconds(t.departure_time || t.arrival_time) : null;
}

/** Current run time (first→last stop, seconds) of the pattern, read from the
 *  earliest-departing trip — the default shown in the editor. null if unknown. */
export function currentPatternRunSecs(ref: PatternRef): number | null {
  const trips = patternTrips(ref);
  const allTimes = useStore.getState().stopTimes;
  let best: { start: number; run: number } | null = null;
  for (const trip of trips) {
    const times = allTimes.filter((st) => st.trip_id === trip.trip_id && (st.arrival_time || st.departure_time));
    if (times.length < 2) continue;
    const ordered = [...times].sort((a, b) => a.stop_sequence - b.stop_sequence);
    const start = gtfsTimeToSeconds(ordered[0].departure_time || ordered[0].arrival_time);
    const end = gtfsTimeToSeconds(ordered[ordered.length - 1].arrival_time || ordered[ordered.length - 1].departure_time);
    if (end <= start) continue;
    if (!best || start < best.start) best = { start, run: end - start };
  }
  return best?.run ?? null;
}

/**
 * Apply a new total run time (seconds) to every trip on the pattern, keeping
 * each trip's start time fixed (headways preserved) and re-interpolating
 * intermediate stops. Returns the number of trips updated.
 */
export function applyPatternRunTime(ref: PatternRef, runSecs: number): number {
  if (!(runSecs > 0)) return 0;
  const st = useStore.getState();
  const rs = patternRouteStops(ref.routeId, ref.directionId, ref.shapeId);
  if (rs.length < 2) return 0;
  const first = rs[0];
  const last = rs[rs.length - 1];
  const trips = patternTrips(ref);

  let updated = 0;
  for (const trip of trips) {
    const times = st.stopTimes.filter((s) => s.trip_id === trip.trip_id);
    const start = tripStartSec(times);
    if (start == null) continue;
    // Anchor the endpoints to start and start+run, then interpolate the middle.
    st.setStopTime(trip.trip_id, first.stop_id, first.stop_sequence, {
      arrival_time: secondsToGtfsTime(start), departure_time: secondsToGtfsTime(start),
    });
    st.setStopTime(trip.trip_id, last.stop_id, last.stop_sequence, {
      arrival_time: secondsToGtfsTime(start + runSecs), departure_time: secondsToGtfsTime(start + runSecs),
    });
    st.interpolateStopTimes(trip.trip_id);
    updated++;
  }
  return updated;
}

/**
 * Lay every trip on the pattern from a road-network travel profile — the same
 * estimation the per-trip ◷ Estimate uses, applied pattern-wide. `cumSecs` is the
 * cumulative road-travel seconds per ordered stop (from estimateStopTravelByRoad)
 * and MUST align index-for-index with `orderedStops`. Each trip keeps its own
 * start time; skips are honored (only stops the trip already times are written).
 * Returns the number of trips updated. No estimation math here — pure plumbing
 * over layoutStopTimes.
 */
export function applyPatternEstimate(
  ref: PatternRef,
  orderedStops: { stopId: string; seq: number }[],
  cumSecs: number[],
  opts: { dwellSec: number; speedFactor: number },
): number {
  if (orderedStops.length < 2 || cumSecs.length !== orderedStops.length) return 0;
  const st = useStore.getState();
  const dwellSec = Math.max(0, opts.dwellSec);
  const speedFactor = Math.max(0.1, opts.speedFactor);
  let updated = 0;
  for (const trip of patternTrips(ref)) {
    const times = st.stopTimes.filter((s) => s.trip_id === trip.trip_id);
    const start = tripStartSec(times);
    if (start == null) continue;
    const timings = layoutStopTimes(cumSecs, { startSec: start, dwellSec, speedFactor });
    const timedSeqs = new Set(times.map((s) => s.stop_sequence));
    let changed = false;
    orderedStops.forEach((os, i) => {
      if (!timedSeqs.has(os.seq)) return; // skip-aware — don't un-skip a skipped stop
      st.setStopTime(trip.trip_id, os.stopId, os.seq, {
        arrival_time: secondsToGtfsTime(timings[i].arrivalSec),
        departure_time: secondsToGtfsTime(timings[i].departureSec),
      });
      changed = true;
    });
    if (changed) updated++;
  }
  return updated;
}
