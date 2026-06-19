/**
 * B1 — Timetable generation.
 *
 * Turn a route/direction/shape *pattern* (an ordered list of stops, but no
 * trips yet) plus a planner's start / end / headway / run-time into a full set
 * of evenly-spaced trips — the Remix "frequency in, timetable out" model.
 *
 * Pure and store-free: it takes the pattern (route_stops), optional geometry
 * (shape + stops, for distance-proportional interpolation), and the timing
 * inputs, and RETURNS the trips + stop_times (+ a frequencies row in frequency
 * mode). The caller commits the result to the store. This keeps it trivially
 * unit-testable and lets the generated feed round-trip straight through
 * gtfsExport with no special-casing.
 *
 * It does NOT optimise anything — headways are even and the run-time is a
 * single reference run interpolated across intermediate stops. Per-segment
 * runtimes are Part 2 (B2).
 */
import type { Trip, StopTime, Frequency, RouteStop, Shape, Stop } from '../types/gtfs';
import { gtfsTimeToSeconds, secondsToGtfsTime } from '../utils/time';

export type TimetableGenMode = 'explicit' | 'frequency';

export interface GenerateTripsParams {
  routeId: string;
  directionId: 0 | 1;
  shapeId?: string;
  serviceId: string;
  /** First departure, "HH:MM" or "HH:MM:SS". */
  startTime: string;
  /** Last departure (inclusive), "HH:MM" or "HH:MM:SS". */
  endTime: string;
  /** Headway between departures, in seconds (> 0). */
  headwaySecs: number;
  /** Total run time from the first to the last stop, in seconds (> 0). */
  runSecs: number;
  mode: TimetableGenMode;
  /** The ordered stops for this (route, direction, shape) pattern. */
  routeStops: RouteStop[];
  /** Stops, for distance-proportional interpolation (optional — falls back to
   *  even spacing when absent or when the shape has no usable geometry). */
  stops?: Stop[];
  /** The shape, for distance-proportional interpolation (optional). */
  shape?: Shape;
  /** trip_headsign for the generated trips. */
  headsign?: string;
  /** Deterministic id stem. Default `${routeId}-d${directionId}-${serviceId}`. */
  tripIdPrefix?: string;
  /** Existing trip ids to avoid colliding with (the UI passes the store's ids).
   *  Deterministic ids stay deterministic; only genuine clashes get suffixed. */
  existingTripIds?: Set<string>;
}

export interface GenerateTripsResult {
  trips: Trip[];
  stopTimes: StopTime[];
  frequencies: Frequency[];
}

export interface GenerateValidation {
  ok: boolean;
  error?: string;
  /** How many trips explicit mode would produce (0 when invalid). */
  tripCount: number;
}

const HHMM = (sec: number): string => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
};

/** Haversine distance in km between two [lon,lat]-ish stop points. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Cumulative length (km) of a shape's polyline. */
export function shapeLengthKm(shape: Shape | undefined): number {
  if (!shape || shape.points.length < 2) return 0;
  const pts = [...shape.points].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversineKm(
      pts[i - 1].shape_pt_lat, pts[i - 1].shape_pt_lon,
      pts[i].shape_pt_lat, pts[i].shape_pt_lon,
    );
  }
  return total;
}

/**
 * Suggest a total run time (seconds) for a pattern from its shape length and an
 * assumed average speed (mph). Used to pre-fill the Generate-service form so the
 * planner starts from a sensible number rather than a blank. Falls back to a
 * straight-line stop-to-stop length when there's no shape.
 */
export function estimateRunSecs(
  opts: { shape?: Shape; routeStops?: RouteStop[]; stops?: Stop[]; avgSpeedMph?: number },
): number {
  const mph = opts.avgSpeedMph && opts.avgSpeedMph > 0 ? opts.avgSpeedMph : 20;
  let km = shapeLengthKm(opts.shape);
  if (km <= 0 && opts.routeStops && opts.stops) {
    // No shape — sum straight-line distance between consecutive pattern stops.
    const byId = new Map(opts.stops.map((s) => [s.stop_id, s]));
    const ordered = [...opts.routeStops].sort((a, b) => a.stop_sequence - b.stop_sequence);
    for (let i = 1; i < ordered.length; i++) {
      const a = byId.get(ordered[i - 1].stop_id);
      const b = byId.get(ordered[i].stop_id);
      if (a && b) km += haversineKm(a.stop_lat, a.stop_lon, b.stop_lat, b.stop_lon);
    }
  }
  if (km <= 0) return 20 * 60; // last-resort default: 20 min.
  const hours = km / (mph * 1.60934);
  return Math.max(60, Math.round(hours * 3600));
}

/**
 * Relative seconds-from-start for each stop in the pattern, interpolating the
 * single reference run time across intermediate stops. Uses shape-distance
 * proportions when geometry is available (matching the store's
 * interpolateStopTimes), else even spacing. First stop = 0, last = runSecs.
 */
