// "Shapes from stops" repair recipe — auto-generate shapes.txt route geometry
// for a feed that has none.
//
// WHY: Feeds built with tools like National RTAP's GTFS Builder commonly ship
// with stops + stop_times but NO shapes.txt (shapes are an optional, more
// advanced step in that tool). In consumers those routes render as straight
// "as-the-crow-flies" lines between stops. This recipe reconstructs a plausible
// geometry per unique stop sequence by ROUTING the ordered stops along the road
// network as waypoints (Mapbox Directions, via services/routeGeometry.ts — the
// same primitive the timetable's "Estimate times" uses), deduped so trips that
// share a stop pattern share one shape, then writes shapes.txt and links
// shape_id back onto the trips.
//
// NOT Map Matching (services/snapToRoad.ts). That was the first cut and it was
// badly wrong: Map Matching expects a dense GPS-style trace, so on a real rural
// feed (Skyline, Bozeman↔Big Sky — stops MILES apart) it matched one cluster,
// split the trace, and returned stubs covering 3-7% of the corridor. Every
// generated geometry is now length-checked against the crow-flies line through
// its own stops before it's written (MIN_ROUTED_LENGTH_RATIO), so a truncated
// route can never be saved as a shape again.
//
// The pure planning functions (computeStopPatterns, feedNeedsShapes) take plain
// arrays so they're unit-testable; generateShapesFromStops reads + mutates the
// store (mirrors createDrawnShape in routeShapes.ts) and returns an undo handle
// shaped like the validation-fix recipes (ValidationFixResult) so the panel's
// existing undo toast can reverse the whole batch.
//
// Gating: intentionally UNGATED (all tiers, incl. free "Editor"), matching the
// existing Mapbox snap/estimate features — and RTAP's rural-agency audience is
// exactly who benefits. Do NOT add a plan gate.

import type { RouteStop, ShapePoint } from '../types/gtfs';
import { useStore } from '../store';
import { generateId } from './idGenerator';
import { simplifyShapePoints } from './simplifyShape';
import { routeThroughStops, pathLengthMeters } from './routeGeometry';
import { computeStopPatterns, dirOf, KEY_SEP, STOP_SEP } from './shapesFromStopsPlan';
import type { StopPattern } from './shapesFromStopsPlan';

// The PURE planning half (computeStopPatterns / feedNeedsShapes) lives in
// shapesFromStopsPlan.ts, NOT here. This module imports routeGeometry, which
// reads `import.meta.env.VITE_MAPBOX_TOKEN` at module scope — a Vite-only
// construct that throws when the module is merely loaded under plain Node.
// validation.ts calls feedNeedsShapes and must stay loadable in the tsx
// editor-test harness, so it imports the plan module directly. Re-exported here
// so UI callers still have a single import site for the whole recipe.
export { computeStopPatterns, feedNeedsShapes } from './shapesFromStopsPlan';
export type { StopPattern } from './shapesFromStopsPlan';

export type ShapeGenMode = 'snap' | 'straight';

export type PatternOutcome =
  | 'snapped'   // routed along roads through every stop
  | 'partial'   // only part of the stop chain routed; the rest is straight — review advised
  | 'straight'  // straight lines between stops ('straight' mode, Directions failed,
                // or the routed geometry failed the length sanity check)
  | 'skipped'   // <2 served stops with coordinates — no line to draw
  | 'failed';   // unexpected error writing this pattern

export interface PatternResult {
  pattern: StopPattern;
  /** The shape_id created for this pattern, or null when skipped/failed. */
  shapeId: string | null;
  outcome: PatternOutcome;
  /** Number of points written to the generated shape. */
  pointCount: number;
}

export interface ShapesFromStopsSummary {
  patternsTotal: number;
  shapesCreated: number;
  tripsUpdated: number;
  /** snapped-but-truncated patterns the user may want to review. */
  partialCount: number;
  /** patterns that fell back to straight lines. */
  straightCount: number;
  /** patterns skipped (too few located stops). */
  skippedCount: number;
  results: PatternResult[];
  /** Reverse the whole batch: remove created shapes, restore prior trip.shape_id
   *  and route_stop.shape_id. Shaped for the validation panel's undo toast. */
  undo: () => void;
}

