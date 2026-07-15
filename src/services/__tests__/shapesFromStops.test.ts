// "Shapes from stops" recipe — see services/shapesFromStops.ts.
//
// Covers the two PURE planners (computeStopPatterns / feedNeedsShapes) against
// the shapes a real shapeless feed throws at them (shared patterns, loops,
// dangling shape_ids, unsorted stop_times), plus generateShapesFromStops against
// a real store in 'straight' mode (writes shapes, links trips + route_stops,
// undo restores) and in 'snap' mode with the road-routing call mocked — the
// network is NEVER touched here. Includes the regression test for the Skyline
// bug: a geometry far shorter than the crow-flies line through its own stops is
// truncated, and must be rejected in favour of the straight line.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';
import type { Trip, StopTime, Stop, Shape, RouteStop } from '../../types/gtfs';

// Only the network call is mocked, so the 'snap'-mode tests can drive each
// status; the real pathLengthMeters is kept, because the length sanity guard is
// one of the things under test here. The 'straight'-mode tests assert the
// network is never called.
vi.mock('../routeGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routeGeometry')>();
  return { ...actual, routeThroughStops: vi.fn() };
});

import { routeThroughStops } from '../routeGeometry';
import {
  computeStopPatterns,
  feedNeedsShapes,
  generateShapesFromStops,
  SNAP_CONCURRENCY,
} from '../shapesFromStops';

const mockRoute = vi.mocked(routeThroughStops);

// A tiny grid of stops (Bozeman-ish coords — value doesn't matter, only that
// they're distinct and locatable).
const STOPS: Stop[] = [
  { stop_id: 'A', stop_name: 'A', stop_lat: 45.68, stop_lon: -111.04, location_type: 0, wheelchair_boarding: 0 },
  { stop_id: 'B', stop_name: 'B', stop_lat: 45.69, stop_lon: -111.03, location_type: 0, wheelchair_boarding: 0 },
  { stop_id: 'C', stop_name: 'C', stop_lat: 45.70, stop_lon: -111.02, location_type: 0, wheelchair_boarding: 0 },
];

const trip = (trip_id: string, over: Partial<Trip> = {}): Trip => ({
  trip_id,
  route_id: 'R1',
  service_id: 'S1',
  direction_id: 0,
  ...over,
});

/** stop_times for a trip, in the given stop order (sequence = index). */
const times = (trip_id: string, stopIds: string[], seqStart = 0): StopTime[] =>
  stopIds.map((stop_id, i) => ({
    trip_id,
    stop_id,
    stop_sequence: seqStart + i,
    arrival_time: '',
    departure_time: '',
  }));

