/**
 * Marey (time–distance) diagram data prep.
 *
 * A Marey chart plots time of day on the x-axis and distance along the route on
 * the y-axis. Each trip is one polyline connecting its stop_times: the slope of
 * a segment is speed, the horizontal gap between two trips' lines is the
 * headway. This module is the pure data layer — it derives per-stop distances
 * along the route and turns a route's trips + stop_times into plottable
 * polylines. The React component (MareyChart.tsx) owns the SVG rendering.
 *
 * Distance derivation (in priority order):
 *   1. Project each stop onto the route's shape and measure cumulative length
 *      along the shape (great-circle). This is the honest geometry and matches
 *      how the map draws the route. `shape_dist_traveled` is intentionally NOT
 *      trusted here — GTFS leaves its unit undefined, the same reason
 *      stopAnalysis.ts avoids it.
 *   2. If there's no usable shape, fall back to cumulative great-circle
 *      distance between consecutive stops (the straight-line polyline through
 *      the stops in order).
 *   3. If a stop has no coordinates at all, fall back to evenly-spaced by
 *      sequence so the row still renders.
 */
import nearestPointOnLine from '@turf/nearest-point-on-line';
import distance from '@turf/distance';
import { lineString, point } from '@turf/helpers';
import { gtfsTimeToSeconds } from '../utils/time';
import type { Shape, Stop, StopTime } from '../types/gtfs';
import type { VirtualTrip } from './frequencyExpansion';

export type LngLat = [number, number];

/** A single stop on the Marey y-axis. */
export interface MareyStop {
  stopId: string;
  stopName: string;
  /** Distance along the route in kilometres, from the first stop (0). */
  distanceKm: number;
}

/** One plotted vertex of a trip's polyline. */
export interface MareyPoint {
  stopId: string;
  /** Seconds since midnight (can exceed 86400 for overnight trips). */
  timeSec: number;
  distanceKm: number;
}

/** One trip's polyline through the chart. */
export interface MareyTrip {
  tripId: string;
  headsign?: string;
  points: MareyPoint[];
  /** A read-only frequency projection (item #10), drawn lighter/dashed. The
   *  editable template trip is a normal (non-derived) line at full weight. */
  derived?: boolean;
  /** Derived lines only: the template + headway behind them, for the hover
   *  label and the approximate-times cue. */
  templateTripId?: string;
  headwaySecs?: number;
  exactTimes?: 0 | 1;
}

export interface MareyData {
  stops: MareyStop[];
  trips: MareyTrip[];
  /** Total route length used for the y-axis extent (km). */
  maxDistanceKm: number;
  /** Earliest / latest plotted times across all trips (seconds since midnight). */
  minTimeSec: number;
  maxTimeSec: number;
  /** True when at least one plotted trip reaches past 24:00:00. */
  hasOvernight: boolean;
  /** How stop distances were derived — surfaced to the user. */
  distanceSource: 'shape' | 'stops' | 'sequence';
}

/** Ordered [lng, lat] vertices of a shape (empty if it has < 2 points). */
export function shapeCoords(shape: Shape | undefined): LngLat[] {
  if (!shape || shape.points.length < 2) return [];
  return [...shape.points]
    .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
    .map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat);
}

/**
 * Cumulative great-circle distance (km) along `coords` at each vertex.
 * cumDist[0] === 0; length === coords.length.
 */
function cumulativeDistanceKm(coords: LngLat[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + distance(coords[i - 1], coords[i], { units: 'kilometers' }));
  }
  return cum;
}

/**
 * Distance (km) along the shape at which each stop projects, in stop order.
 * Returns null if the shape is unusable so the caller can fall back.
 */
export function stopDistancesAlongShape(
  coords: LngLat[],
  stopCoords: LngLat[],
): number[] | null {
  if (coords.length < 2 || stopCoords.length === 0) return null;
  const cumDist = cumulativeDistanceKm(coords);
  const line = lineString(coords);
  return stopCoords.map((sc) => {
    const npl = nearestPointOnLine(line, point(sc), { units: 'kilometers' });
    let idx = npl.properties.index ?? 0;        // segment index
    const loc = npl.properties.location ?? 0;   // km along the whole line
    if (idx >= coords.length - 1) idx = Math.max(0, coords.length - 2);
    const segStart = cumDist[idx] ?? 0;
    const segEnd = cumDist[idx + 1] ?? segStart;
    const frac = segEnd > segStart
      ? Math.min(1, Math.max(0, (loc - segStart) / (segEnd - segStart)))
      : 0;
    return segStart + frac * (segEnd - segStart);
  });
}

/**
 * Cumulative straight-line distance (km) through the stops in order. Stops
 * missing coordinates contribute a zero-length segment (the previous distance
 * carries forward), which keeps the array monotonic.
 */
export function stopDistancesStraightLine(stopCoords: (LngLat | null)[]): number[] {
  const out: number[] = [];
  let cum = 0;
  let prev: LngLat | null = null;
  for (const sc of stopCoords) {
    if (sc && prev) cum += distance(prev, sc, { units: 'kilometers' });
    out.push(cum);
    if (sc) prev = sc;
  }
  return out;
}

/** Has a stop got finite, plottable coordinates? */
function hasCoords(s: Stop | undefined): s is Stop {
  return !!s && Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon);
}