export interface ShapesFromStopsOptions {
  /** 'snap' (default) routes each pattern's stops along the roads that connect
   *  them (Mapbox Directions, stops as waypoints); 'straight' just connects the
   *  stops with straight segments (no network calls). */
  mode: ShapeGenMode;
  /** Called after each pattern is processed so the dialog can show a progress bar. */
  onProgress?: (done: number, total: number) => void;
  /** Abort mid-run (dialog cancel). Already-written patterns stay written; the
   *  returned summary's undo() still reverses everything done so far. */
  signal?: AbortSignal;
}

/**
 * How many Directions calls may be in flight at once in 'snap' mode.
 *
 * One round-trip per pattern run serially is minutes of dead time on a big feed
 * (a 200-pattern agency), but an unbounded fan-out would blow through Mapbox's
 * rate limit (~300 req/min) and earn a 429 — which this recipe would then report
 * as a wall of failed patterns. 5 keeps a large feed well inside the limit while
 * cutting wall-clock time ~5x.
 */
export const SNAP_CONCURRENCY = 5;

/**
 * SANITY GUARD. A generated geometry must be at least this fraction of the
 * crow-flies distance through its own stops, or we throw it away and use the
 * straight line instead.
 *
 * A road route between two points is essentially never SHORTER than the straight
 * line between them (roads bend around things; the geodesic is the floor), so a
 * ratio below 1 means the geometry doesn't actually reach the stops — it's
 * truncated. That is exactly what shipped-and-was-caught with Map Matching:
 * shapes at 0.03-0.41 of crow-flies, i.e. stubs covering 3-40% of the corridor,
 * strictly worse than the straight line they replaced. 0.9 leaves headroom for
 * the small honest shortfalls (a waypoint snapped to a road a few metres off the
 * stop, geodesic-vs-projected rounding) while rejecting any real truncation.
 */
const MIN_ROUTED_LENGTH_RATIO = 0.9;

/** Above this point count a generated shape gets Ramer-Douglas-Peucker'd, same
 *  as a freehand-drawn one (createDrawnShape). Map Matching returns the full
 *  road geometry, which for a long route is thousands of vertices. */
const SIMPLIFY_ABOVE_POINTS = 20;
/** ~5m — the "light simplify" tolerance createDrawnShape uses. */
const SIMPLIFY_TOLERANCE = 0.00005;

/** A route_stop we retagged with a generated shape_id, plus its prior value so
 *  undo can put it back. Keyed by the route_stop's per-instance `_uid` where
 *  present (a pattern may list the same stop_id twice, so stop_id can't identify
 *  a row); the composite fallback covers rows from an older snapshot that
 *  predates `_uid`. */
interface RouteStopShapeChange {
  identity: string;
  prev: string | undefined;
}

function routeStopIdentity(rs: RouteStop): string {
  return rs._uid ?? `${rs.route_id}${KEY_SEP}${dirOf(rs.direction_id)}${KEY_SEP}${rs.stop_sequence}${KEY_SEP}${rs.stop_id}`;
}

/**
 * Write one shape from an ordered coordinate list. Mirrors createDrawnShape
 * (routeShapes.ts) — including its simplify step, which matters more here than
 * for a drawn line: Map Matching returns the full road geometry, so a long route
 * comes back with thousands of vertices.
 *
 * Deliberately does NOT set `_route_id`: that editor-only field exists so a
 * freshly DRAWN shape with no trip yet still shows up in the Route Shapes panel.
 * Ours are linked to real trips a moment later, which is how a shape's route is
 * canonically derived (deriveRouteShapeIds), and a stray `_route_id` would make
 * these look like draft shapes to the code paths that special-case them.
 */
function writeShape(coords: [number, number][]): { shapeId: string; pointCount: number } {
  const shapeId = generateId('shape');
  let points: ShapePoint[] = coords.map((c, i) => ({
    shape_pt_lat: c[1],
    shape_pt_lon: c[0],
    shape_pt_sequence: i,
    shape_dist_traveled: 0,
  }));
  if (points.length > SIMPLIFY_ABOVE_POINTS) {
    points = simplifyShapePoints(points, SIMPLIFY_TOLERANCE);
  }

  const st = useStore.getState();
  st.addShape({ shape_id: shapeId, points });
  // Populate shape_dist_traveled (addShape stores the points verbatim, with 0s).
  st.recalcShapeDistances(shapeId);
  return { shapeId, pointCount: points.length };
}

