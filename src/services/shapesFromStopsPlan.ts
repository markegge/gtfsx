// "Shapes from stops" — the PURE planning half of the recipe.
//
// Split out from shapesFromStops.ts on purpose. The validation rule calls
// feedNeedsShapes() inside the validation memo (i.e. on every store change), and
// validation.ts must stay importable in a plain-Node context: the editor
// integration harness (run-tests.ts, run through tsx) executes this source
// directly, with no Vite. shapesFromStops.ts imports snapToRoad.ts, which reads
// `import.meta.env.VITE_MAPBOX_TOKEN` at module scope — a Vite-only construct
// that throws the moment the module is merely LOADED under plain Node. Keeping
// the pure functions here means a validation rule never drags a Mapbox HTTP
// client into its import graph, which is both the correct layering and what
// keeps the editor tests loadable.
//
// Everything in this file is a pure function of its arguments: no store access,
// no network, no side effects.

import type { Trip, StopTime, Stop, Shape } from '../types/gtfs';

/** A unique ordered-stop pattern that needs geometry: all trips on one
 *  (route, direction) that visit the exact same ordered list of stops and
 *  currently lack a resolvable shape. One shape is generated per pattern. */
export interface StopPattern {
  routeId: string;
  directionId: 0 | 1;
  /** The ordered served stop_ids — the pattern fingerprint. A stop_id may
   *  repeat (e.g. a loop returning to its origin). */
  stopIds: string[];
  /** Ordered [lng, lat] for each served stop (parallel to stopIds). */
  coords: [number, number][];
  /** Trips that follow this exact ordered stop sequence (and lack a shape). */
  tripIds: string[];
  /** Stable dedupe key. */
  key: string;
}

/** Separators for the pattern key. Control characters, so they can't appear in
 *  a GTFS id and the key stays an injective encoding of (route, dir, stops).
 *  A bare concatenation would merge ["a","bc"] with ["ab","c"] onto one shape. */
export const KEY_SEP = '\u0000';
export const STOP_SEP = '\u0001';

/** The shape_ids that actually carry geometry. A shape row with 0 or 1 points
 *  can't render a line, so a trip pointing at one is as shapeless as a trip with
 *  no shape_id at all. This is what makes the recipe fire on a real RTAP feed,
 *  whose shapes.txt is PRESENT but header-only (zero rows), not absent. */
function usableShapeIds(shapes: Shape[]): Set<string> {
  const ids = new Set<string>();
  for (const s of shapes) if (s.points.length >= 2) ids.add(s.shape_id);
  return ids;
}

/** A trip is shapeless when its shape_id is unset, dangling (no such shape), or
 *  points at a shape with <2 points. */
function isShapeless(trip: Trip, usable: Set<string>): boolean {
  return !trip.shape_id || !usable.has(trip.shape_id);
}

/** direction_id is typed 0|1 but imported feeds routinely omit the column, so
 *  treat a missing direction as outbound (0) — the same default the importer and
 *  timetable use. (Real RTAP feeds model each direction as a SEPARATE route and
 *  leave direction_id=0 throughout, which this handles fine.) */
export function dirOf(directionId: 0 | 1 | undefined): 0 | 1 {
  return directionId === 1 ? 1 : 0;
}

/**
 * Group every trip that lacks a *resolvable* shape into unique ordered-stop
 * patterns, keyed by (route_id, direction_id, ordered served stop_ids).
 *
 * "Resolvable shape" = trip.shape_id is set AND a Shape with that id exists AND
 * that shape has >= 2 points. Trips whose shape_id is empty, dangling, or points
 * at an empty shape are considered shapeless and included.
 *
 * A trip's ordered served stops come from stopTimes filtered by trip_id, sorted
 * by stop_sequence, each resolved to its Stop's [stop_lon, stop_lat]. Trips with
 * fewer than 2 locatable stops are dropped (no line to draw). Patterns are
 * returned sorted by routeId then directionId then key for stable output.
 *
 * PURE — no store access; fully unit-testable.
 */