export interface BuildMareyInput {
  /** Ordered stops for the route/direction/shape being charted. */
  orderedStops: Stop[];
  /** The shape backing those stops, if any. */
  shape?: Shape;
  /** Trips to plot, in display order. */
  trips: { trip_id: string; trip_headsign?: string }[];
  /** stop_times grouped by trip_id (e.g. from useStopTimesIndex's byTrip). */
  stopTimesByTrip: Map<string, StopTime[]>;
  /** Frequency projections to draw as derived lines (item #10). Same pure
   *  expansion the grid uses; each carries its own shifted stop_times. */
  virtualTrips?: VirtualTrip[];
}

/**
 * Build the full Marey dataset for a route view. Pure — no store / React.
 *
 * Y positions come from `deriveStopDistances`; X positions come from each
 * trip's stop_times (departure preferred, arrival fallback). A trip only
 * contributes points for stops it actually has a time for, so partial trips
 * render a shorter line rather than breaking.
 */
export function buildMareyData(input: BuildMareyInput): MareyData {
  const { orderedStops, shape, trips, stopTimesByTrip } = input;

  const { distances, source } = deriveStopDistances(orderedStops, shape);

  const stops: MareyStop[] = orderedStops.map((s, i) => ({
    stopId: s.stop_id,
    stopName: s.stop_name || s.stop_id,
    distanceKm: distances[i],
  }));
  const distByStopId = new Map(stops.map((s) => [s.stopId, s.distanceKm]));
  const maxDistanceKm = stops.length ? Math.max(...distances) : 0;

  let minTimeSec = Infinity;
  let maxTimeSec = -Infinity;
  let hasOvernight = false;

  // Project a trip's stop_times onto the chart, tracking the shared time bounds
  // and overnight flag. Shared by real trips and the derived frequency lines.
  const plotPoints = (sts: StopTime[]): MareyPoint[] => {
    const byStop = new Map<string, StopTime>();
    for (const st of sts) byStop.set(st.stop_id, st);
    const points: MareyPoint[] = [];
    for (const s of stops) {
      const st = byStop.get(s.stopId);
      if (!st) continue;
      const timeStr = st.departure_time || st.arrival_time;
      if (!timeStr) continue;
      const timeSec = gtfsTimeToSeconds(timeStr);
      if (timeSec >= 24 * 3600) hasOvernight = true;
      points.push({ stopId: s.stopId, timeSec, distanceKm: distByStopId.get(s.stopId) ?? 0 });
      if (timeSec < minTimeSec) minTimeSec = timeSec;
      if (timeSec > maxTimeSec) maxTimeSec = timeSec;
    }
    return points;
  };

  const mareyTrips: MareyTrip[] = [];
  for (const trip of trips) {
    const sts = stopTimesByTrip.get(trip.trip_id);
    if (!sts || sts.length === 0) continue;
    const points = plotPoints(sts);
    if (points.length < 2) continue; // a single point can't draw a line
    mareyTrips.push({ tripId: trip.trip_id, headsign: trip.trip_headsign, points });
  }

  // Derived frequency projections — the same expansion the grid renders, drawn
  // as extra (lighter/dashed) lines. Never stored or exported.
  for (const vt of input.virtualTrips ?? []) {
    const points = plotPoints(vt.stopTimes);
    if (points.length < 2) continue;
    mareyTrips.push({
      tripId: vt.key,
      points,
      derived: true,
      templateTripId: vt.templateTripId,
      headwaySecs: vt.headwaySecs,
      exactTimes: vt.exactTimes,
    });
  }

  if (!Number.isFinite(minTimeSec)) { minTimeSec = 0; maxTimeSec = 0; }

  return {
    stops,
    trips: mareyTrips,
    maxDistanceKm,
    minTimeSec,
    maxTimeSec,
    hasOvernight,
    distanceSource: source,
  };
}

/**
 * Per-stop distance along the route, with graceful fallbacks. Returns the
 * distance array (one entry per ordered stop) plus which method produced it.
 */
export function deriveStopDistances(
  orderedStops: Stop[],
  shape?: Shape,
): { distances: number[]; source: MareyData['distanceSource'] } {
  if (orderedStops.length === 0) return { distances: [], source: 'sequence' };

  const coordsOrNull: (LngLat | null)[] = orderedStops.map((s) =>
    hasCoords(s) ? [s.stop_lon, s.stop_lat] : null,
  );
  const everyStopHasCoords = coordsOrNull.every((c) => c !== null);

  // 1. Project onto the shape when we have one and every stop has coordinates.
  const coords = shapeCoords(shape);
  if (coords.length >= 2 && everyStopHasCoords) {
    const along = stopDistancesAlongShape(coords, coordsOrNull as LngLat[]);
    if (along) {
      // Projection can run "backwards" for a few stops (a stop closest to a
      // later part of the shape). Enforce monotonic non-decreasing so the
      // y-axis reads in stop order — clamp each to at least the previous.
      const mono = enforceMonotonic(along);
      if (mono[mono.length - 1] > 0) return { distances: mono, source: 'shape' };
    }
  }

  // 2. Straight-line through the stops we do have coordinates for.
  if (coordsOrNull.some((c) => c !== null)) {
    const sl = stopDistancesStraightLine(coordsOrNull);
    if (sl[sl.length - 1] > 0) return { distances: sl, source: 'stops' };
  }

  // 3. Evenly spaced by sequence (no usable geometry at all).
  const n = orderedStops.length;
  return {
    distances: orderedStops.map((_, i) => (n > 1 ? i / (n - 1) : 0)),
    source: 'sequence',
  };
}

/** Clamp each value to at least the running max so the series never decreases. */
export function enforceMonotonic(values: number[]): number[] {
  const out: number[] = [];
  let running = -Infinity;
  for (const v of values) {
    running = Math.max(running, v);
    out.push(running);
  }
  return out;
}