/**
 * Best-effort: tag the route's stop list with the shape we just made, so the
 * Route Shapes panel and the per-shape stop list resolve for these routes.
 *
 * Deliberately conservative. route_stops are keyed PER SHAPE, and the importer
 * builds them from the first trip of each direction (gtfsParse.ts), so for a
 * shapeless feed a (route, direction) has exactly one untagged stop list. We
 * only tag it when it is unambiguous:
 *   - every route_stop in that (route, direction) currently has no shape_id
 *     (a partially-shaped route is already keyed per shape — don't touch it), and
 *   - exactly ONE of our generated patterns for that (route, direction) has the
 *     same ordered stop_ids as that list.
 * A route with branches / short-turns in one direction yields several patterns,
 * and the single stop list can only belong to one of them — if the ordered
 * stop_ids don't pick out exactly one, we SKIP rather than guess. trip.shape_id
 * plus shapes.txt is the must-have; route_stop.shape_id is only an editor nicety,
 * and a wrong one would misfile the stops under the wrong shape.
 *
 * Returns the changes it made, for undo.
 */
function linkRouteStops(created: { pattern: StopPattern; shapeId: string }[]): RouteStopShapeChange[] {
  if (created.length === 0) return [];

  const byGroup = new Map<string, { pattern: StopPattern; shapeId: string }[]>();
  for (const c of created) {
    const groupKey = `${c.pattern.routeId}${KEY_SEP}${c.pattern.directionId}`;
    const existing = byGroup.get(groupKey);
    if (existing) existing.push(c);
    else byGroup.set(groupKey, [c]);
  }

  const routeStops = useStore.getState().routeStops;
  // Index the route's stop lists by the same (route, direction) key, in one pass.
  const stopsByGroup = new Map<string, RouteStop[]>();
  for (const rs of routeStops) {
    const groupKey = `${rs.route_id}${KEY_SEP}${dirOf(rs.direction_id)}`;
    const existing = stopsByGroup.get(groupKey);
    if (existing) existing.push(rs);
    else stopsByGroup.set(groupKey, [rs]);
  }

  // identity → the shape_id to tag it with.
  const assign = new Map<string, string>();
  const changes: RouteStopShapeChange[] = [];

  for (const [groupKey, entries] of byGroup) {
    const group = [...(stopsByGroup.get(groupKey) ?? [])].sort(
      (a, b) => a.stop_sequence - b.stop_sequence,
    );
    if (group.length < 2) continue;
    if (group.some((rs) => rs.shape_id)) continue; // already keyed per shape

    const fingerprint = group.map((rs) => rs.stop_id).join(STOP_SEP);
    const matches = entries.filter((e) => e.pattern.stopIds.join(STOP_SEP) === fingerprint);
    if (matches.length !== 1) continue; // no match, or ambiguous → leave untagged

    for (const rs of group) {
      assign.set(routeStopIdentity(rs), matches[0].shapeId);
      changes.push({ identity: routeStopIdentity(rs), prev: rs.shape_id });
    }
  }

  if (assign.size === 0) return [];
  // There's no per-route_stop shape_id action on the slice (addRouteStop /
  // removeRouteStop / reorderRouteStops all do more than we want), so retag via
  // setRouteStops with a mapped copy — untouched rows are passed through by
  // reference, so nothing else in the list changes.
  useStore.getState().setRouteStops(
    routeStops.map((rs) => {
      const shapeId = assign.get(routeStopIdentity(rs));
      return shapeId ? { ...rs, shape_id: shapeId } : rs;
    }),
  );
  return changes;
}

/** One pattern's geometry, resolved (snapped or straight) but NOT yet written to
 *  the store. `undefined` at an index means that pattern was never processed —
 *  the run aborted before it was scheduled. */
interface PreparedPattern {
  pattern: StopPattern;
  coords: [number, number][];
  outcome: PatternOutcome;
}

/**
 * Route one pattern's stops along the road network and vet the result.
 *
 * The vetting is the important half: Directions can only return a geometry that
 * reaches every waypoint, but a partially-routed chain (or a bad response) can
 * still come back short, and a shape that doesn't span its own stops is worse
 * than no shape at all. Anything under MIN_ROUTED_LENGTH_RATIO of the crow-flies
 * length through the same stops is discarded for the straight line.
 */