describe('computeStopPatterns', () => {
  it('collapses two trips with the same ordered stops onto ONE pattern', () => {
    const trips = [trip('T1'), trip('T2')];
    const stopTimes = [...times('T1', ['A', 'B', 'C']), ...times('T2', ['A', 'B', 'C'])];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].stopIds).toEqual(['A', 'B', 'C']);
    expect(patterns[0].tripIds).toEqual(['T1', 'T2']);
    expect(patterns[0].coords).toEqual([
      [-111.04, 45.68],
      [-111.03, 45.69],
      [-111.02, 45.70],
    ]);
  });

  it('splits patterns by direction_id', () => {
    const trips = [trip('T1', { direction_id: 0 }), trip('T2', { direction_id: 1 })];
    // Same stop list — only the direction differs (an out-and-back on one street).
    const stopTimes = [...times('T1', ['A', 'B']), ...times('T2', ['A', 'B'])];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns).toHaveLength(2);
    expect(patterns.map((p) => p.directionId)).toEqual([0, 1]);
  });

  it('splits patterns by route_id', () => {
    const trips = [trip('T1', { route_id: 'R1' }), trip('T2', { route_id: 'R2' })];
    const stopTimes = [...times('T1', ['A', 'B']), ...times('T2', ['A', 'B'])];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns).toHaveLength(2);
    expect(patterns.map((p) => p.routeId)).toEqual(['R1', 'R2']);
  });

  it('keeps a repeated stop_id in the pattern (loop route returning to its origin)', () => {
    const trips = [trip('T1')];
    const stopTimes = times('T1', ['A', 'B', 'C', 'A']);

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    // The full ordered list is the fingerprint — a Set would have dropped the
    // closing 'A' and left the loop open.
    expect(patterns).toHaveLength(1);
    expect(patterns[0].stopIds).toEqual(['A', 'B', 'C', 'A']);
    expect(patterns[0].coords).toHaveLength(4);
    expect(patterns[0].coords[0]).toEqual(patterns[0].coords[3]);
  });

  it('does NOT merge two different loops that share a bare stop_id concatenation', () => {
    // Distinct patterns whose ids would collide if the key were a bare join:
    // ['A','BC'] vs ['AB','C'] both concatenate to "ABC".
    const stops: Stop[] = [
      { stop_id: 'A', stop_name: 'A', stop_lat: 45.68, stop_lon: -111.04, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'BC', stop_name: 'BC', stop_lat: 45.69, stop_lon: -111.03, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'AB', stop_name: 'AB', stop_lat: 45.70, stop_lon: -111.02, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'C', stop_name: 'C', stop_lat: 45.71, stop_lon: -111.01, location_type: 0, wheelchair_boarding: 0 },
    ];
    const trips = [trip('T1'), trip('T2')];
    const stopTimes = [...times('T1', ['A', 'BC']), ...times('T2', ['AB', 'C'])];

    const patterns = computeStopPatterns(trips, stopTimes, stops, []);

    expect(patterns).toHaveLength(2);
  });

  it('excludes trips whose shape resolves (real geometry, >= 2 points)', () => {
    const shapes: Shape[] = [
      {
        shape_id: 'SH1',
        points: [
          { shape_pt_lat: 45.68, shape_pt_lon: -111.04, shape_pt_sequence: 0, shape_dist_traveled: 0 },
          { shape_pt_lat: 45.69, shape_pt_lon: -111.03, shape_pt_sequence: 1, shape_dist_traveled: 100 },
        ],
      },
    ];
    const trips = [trip('T1', { shape_id: 'SH1' }), trip('T2')];
    const stopTimes = [...times('T1', ['A', 'B', 'C']), ...times('T2', ['A', 'B', 'C'])];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, shapes);

    // Only the shapeless T2 is planned; T1 already has geometry.
    expect(patterns).toHaveLength(1);
    expect(patterns[0].tripIds).toEqual(['T2']);
  });

  it('includes a trip with a DANGLING shape_id (points at a shape that does not exist)', () => {
    const trips = [trip('T1', { shape_id: 'GHOST' })];
    const stopTimes = times('T1', ['A', 'B']);

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].tripIds).toEqual(['T1']);
  });

  it('includes a trip whose shape exists but has < 2 points (no line to render)', () => {
    const shapes: Shape[] = [
      {
        shape_id: 'SH1',
        points: [{ shape_pt_lat: 45.68, shape_pt_lon: -111.04, shape_pt_sequence: 0, shape_dist_traveled: 0 }],
      },
    ];
    const trips = [trip('T1', { shape_id: 'SH1' })];

    const patterns = computeStopPatterns(trips, times('T1', ['A', 'B']), STOPS, shapes);

    expect(patterns).toHaveLength(1);
  });

  it('drops a trip with fewer than 2 locatable stops', () => {
    const trips = [
      trip('T1'), // one stop_time only
      trip('T2'), // two stop_times, but one points at a stop that is not in stops.txt
      trip('T3'), // fine
    ];
    const stopTimes = [
      ...times('T1', ['A']),
      ...times('T2', ['A', 'MISSING']),
      ...times('T3', ['A', 'B']),
    ];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns).toHaveLength(1);
    expect(patterns[0].tripIds).toEqual(['T3']);
  });

  it('orders each trip’s stops by stop_sequence, not by stop_times row order', () => {
    const trips = [trip('T1')];
    // Rows deliberately shuffled, and not zero-based.
    const stopTimes: StopTime[] = [
      { trip_id: 'T1', stop_id: 'C', stop_sequence: 30, arrival_time: '', departure_time: '' },
      { trip_id: 'T1', stop_id: 'A', stop_sequence: 10, arrival_time: '', departure_time: '' },
      { trip_id: 'T1', stop_id: 'B', stop_sequence: 20, arrival_time: '', departure_time: '' },
    ];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns[0].stopIds).toEqual(['A', 'B', 'C']);
    // And the caller's array is not reordered (the function is pure).
    expect(stopTimes.map((st) => st.stop_id)).toEqual(['C', 'A', 'B']);
  });

  it('sorts patterns stably by route, then direction', () => {
    const trips = [
      trip('T1', { route_id: 'R2', direction_id: 1 }),
      trip('T2', { route_id: 'R1', direction_id: 1 }),
      trip('T3', { route_id: 'R1', direction_id: 0 }),
    ];
    const stopTimes = [
      ...times('T1', ['A', 'B']),
      ...times('T2', ['A', 'B']),
      ...times('T3', ['A', 'B']),
    ];

    const patterns = computeStopPatterns(trips, stopTimes, STOPS, []);

    expect(patterns.map((p) => `${p.routeId}/${p.directionId}`)).toEqual(['R1/0', 'R1/1', 'R2/1']);
  });

  it('returns nothing for an empty feed', () => {
    expect(computeStopPatterns([], [], [], [])).toEqual([]);
  });
});