function relativeOffsets(params: GenerateTripsParams, ordered: RouteStop[]): number[] {
  const n = ordered.length;
  if (n === 1) return [0];

  // Build a cumulative distance per stop. Prefer projecting onto the shape via
  // nearest-point (cheap squared-degree distance, same as interpolateStopTimes);
  // fall back to even index spacing.
  let distances: number[] | null = null;
  if (params.shape && params.shape.points.length >= 2 && params.stops) {
    const byId = new Map(params.stops.map((s) => [s.stop_id, s]));
    const pts = params.shape.points;
    const ds: number[] = [];
    let usable = true;
    for (const rs of ordered) {
      const stop = byId.get(rs.stop_id);
      if (!stop) { usable = false; break; }
      let best = Infinity;
      let bestDist = 0;
      for (const p of pts) {
        const dlat = p.shape_pt_lat - stop.stop_lat;
        const dlon = p.shape_pt_lon - stop.stop_lon;
        const d = dlat * dlat + dlon * dlon;
        if (d < best) { best = d; bestDist = p.shape_dist_traveled; }
      }
      ds.push(bestDist);
    }
    // Only trust shape distances if they're monotonic-ish and span a range.
    if (usable && ds[ds.length - 1] - ds[0] > 0) distances = ds;
  }

  const out: number[] = [];
  const firstD = distances ? distances[0] : 0;
  const span = distances ? distances[n - 1] - distances[0] : n - 1;
  for (let i = 0; i < n; i++) {
    const along = distances ? distances[i] - firstD : i;
    const ratio = span > 0 ? Math.min(1, Math.max(0, along / span)) : i / (n - 1);
    out.push(Math.round(ratio * params.runSecs));
  }
  // Guarantee monotonic non-decreasing offsets (degenerate shapes can wobble).
  for (let i = 1; i < n; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  out[n - 1] = params.runSecs;
  return out;
}

/** Validate the inputs and report how many trips explicit mode would create. */
export function validateGenerateParams(
  params: Pick<GenerateTripsParams, 'startTime' | 'endTime' | 'headwaySecs' | 'runSecs' | 'routeStops'>,
): GenerateValidation {
  const start = gtfsTimeToSeconds(params.startTime);
  const end = gtfsTimeToSeconds(params.endTime);
  if (!params.routeStops || params.routeStops.length < 2) {
    return { ok: false, error: 'This pattern needs at least two stops before you can generate service.', tripCount: 0 };
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, error: 'Enter valid start and end times (e.g. 06:00).', tripCount: 0 };
  }
  if (end < start) {
    return { ok: false, error: 'The end time must be at or after the start time.', tripCount: 0 };
  }
  if (!(params.headwaySecs > 0)) {
    return { ok: false, error: 'Headway must be a positive number of minutes.', tripCount: 0 };
  }
  if (!(params.runSecs > 0)) {
    return { ok: false, error: 'Run time must be a positive number of minutes.', tripCount: 0 };
  }
  const tripCount = Math.floor((end - start) / params.headwaySecs) + 1;
  return { ok: true, tripCount };
}

/**
 * Generate trips for a pattern. In explicit mode (default), one Trip per
 * departure; in frequency mode, a single reference trip plus a frequencies.txt
 * window. Returns the rows to commit — never touches the store.
 */
export function generateTrips(params: GenerateTripsParams): GenerateTripsResult {
  const v = validateGenerateParams(params);
  if (!v.ok) return { trips: [], stopTimes: [], frequencies: [] };

  const ordered = [...params.routeStops].sort((a, b) => a.stop_sequence - b.stop_sequence);
  const offsets = relativeOffsets(params, ordered);
  const startSec = gtfsTimeToSeconds(params.startTime);
  const endSec = gtfsTimeToSeconds(params.endTime);
  const prefix = params.tripIdPrefix || `${params.routeId}-d${params.directionId}-${params.serviceId}`;

  const trips: Trip[] = [];
  const stopTimes: StopTime[] = [];
  const frequencies: Frequency[] = [];

  const makeTrip = (tripId: string): Trip => ({
    trip_id: tripId,
    route_id: params.routeId,
    service_id: params.serviceId,
    direction_id: params.directionId,
    trip_headsign: params.headsign || undefined,
    shape_id: params.shapeId,
  });

  const layStopTimes = (tripId: string, depSec: number) => {
    ordered.forEach((rs, i) => {
      const t = secondsToGtfsTime(depSec + offsets[i]);
      const isEndpoint = i === 0 || i === ordered.length - 1;
      stopTimes.push({
        trip_id: tripId,
        stop_id: rs.stop_id,
        stop_sequence: rs.stop_sequence,
        arrival_time: t,
        departure_time: t,
        // Endpoints are real timed points; intermediate stops are interpolated
        // (timepoint=0), which the exporter and validator already expect.
        timepoint: isEndpoint ? 1 : 0,
      });
    });
  };

  const existing = new Set<string>(params.existingTripIds ?? []);

  if (params.mode === 'frequency') {
    let tripId = `${prefix}-freq`;
    while (existing.has(tripId)) tripId = `${tripId}b`;
    trips.push(makeTrip(tripId));
    layStopTimes(tripId, startSec);
    frequencies.push({
      trip_id: tripId,
      start_time: secondsToGtfsTime(startSec),
      // frequencies windows are half-open [start, end); end one headway past the
      // last departure so the final trip is included.
      end_time: secondsToGtfsTime(endSec + params.headwaySecs),
      headway_secs: params.headwaySecs,
      exact_times: 0,
    });
    return { trips, stopTimes, frequencies };
  }

  // explicit mode — one trip per departure
  for (let depSec = startSec, i = 0; depSec <= endSec; depSec += params.headwaySecs, i++) {
    let tripId = `${prefix}-${HHMM(depSec)}`;
    // Sub-minute headways (collide on HHMM) or an existing same-named trip get a
    // deterministic suffix.
    while (existing.has(tripId)) tripId = `${tripId}b`;
    existing.add(tripId);
    trips.push(makeTrip(tripId));
    layStopTimes(tripId, depSec);
  }

  return { trips, stopTimes, frequencies };
}