async function resolvePatternGeometry(pattern: StopPattern): Promise<PreparedPattern> {
  const straight: PreparedPattern = {
    pattern,
    coords: pattern.coords,
    outcome: 'straight',
  };

  const routed = await routeThroughStops(pattern.coords);
  if (routed.status === 'failed') return straight;

  // The straight line through the stops is the length FLOOR for any honest road
  // route: roads only ever detour around things.
  const crowFlies = pathLengthMeters(pattern.coords);
  const routedLength = pathLengthMeters(routed.coords);
  if (crowFlies > 0 && routedLength < MIN_ROUTED_LENGTH_RATIO * crowFlies) {
    // Truncated — the geometry doesn't actually connect the stops. Throw it away.
    return straight;
  }

  return {
    pattern,
    coords: routed.coords,
    // 'partial' = some window of the stop chain didn't route and is straight
    // in-line; the geometry still spans the corridor (it passed the guard), so
    // it's worth keeping — flagged for review in the summary.
    outcome: routed.status === 'partial' ? 'partial' : 'snapped',
  };
}

/**
 * Resolve every pattern's geometry, `SNAP_CONCURRENCY` Directions calls in
 * flight at a time, writing each result into `prepared` AT ITS PATTERN INDEX so
 * completion order can't reorder the output.
 *
 * Workers pull the next index off a shared cursor; when the signal aborts they
 * stop pulling (in-flight calls are allowed to finish — their geometry is used
 * if it lands, and undo() reverses whatever ends up written).
 */
async function prepareSnapped(
  patterns: StopPattern[],
  prepared: PreparedPattern[],
  onProgress: ((done: number, total: number) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const total = patterns.length;
  let cursor = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      // Abort = stop taking NEW work. Checked before each pull, so a cancel
      // never schedules another round-trip.
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= total) return;
      const pattern = patterns[i];

      if (pattern.coords.length < 2) {
        prepared[i] = { pattern, coords: pattern.coords, outcome: 'skipped' };
      } else {
        // routeThroughStops chunks internally past the Directions 25-waypoint
        // limit, so hand it the whole stop list.
        prepared[i] = await resolvePatternGeometry(pattern);
      }
      // done is a plain counter, not the cursor: it only ever moves forward, one
      // step per COMPLETED pattern, so the progress bar can't jump or rewind
      // even though patterns finish out of order.
      done++;
      onProgress?.(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SNAP_CONCURRENCY, total) }, () => worker()),
  );
}

/**
 * Generate and write a shape for every shapeless stop pattern in the current
 * store, then link the new shape_id onto each member trip (updateTrip) and, best
 * effort, onto matching route_stops (so the Route Shapes panel shows them).
 *
 * In 'snap' mode each pattern's ordered stops are routed along the road network
 * as waypoints (routeThroughStops, services/routeGeometry.ts): 'routed' →
 * outcome 'snapped', 'partial' (some window of the chain didn't route) → outcome
 * 'partial', 'failed' → the straight stop-to-stop line with outcome 'straight'.
 * Any routed geometry shorter than MIN_ROUTED_LENGTH_RATIO of the crow-flies
 * line through its own stops is DISCARDED for the straight line ('straight'),
 * because it can't be spanning the stops. 'straight' mode skips the network
 * entirely (all outcomes 'straight'). Each written shape gets
 * recalcShapeDistances(shape_id) so shape_dist_traveled is populated (mirrors
 * createDrawnShape).
 *
 * Runs in two phases:
 *   1. PREPARE — resolve each pattern's geometry. In 'snap' mode that's the slow
 *      part (one Mapbox round-trip per pattern; a 200-pattern feed run serially
 *      would stall for minutes), so the calls are fanned out SNAP_CONCURRENCY at
 *      a time. 'straight' mode does no I/O and stays a plain synchronous loop.
 *   2. WRITE — walk the prepared patterns IN PATTERN ORDER and mutate the store
 *      sequentially. Deliberately separated from the fan-out: shape ids are
 *      generated from a module counter and every write is a read-modify-write of
 *      the same zustand state, so racing tasks writing as they land would make
 *      shape ids, shape order, and `results` depend on network timing. With the
 *      network done first, there is exactly one writer and the output is
 *      deterministic — the same feed always produces the same shapes.
 *
 * Reads + mutates the Zustand store via useStore.getState(). Returns a summary
 * whose undo() removes the created shapes and restores every trip.shape_id /
 * route_stop.shape_id it changed, so the caller can wire a single undo toast.
 *
 * Respects opts.signal for cancellation and calls opts.onProgress(done, total).
 * An aborted run still writes (and can still undo) the patterns whose geometry
 * had already resolved when the cancel landed.
 */