describe('feedNeedsShapes', () => {
  it('is true when a shapeless trip has >= 2 locatable stops', () => {
    expect(feedNeedsShapes([trip('T1')], times('T1', ['A', 'B']), STOPS, [])).toBe(true);
  });

  it('is true for a dangling shape_id', () => {
    expect(
      feedNeedsShapes([trip('T1', { shape_id: 'GHOST' })], times('T1', ['A', 'B']), STOPS, []),
    ).toBe(true);
  });

  it('is false when every trip has a resolvable shape', () => {
    const shapes: Shape[] = [
      {
        shape_id: 'SH1',
        points: [
          { shape_pt_lat: 45.68, shape_pt_lon: -111.04, shape_pt_sequence: 0, shape_dist_traveled: 0 },
          { shape_pt_lat: 45.69, shape_pt_lon: -111.03, shape_pt_sequence: 1, shape_dist_traveled: 100 },
        ],
      },
    ];
    expect(
      feedNeedsShapes([trip('T1', { shape_id: 'SH1' })], times('T1', ['A', 'B']), STOPS, shapes),
    ).toBe(false);
  });

  it('is false when the only shapeless trip has < 2 locatable stops', () => {
    expect(feedNeedsShapes([trip('T1')], times('T1', ['A']), STOPS, [])).toBe(false);
    expect(feedNeedsShapes([trip('T1')], times('T1', ['A', 'MISSING']), STOPS, [])).toBe(false);
  });

  it('is false for an empty feed', () => {
    expect(feedNeedsShapes([], [], [], [])).toBe(false);
  });

  it('agrees with computeStopPatterns on the same inputs', () => {
    const trips = [trip('T1'), trip('T2', { shape_id: 'GHOST' })];
    const stopTimes = [...times('T1', ['A']), ...times('T2', ['A', 'B', 'C'])];

    expect(feedNeedsShapes(trips, stopTimes, STOPS, [])).toBe(
      computeStopPatterns(trips, stopTimes, STOPS, []).length > 0,
    );
  });
});

// --- store-backed: generateShapesFromStops -----------------------------------

function resetStore() {
  const s = useStore.getState();
  s.setRoutes([{ route_id: 'R1', route_short_name: '1' } as never]);
  s.setStops(STOPS.map((st) => ({ ...st })));
  s.setTrips([]);
  s.setStopTimes([]);
  s.setShapes([]);
  s.setRouteStops([]);
}

/** Two trips sharing one A→B→C pattern, plus the route_stops an import would
 *  have built for them (untagged — a shapeless feed has no shape to key on). */
function seedShapelessFeed() {
  const s = useStore.getState();
  s.setTrips([trip('T1'), trip('T2')]);
  s.setStopTimes([...times('T1', ['A', 'B', 'C']), ...times('T2', ['A', 'B', 'C'])]);
  s.setRouteStops(
    ['A', 'B', 'C'].map((stop_id, i): RouteStop => ({
      route_id: 'R1',
      stop_id,
      direction_id: 0,
      stop_sequence: i,
      _snapped: true,
    })),
  );
}