export function computeStopPatterns(
  trips: Trip[],
  stopTimes: StopTime[],
  stops: Stop[],
  shapes: Shape[],
): StopPattern[] {
  const usable = usableShapeIds(shapes);
  const shapelessTrips = trips.filter((t) => isShapeless(t, usable));
  if (shapelessTrips.length === 0) return [];

  // Index in single passes. A real feed has tens of thousands of stop_times, so
  // a per-trip .filter() over the whole array would be O(trips × stop_times) and
  // lock the tab up.
  const stopById = new Map<string, Stop>();
  for (const s of stops) stopById.set(s.stop_id, s);

  const shapelessTripIds = new Set(shapelessTrips.map((t) => t.trip_id));
  const timesByTrip = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    // Only the trips we might build a pattern for — a feed that's half-shaped
    // shouldn't pay to index the shaped trips' stop_times.
    if (!shapelessTripIds.has(st.trip_id)) continue;
    const existing = timesByTrip.get(st.trip_id);
    if (existing) existing.push(st);
    else timesByTrip.set(st.trip_id, [st]);
  }

  const byKey = new Map<string, StopPattern>();
  for (const trip of shapelessTrips) {
    const times = timesByTrip.get(trip.trip_id);
    if (!times || times.length < 2) continue;

    // Copy before sorting — `times` is our index's array, and the caller's
    // stopTimes array must not be reordered by a "pure" function.
    const ordered = [...times].sort((a, b) => a.stop_sequence - b.stop_sequence);

    const stopIds: string[] = [];
    const coords: [number, number][] = [];
    for (const st of ordered) {
      const stop = stopById.get(st.stop_id);
      // A stop_time whose stop_id doesn't resolve (or whose stop has no usable
      // coordinates) contributes no vertex — it's simply not part of the line.
      if (!stop || !Number.isFinite(stop.stop_lat) || !Number.isFinite(stop.stop_lon)) continue;
      stopIds.push(stop.stop_id);
      coords.push([stop.stop_lon, stop.stop_lat]);
    }
    if (coords.length < 2) continue; // nothing to draw

    const directionId = dirOf(trip.direction_id);
    // The fingerprint is the FULL ordered list, not a Set — a loop route can
    // legitimately visit the same stop twice (and start/end at the same one),
    // and two trips only share a shape if they visit the same stops in the same
    // order.
    const key = `${trip.route_id}${KEY_SEP}${directionId}${KEY_SEP}${stopIds.join(STOP_SEP)}`;

    const existing = byKey.get(key);
    if (existing) {
      existing.tripIds.push(trip.trip_id);
    } else {
      byKey.set(key, {
        routeId: trip.route_id,
        directionId,
        stopIds,
        coords,
        tripIds: [trip.trip_id],
        key,
      });
    }
  }

  // Stable output: route, then direction, then key. Trips within a pattern stay
  // in feed order (push order above).
  return [...byKey.values()].sort(
    (a, b) =>
      a.routeId.localeCompare(b.routeId) ||
      a.directionId - b.directionId ||
      a.key.localeCompare(b.key),
  );
}

/**
 * True when the feed would benefit from this recipe: it has at least one trip
 * with >= 2 locatable served stops but no resolvable shape geometry. Drives the
 * validation warning and the import-time shapeless/RTAP callout. PURE.
 */
export function feedNeedsShapes(
  trips: Trip[],
  stopTimes: StopTime[],
  stops: Stop[],
  shapes: Shape[],
): boolean {
  // This runs inside the validation memo on every store change, so it's written
  // to bail out early rather than build the full pattern list: a healthy feed
  // exits before it ever touches stop_times, and a shapeless one returns true on
  // the first qualifying trip.
  const usable = usableShapeIds(shapes);
  const shapelessTripIds = new Set<string>();
  for (const t of trips) if (isShapeless(t, usable)) shapelessTripIds.add(t.trip_id);
  if (shapelessTripIds.size === 0) return false;

  const locatableStopIds = new Set<string>();
  for (const s of stops) {
    if (Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon)) locatableStopIds.add(s.stop_id);
  }
  if (locatableStopIds.size < 2) return false;

  // One pass over stop_times, counting locatable stops per shapeless trip and
  // returning the moment any trip reaches 2 (enough to draw a line).
  const counts = new Map<string, number>();
  for (const st of stopTimes) {
    if (!shapelessTripIds.has(st.trip_id)) continue;
    if (!locatableStopIds.has(st.stop_id)) continue;
    const n = (counts.get(st.trip_id) ?? 0) + 1;
    if (n >= 2) return true;
    counts.set(st.trip_id, n);
  }
  return false;
}