export async function generateShapesFromStops(
  opts: ShapesFromStopsOptions,
): Promise<ShapesFromStopsSummary> {
  const { mode, onProgress, signal } = opts;
  const start = useStore.getState();
  const patterns = computeStopPatterns(start.trips, start.stopTimes, start.stops, start.shapes);
  const total = patterns.length;

  // Prior shape_id per trip, captured from the pre-run snapshot (each trip
  // belongs to at most one pattern, so one read each is enough).
  const prevTripShape = new Map<string, string | undefined>();
  for (const t of start.trips) prevTripShape.set(t.trip_id, t.shape_id);

  // Phase 1 — geometry. Sparse by design: an index left empty is a pattern the
  // abort reached before we scheduled it.
  const prepared: PreparedPattern[] = new Array(total);
  if (mode === 'snap') {
    await prepareSnapped(patterns, prepared, onProgress, signal);
  } else {
    // 'straight' never touches the network, so there's nothing to parallelise —
    // keep it a straight-line loop rather than paying for a pointless task pool.
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) break;
      const pattern = patterns[i];
      // computeStopPatterns already guarantees >= 2 coords; this is belt-and-braces
      // so a future caller passing hand-built patterns can't write a 1-point shape.
      const outcome: PatternOutcome = pattern.coords.length < 2 ? 'skipped' : 'straight';
      prepared[i] = { pattern, coords: pattern.coords, outcome };
      onProgress?.(i + 1, total);
    }
  }

  // Phase 2 — the ONLY writer. Sequential, in pattern order.
  const results: PatternResult[] = [];
  const createdShapeIds: string[] = [];
  const created: { pattern: StopPattern; shapeId: string }[] = [];
  const changedTripIds: string[] = [];

  for (let i = 0; i < total; i++) {
    const entry = prepared[i];
    if (!entry) continue; // never processed (aborted before it was scheduled)
    const { pattern, coords, outcome } = entry;

    if (outcome === 'skipped') {
      results.push({ pattern, shapeId: null, outcome: 'skipped', pointCount: 0 });
      continue;
    }

    try {
      const { shapeId, pointCount } = writeShape(coords);
      createdShapeIds.push(shapeId);
      created.push({ pattern, shapeId });

      const updateTrip = useStore.getState().updateTrip;
      for (const tripId of pattern.tripIds) {
        updateTrip(tripId, { shape_id: shapeId });
        changedTripIds.push(tripId);
      }
      results.push({ pattern, shapeId, outcome, pointCount });
    } catch {
      results.push({ pattern, shapeId: null, outcome: 'failed', pointCount: 0 });
    }
  }

  // One retag pass at the end over whatever got written (works for an aborted
  // run too — `created` only holds patterns we actually wrote).
  const routeStopChanges = linkRouteStops(created);

  const undo = () => {
    const st = useStore.getState();
    for (const shapeId of createdShapeIds) st.removeShape(shapeId);
    // Restore each trip's prior shape_id — usually undefined (that's the whole
    // point of this recipe), sometimes a dangling id, which we put back as-is
    // rather than silently "cleaning".
    for (const tripId of changedTripIds) {
      st.updateTrip(tripId, { shape_id: prevTripShape.get(tripId) });
    }
    if (routeStopChanges.length > 0) {
      const prevByIdentity = new Map(routeStopChanges.map((c) => [c.identity, c.prev]));
      // Rewrite only the shape_id of the rows we touched, so any unrelated
      // route_stop edit made between the run and the undo survives.
      st.setRouteStops(
        st.routeStops.map((rs) => {
          const identity = routeStopIdentity(rs);
          return prevByIdentity.has(identity)
            ? { ...rs, shape_id: prevByIdentity.get(identity) }
            : rs;
        }),
      );
    }
  };

  return {
    patternsTotal: total,
    shapesCreated: createdShapeIds.length,
    tripsUpdated: changedTripIds.length,
    partialCount: results.filter((r) => r.outcome === 'partial').length,
    straightCount: results.filter((r) => r.outcome === 'straight').length,
    skippedCount: results.filter((r) => r.outcome === 'skipped').length,
    results,
    undo,
  };
}