describe('generateShapesFromStops (straight mode)', () => {
  beforeEach(() => {
    resetStore();
    mockRoute.mockReset();
  });

  it('writes one shape per pattern, links the trips, and never calls the network', async () => {
    seedShapelessFeed();

    const progress: [number, number][] = [];
    const summary = await generateShapesFromStops({
      mode: 'straight',
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(mockRoute).not.toHaveBeenCalled();
    expect(summary.patternsTotal).toBe(1);
    expect(summary.shapesCreated).toBe(1);
    expect(summary.tripsUpdated).toBe(2);
    expect(summary.straightCount).toBe(1);
    expect(summary.partialCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(progress).toEqual([[1, 1]]);

    const st = useStore.getState();
    expect(st.shapes).toHaveLength(1);
    const shape = st.shapes[0];
    // Straight line = one point per stop, in order, lon/lat mapped correctly.
    expect(shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat])).toEqual([
      [-111.04, 45.68],
      [-111.03, 45.69],
      [-111.02, 45.70],
    ]);
    expect(shape.points.map((p) => p.shape_pt_sequence)).toEqual([0, 1, 2]);
    // NOT a draft shape — it has real trips, so `_route_id` must stay unset.
    expect(shape._route_id).toBeUndefined();

    // shape_dist_traveled populated: 0 at the start, strictly increasing after.
    expect(shape.points[0].shape_dist_traveled).toBe(0);
    expect(shape.points[1].shape_dist_traveled).toBeGreaterThan(0);
    expect(shape.points[2].shape_dist_traveled).toBeGreaterThan(
      shape.points[1].shape_dist_traveled,
    );

    // Both member trips point at it.
    expect(st.trips.map((t) => t.shape_id)).toEqual([shape.shape_id, shape.shape_id]);
    // …and the route's stop list is keyed to it (unambiguous: one pattern).
    expect(st.routeStops.map((rs) => rs.shape_id)).toEqual([
      shape.shape_id,
      shape.shape_id,
      shape.shape_id,
    ]);

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({ outcome: 'straight', pointCount: 3 });
    expect(summary.results[0].shapeId).toBe(shape.shape_id);
  });

  it('undo() fully restores the prior state', async () => {
    seedShapelessFeed();
    const before = {
      shapes: useStore.getState().shapes,
      tripShapeIds: useStore.getState().trips.map((t) => t.shape_id),
      routeStopShapeIds: useStore.getState().routeStops.map((rs) => rs.shape_id),
    };

    const summary = await generateShapesFromStops({ mode: 'straight' });
    expect(useStore.getState().shapes).toHaveLength(1);

    summary.undo();

    const st = useStore.getState();
    expect(st.shapes).toEqual(before.shapes);
    expect(st.trips.map((t) => t.shape_id)).toEqual(before.tripShapeIds);
    expect(st.routeStops.map((rs) => rs.shape_id)).toEqual(before.routeStopShapeIds);
    // The recipe is idempotent after an undo: the feed needs shapes again.
    expect(feedNeedsShapes(st.trips, st.stopTimes, st.stops, st.shapes)).toBe(true);
  });

  it('undo() restores a trip’s prior (dangling) shape_id rather than clearing it', async () => {
    const s = useStore.getState();
    s.setTrips([trip('T1', { shape_id: 'GHOST' })]);
    s.setStopTimes(times('T1', ['A', 'B']));

    const summary = await generateShapesFromStops({ mode: 'straight' });
    expect(useStore.getState().trips[0].shape_id).toBe(summary.results[0].shapeId);

    summary.undo();
    expect(useStore.getState().trips[0].shape_id).toBe('GHOST');
    expect(useStore.getState().shapes).toHaveLength(0);
  });

  it('writes one shape per pattern when a route branches, tagging the stop list to the pattern it matches', async () => {
    const s = useStore.getState();
    // A branch: T1 serves A→B→C, T2 short-turns at A→B. The importer built ONE
    // route_stop list (from the first trip) — A,B,C — so it belongs to T1's
    // shape, unambiguously. The short-turn shape gets no route_stops, which is
    // the state it was already in.
    s.setTrips([trip('T1'), trip('T2')]);
    s.setStopTimes([...times('T1', ['A', 'B', 'C']), ...times('T2', ['A', 'B'])]);
    s.setRouteStops(
      ['A', 'B', 'C'].map((stop_id, i): RouteStop => ({
        route_id: 'R1',
        stop_id,
        direction_id: 0,
        stop_sequence: i,
        _snapped: true,
      })),
    );

    const summary = await generateShapesFromStops({ mode: 'straight' });

    expect(summary.shapesCreated).toBe(2);
    expect(summary.tripsUpdated).toBe(2);
    const st = useStore.getState();
    expect(st.shapes).toHaveLength(2);
    // Distinct shapes, one per pattern.
    const byTrip = new Map(st.trips.map((t) => [t.trip_id, t.shape_id]));
    expect(byTrip.get('T1')).not.toBe(byTrip.get('T2'));
    // The stop list's ordered stop_ids match T1's pattern exactly → tagged with
    // T1's shape, never the short-turn's.
    expect(st.routeStops.map((rs) => rs.shape_id)).toEqual([
      byTrip.get('T1'),
      byTrip.get('T1'),
      byTrip.get('T1'),
    ]);

    summary.undo();
    const after = useStore.getState();
    expect(after.shapes).toHaveLength(0);
    expect(after.trips.every((t) => !t.shape_id)).toBe(true);
    expect(after.routeStops.every((rs) => rs.shape_id === undefined)).toBe(true);
  });

  it('leaves route_stops untagged when no pattern matches the stop list (ambiguous)', async () => {
    const s = useStore.getState();
    // Two disjoint patterns (A→B and B→C) but a route_stop list of A,B,C that
    // matches neither. Guessing would file the stops under the wrong shape, so
    // they're left alone — the shapes + trip links (the must-have) still land.
    s.setTrips([trip('T1'), trip('T2')]);
    s.setStopTimes([...times('T1', ['A', 'B']), ...times('T2', ['B', 'C'])]);
    s.setRouteStops(
      ['A', 'B', 'C'].map((stop_id, i): RouteStop => ({
        route_id: 'R1',
        stop_id,
        direction_id: 0,
        stop_sequence: i,
        _snapped: true,
      })),
    );

    const summary = await generateShapesFromStops({ mode: 'straight' });

    expect(summary.shapesCreated).toBe(2);
    const st = useStore.getState();
    expect(st.trips.every((t) => !!t.shape_id)).toBe(true);
    expect(st.routeStops.every((rs) => rs.shape_id === undefined)).toBe(true);
  });

  it('leaves route_stops that are already keyed to a shape alone', async () => {
    const s = useStore.getState();
    // A half-shaped feed: the route's stop list is already keyed to an existing
    // shape (per-shape stop lists), so we must not retag it with ours.
    s.setShapes([
      {
        shape_id: 'SH1',
        points: [
          { shape_pt_lat: 45.68, shape_pt_lon: -111.04, shape_pt_sequence: 0, shape_dist_traveled: 0 },
          { shape_pt_lat: 45.69, shape_pt_lon: -111.03, shape_pt_sequence: 1, shape_dist_traveled: 100 },
        ],
      },
    ]);
    s.setTrips([trip('T1', { shape_id: 'SH1' }), trip('T2')]);
    s.setStopTimes([...times('T1', ['A', 'B', 'C']), ...times('T2', ['A', 'B', 'C'])]);
    s.setRouteStops(
      ['A', 'B', 'C'].map((stop_id, i): RouteStop => ({
        route_id: 'R1',
        stop_id,
        direction_id: 0,
        stop_sequence: i,
        _snapped: true,
        shape_id: 'SH1',
      })),
    );

    const summary = await generateShapesFromStops({ mode: 'straight' });

    expect(summary.shapesCreated).toBe(1); // only the shapeless T2's pattern
    const st = useStore.getState();
    expect(st.routeStops.every((rs) => rs.shape_id === 'SH1')).toBe(true);
    expect(st.trips.find((t) => t.trip_id === 'T1')!.shape_id).toBe('SH1');
    expect(st.trips.find((t) => t.trip_id === 'T2')!.shape_id).toBe(summary.results[0].shapeId);
  });

  it('does nothing on a feed that already has shapes', async () => {
    const s = useStore.getState();
    s.setShapes([
      {
        shape_id: 'SH1',
        points: [
          { shape_pt_lat: 45.68, shape_pt_lon: -111.04, shape_pt_sequence: 0, shape_dist_traveled: 0 },
          { shape_pt_lat: 45.69, shape_pt_lon: -111.03, shape_pt_sequence: 1, shape_dist_traveled: 100 },
        ],
      },
    ]);
    s.setTrips([trip('T1', { shape_id: 'SH1' })]);
    s.setStopTimes(times('T1', ['A', 'B']));

    const summary = await generateShapesFromStops({ mode: 'straight' });

    expect(summary.patternsTotal).toBe(0);
    expect(summary.shapesCreated).toBe(0);
    expect(useStore.getState().shapes).toHaveLength(1);
  });

  it('stops early when the signal aborts, and undo() still reverses what was written', async () => {
    const s = useStore.getState();
    // Two patterns (two routes) → the abort fires after the first is written.
    s.setRoutes([
      { route_id: 'R1', route_short_name: '1' } as never,
      { route_id: 'R2', route_short_name: '2' } as never,
    ]);
    s.setTrips([trip('T1', { route_id: 'R1' }), trip('T2', { route_id: 'R2' })]);
    s.setStopTimes([...times('T1', ['A', 'B']), ...times('T2', ['B', 'C'])]);

    const controller = new AbortController();
    const summary = await generateShapesFromStops({
      mode: 'straight',
      signal: controller.signal,
      onProgress: () => controller.abort(), // cancel after the first pattern
    });

    expect(summary.patternsTotal).toBe(2);
    expect(summary.shapesCreated).toBe(1);
    expect(summary.tripsUpdated).toBe(1);
    expect(useStore.getState().shapes).toHaveLength(1);

    summary.undo();
    const st = useStore.getState();
    expect(st.shapes).toHaveLength(0);
    expect(st.trips.every((t) => !t.shape_id)).toBe(true);
  });
});

/** The pattern's stops, as routeThroughStops receives them. */
const STOP_COORDS: [number, number][] = [
  [-111.04, 45.68],
  [-111.03, 45.69],
  [-111.02, 45.70],
];

describe('generateShapesFromStops (snap mode)', () => {
  beforeEach(() => {
    resetStore();
    mockRoute.mockReset();
  });

  it('uses the routed geometry on status "routed"', async () => {
    seedShapelessFeed();
    // A real road route: passes through every stop, with extra road vertices and
    // a small detour, so it is slightly LONGER than the crow-flies line.
    const routed: [number, number][] = [
      [-111.04, 45.68],
      [-111.036, 45.684], // road bends around something
      [-111.033, 45.6885],
      [-111.03, 45.69],
      [-111.025, 45.6955],
      [-111.02, 45.70],
    ];
    mockRoute.mockResolvedValue({ status: 'routed', coords: routed });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    // The whole ordered stop list goes to routeThroughStops in one call — it
    // chunks past the Directions 25-waypoint limit internally.
    expect(mockRoute).toHaveBeenCalledTimes(1);
    expect(mockRoute).toHaveBeenCalledWith(STOP_COORDS);
    expect(summary.results[0].outcome).toBe('snapped');
    expect(useStore.getState().shapes[0].points.map((p) => [p.shape_pt_lon, p.shape_pt_lat])).toEqual(
      routed,
    );
  });

  it('keeps a "partial" route (part of the chain straight) and flags it for review', async () => {
    seedShapelessFeed();
    // One window didn't route, so its leg is straight in-line — but the geometry
    // still spans the whole stop chain, so it clears the length guard and is
    // worth keeping.
    const partial: [number, number][] = [
      [-111.04, 45.68],
      [-111.035, 45.6853], // routed leg
      [-111.03, 45.69],
      [-111.02, 45.70], // straight leg (unrouted window)
    ];
    mockRoute.mockResolvedValue({ status: 'partial', coords: partial });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    expect(summary.results[0].outcome).toBe('partial');
    expect(summary.partialCount).toBe(1);
    expect(summary.shapesCreated).toBe(1);
    expect(useStore.getState().shapes[0].points).toHaveLength(4);
  });

  it('falls back to the straight stop-to-stop line on status "failed"', async () => {
    seedShapelessFeed();
    // A failed route returns the raw input as `coords` — we must not report that
    // as road geometry.
    mockRoute.mockResolvedValue({ status: 'failed', coords: STOP_COORDS });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    expect(summary.results[0].outcome).toBe('straight');
    expect(summary.straightCount).toBe(1);
    expect(summary.shapesCreated).toBe(1);
    expect(useStore.getState().trips.every((t) => !!t.shape_id)).toBe(true);
  });

  // THE REGRESSION TEST. This is the Skyline bug: the API cheerfully reported a
  // route, but the geometry was a stub covering ~3% of the corridor (Map Matching
  // matching one cluster of a stops-miles-apart trace and dropping the rest). A
  // shape that doesn't span its own stops is worse than the straight line it
  // replaces, so the length guard must reject it whatever the status says.
  it('REJECTS a routed geometry that is far shorter than crow-flies, and uses the straight line', async () => {
    seedShapelessFeed();
    const stub: [number, number][] = [
      [-111.04, 45.68],
      [-111.0396, 45.6804], // ~3% of the way to the second stop, then nothing
    ];
    mockRoute.mockResolvedValue({ status: 'routed', coords: stub });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    expect(summary.results[0].outcome).toBe('straight');
    expect(summary.straightCount).toBe(1);
    expect(summary.partialCount).toBe(0);

    // The stub is NOT what got written: the shape is the straight line through
    // all three stops, so it at least spans the corridor.
    const points = useStore.getState().shapes[0].points;
    expect(points.map((p) => [p.shape_pt_lon, p.shape_pt_lat])).toEqual(STOP_COORDS);
  });

  it('accepts a route that is a little shorter than crow-flies (waypoint snapping slack)', async () => {
    seedShapelessFeed();
    // 97% of crow-flies — a real road route whose waypoints snapped a few metres
    // off the stops. Above the 0.9 threshold, so it is kept as road geometry.
    const slightlyShort: [number, number][] = [
      [-111.0399, 45.6801],
      [-111.03, 45.69],
      [-111.0201, 45.6999],
    ];
    mockRoute.mockResolvedValue({ status: 'routed', coords: slightlyShort });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    expect(summary.results[0].outcome).toBe('snapped');
    expect(useStore.getState().shapes[0].points).toHaveLength(3);
  });

  it('simplifies dense routed geometry (a real Directions line has hundreds of vertices)', async () => {
    seedShapelessFeed();
    // 200 near-collinear points along the A→C corridor: RDP should collapse them.
    const dense: [number, number][] = Array.from({ length: 200 }, (_, i) => [
      -111.04 + (i * 0.02) / 199,
      45.68 + (i * 0.02) / 199,
    ]);
    mockRoute.mockResolvedValue({ status: 'routed', coords: dense });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    const points = useStore.getState().shapes[0].points;
    expect(points.length).toBeLessThan(dense.length);
    expect(summary.results[0].pointCount).toBe(points.length);
    // Endpoints survive simplification (RDP keeps the first and last vertex).
    expect([points[0].shape_pt_lon, points[0].shape_pt_lat]).toEqual(dense[0]);
    expect([
      points[points.length - 1].shape_pt_lon,
      points[points.length - 1].shape_pt_lat,
    ]).toEqual(dense[dense.length - 1]);
    // Sequences renumbered 0..n-1 and distances recomputed on the simplified line.
    expect(points.map((p) => p.shape_pt_sequence)).toEqual(points.map((_, i) => i));
    expect(points[points.length - 1].shape_dist_traveled).toBeGreaterThan(0);
  });
});

// --- snap-mode concurrency ----------------------------------------------------
// A real agency feed is 100-200 patterns. Serial snapping = one Mapbox
// round-trip after another (minutes); unbounded = a 429. The fan-out is capped,
// and the store writes stay a single ordered pass AFTER it, so output can't
// depend on which request came back first.

const PATTERN_COUNT = 12; // comfortably more than SNAP_CONCURRENCY

/** N single-trip routes, each serving A→B — N distinct patterns (RTAP models
 *  each direction as its own route, so this is the real shape of the input). */
function seedManyRoutes(n: number): string[] {
  const routeIds = Array.from({ length: n }, (_, i) => `R${String(i).padStart(2, '0')}`);
  const s = useStore.getState();
  s.setRoutes(routeIds.map((route_id) => ({ route_id, route_short_name: route_id })) as never);
  s.setTrips(routeIds.map((route_id, i) => trip(`T${String(i).padStart(2, '0')}`, { route_id })));
  s.setStopTimes(routeIds.flatMap((_, i) => times(`T${String(i).padStart(2, '0')}`, ['A', 'B'])));
  s.setRouteStops([]);
  return routeIds;
}

describe('generateShapesFromStops (snap concurrency)', () => {
  beforeEach(() => {
    resetStore();
    mockRoute.mockReset();
  });

  it('keeps at most SNAP_CONCURRENCY Map Matching calls in flight, and does use the full cap', async () => {
    seedManyRoutes(PATTERN_COUNT);
    let inFlight = 0;
    let peak = 0;
    mockRoute.mockImplementation(async (coords) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return { status: 'routed' as const, coords };
    });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    expect(mockRoute).toHaveBeenCalledTimes(PATTERN_COUNT);
    expect(peak).toBe(SNAP_CONCURRENCY); // capped, and not left idle below the cap
    expect(summary.shapesCreated).toBe(PATTERN_COUNT);
    expect(useStore.getState().trips.every((t) => !!t.shape_id)).toBe(true);
  });

  it('keeps results — and the shapes written — in PATTERN order when snaps finish out of order', async () => {
    const routeIds = seedManyRoutes(PATTERN_COUNT);
    // Later-scheduled calls resolve FIRST, so completion order is roughly the
    // reverse of pattern order. Output must not notice.
    let callNo = 0;
    const completed: number[] = [];
    mockRoute.mockImplementation(async (coords) => {
      const n = callNo++;
      await new Promise((r) => setTimeout(r, (PATTERN_COUNT - n) * 2));
      completed.push(n);
      return { status: 'routed' as const, coords };
    });

    const summary = await generateShapesFromStops({ mode: 'snap' });

    // Sanity: the mock really did complete out of order (otherwise this test
    // would pass for the wrong reason).
    expect(completed).not.toEqual([...completed].sort((a, b) => a - b));

    // results follow pattern order (route id ascending), not completion order.
    expect(summary.results.map((r) => r.pattern.routeId)).toEqual(routeIds);

    // …and so do the store writes: route i's trip points at the i-th shape
    // created, which only holds if phase 2 is a single ordered writer.
    const st = useStore.getState();
    expect(st.shapes).toHaveLength(PATTERN_COUNT);
    routeIds.forEach((routeId, i) => {
      const t = st.trips.find((tr) => tr.route_id === routeId)!;
      expect(t.shape_id).toBe(st.shapes[i].shape_id);
    });
  });

  it('reports progress monotonically: exactly `total` calls, 1..total, ending at (total, total)', async () => {
    seedManyRoutes(PATTERN_COUNT);
    // Jittered completion so progress is exercised against out-of-order finishes.
    let callSeq = 0;
    mockRoute.mockImplementation(async (coords) => {
      await new Promise((r) => setTimeout(r, (callSeq++ % 3) * 2));
      return { status: 'routed' as const, coords };
    });

    const progress: [number, number][] = [];
    await generateShapesFromStops({
      mode: 'snap',
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(progress).toHaveLength(PATTERN_COUNT);
    // Never repeats, never rewinds — even though patterns finish out of order.
    expect(progress.map(([done]) => done)).toEqual(
      Array.from({ length: PATTERN_COUNT }, (_, i) => i + 1),
    );
    expect(progress.every(([, total]) => total === PATTERN_COUNT)).toBe(true);
    expect(progress[progress.length - 1]).toEqual([PATTERN_COUNT, PATTERN_COUNT]);
  });

  it('stops scheduling new snaps on abort, and undo() restores the state fully', async () => {
    seedManyRoutes(PATTERN_COUNT);
    mockRoute.mockImplementation(async (coords) => {
      await new Promise((r) => setTimeout(r, 1));
      return { status: 'routed' as const, coords };
    });

    const controller = new AbortController();
    const summary = await generateShapesFromStops({
      mode: 'snap',
      signal: controller.signal,
      onProgress: () => controller.abort(), // cancel as soon as the first one lands
    });

    // The in-flight batch may finish, but nothing beyond it is ever requested.
    expect(mockRoute.mock.calls.length).toBeLessThanOrEqual(SNAP_CONCURRENCY);
    expect(summary.patternsTotal).toBe(PATTERN_COUNT);
    expect(summary.shapesCreated).toBeGreaterThan(0);
    expect(summary.shapesCreated).toBeLessThan(PATTERN_COUNT);

    // Everything the summary claims to have written is actually in the store…
    const mid = useStore.getState();
    expect(mid.shapes).toHaveLength(summary.shapesCreated);
    expect(mid.trips.filter((t) => !!t.shape_id)).toHaveLength(summary.tripsUpdated);
    // …and the partial batch is fully reversible.
    summary.undo();
    const after = useStore.getState();
    expect(after.shapes).toHaveLength(0);
    expect(after.trips.every((t) => !t.shape_id)).toBe(true);
    expect(feedNeedsShapes(after.trips, after.stopTimes, after.stops, after.shapes)).toBe(true);
  });
});
