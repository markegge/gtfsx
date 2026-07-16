import { describe, it, expect } from 'vitest';
import {
  activeStopsShapeId, computeShapePatterns, computeTimetablePatterns,
  unreachableTimetableTripIds, isNoShapeBucket, noShapeBucketId,
  type ShapePattern,
} from '../shapePatterns';
import type { Trip, RouteStop } from '../../../types/gtfs';

// activeStopsShapeId resolves which shape the Routes > Stops subpanel is
// editing. The map highlight keys off the same value (via stopPlacementShapeId),
// so these cases also pin down the "switch direction → highlight that shape"
// behaviour.
describe('activeStopsShapeId', () => {
  const patterns: ShapePattern[] = [
    { shapeId: 'out', directionId: 0 },
    { shapeId: 'in', directionId: 1 },
  ];

  it('follows the active direction when no shape is pinned', () => {
    expect(activeStopsShapeId(patterns, null, 0)).toBe('out');
    // Changing direction moves the active shape — this is the propagation the
    // map highlight depends on.
    expect(activeStopsShapeId(patterns, null, 1)).toBe('in');
  });

  it('honours a pinned in-route shape over the direction fallback', () => {
    expect(activeStopsShapeId(patterns, 'in', 0)).toBe('in');
    expect(activeStopsShapeId(patterns, 'out', 1)).toBe('out');
  });

  it('ignores a pinned shape that is not one of the route patterns', () => {
    // e.g. a selection left over from a different route — fall back to direction.
    expect(activeStopsShapeId(patterns, 'stale', 1)).toBe('in');
  });

  it('distinguishes same-direction variants by the pinned shape', () => {
    // Two outbound patterns: direction alone cannot tell them apart, so the
    // pinned shape decides which one is highlighted.
    const variants: ShapePattern[] = [
      { shapeId: 'a', directionId: 0 },
      { shapeId: 'b', directionId: 0 },
    ];
    expect(activeStopsShapeId(variants, 'b', 0)).toBe('b');
    expect(activeStopsShapeId(variants, 'a', 0)).toBe('a');
  });

  it('returns null when the route has no shaped patterns', () => {
    expect(activeStopsShapeId([], null, 0)).toBeNull();
    expect(activeStopsShapeId([], 'whatever', 1)).toBeNull();
  });
});

// Regression (Mark, 2026-06-27): drawing a second shape ("Navy Inbound") left it
// out of the Stops subpanel "Assign to" dropdown, so you couldn't place its
// first stop (chicken-and-egg). A freshly drawn shape is linked to its route
// only via shape._route_id until it has a trip or route_stop.
describe('computeShapePatterns — freshly drawn shapes', () => {
  const shape = (id: string, routeId?: string) =>
    ({ shape_id: id, points: [], _route_id: routeId }) as never;

  it('includes a just-drawn shape (shape._route_id) with no trips or stops', () => {
    expect(computeShapePatterns('R', [], [], [shape('s1', 'R')])).toEqual([
      { shapeId: 's1', directionId: 0 },
    ]);
  });

  it('gives a drawn shape the direction not used by a real pattern', () => {
    const trips = [{ trip_id: 't', route_id: 'R', shape_id: 'out', direction_id: 0 }] as never;
    expect(computeShapePatterns('R', trips, [], [shape('out', 'R'), shape('in', 'R')])).toEqual([
      { shapeId: 'out', directionId: 0 },
      { shapeId: 'in', directionId: 1 },
    ]);
  });

  it('assigns two freshly drawn shapes to directions 0 then 1', () => {
    expect(computeShapePatterns('R', [], [], [shape('a', 'R'), shape('b', 'R')])).toEqual([
      { shapeId: 'a', directionId: 0 },
      { shapeId: 'b', directionId: 1 },
    ]);
  });

  it('ignores a drawn shape belonging to another route', () => {
    expect(computeShapePatterns('R', [], [], [shape('x', 'OTHER')])).toEqual([]);
  });
});

// Regression (Trent Wiesner forum report, "Ghost trips cannot be deleted"):
// build an outbound timetable before any shape exists (trips get empty
// shape_id), then draw + stop the inbound direction (route now has a shape).
// The grid flips to shape-filter mode and the outbound trips match no pattern →
// invisible AND undeletable. computeTimetablePatterns adds a "No shape" bucket
// so they stay reachable; unreachableTimetableTripIds powers the cleanup recipe.
describe('No-shape bucket + ghost detection', () => {
  const t = (id: string, over: Partial<Trip> = {}): Trip =>
    ({ trip_id: id, route_id: 'R', service_id: 'wk', direction_id: 0, ...over }) as Trip;
  const rs = (over: Partial<RouteStop>): RouteStop =>
    ({ route_id: 'R', stop_id: 's', stop_sequence: 0, direction_id: 0, ...over }) as RouteStop;

  it('isNoShapeBucket distinguishes the sentinel from real shape ids', () => {
    expect(isNoShapeBucket(noShapeBucketId(0))).toBe(true);
    expect(isNoShapeBucket(noShapeBucketId(1))).toBe(true);
    expect(noShapeBucketId(0)).not.toBe(noShapeBucketId(1));
    expect(isNoShapeBucket('in')).toBe(false);
    expect(isNoShapeBucket('')).toBe(false);
    expect(isNoShapeBucket(null)).toBe(false);
  });

  it('the repro: outbound trips (empty shape) + an inbound shape → a No-shape bucket', () => {
    // 3 outbound trips with no shape (made before any shape existed).
    const trips = [t('o1'), t('o2'), t('o3')];
    // Inbound was drawn + stopped: its route_stops carry the inbound shape.
    const routeStops = [rs({ shape_id: 'in', direction_id: 1, stop_sequence: 0 })];

    // Without the bucket, the only pattern is the inbound shape — outbound ghosts.
    expect(computeShapePatterns('R', trips, routeStops)).toEqual([{ shapeId: 'in', directionId: 1 }]);

    // With it, a direction-0 "No shape" bucket is appended so they're reachable.
    expect(computeTimetablePatterns('R', trips, routeStops)).toEqual([
      { shapeId: 'in', directionId: 1 },
      { shapeId: noShapeBucketId(0), directionId: 0 },
    ]);

    // And all three outbound trips are flagged as unreachable (ghosts).
    const ghosts = unreachableTimetableTripIds(trips, routeStops);
    expect([...ghosts].sort()).toEqual(['o1', 'o2', 'o3']);
  });

  it('adds no bucket / ghosts when the route has no shapes at all (direction fallback)', () => {
    const trips = [t('o1'), t('i1', { direction_id: 1 })];
    expect(computeTimetablePatterns('R', trips, [])).toEqual([]);
    expect(unreachableTimetableTripIds(trips, []).size).toBe(0);
  });

  it('adds no bucket / ghosts when every trip already has a real shape', () => {
    const trips = [t('o1', { shape_id: 'out' }), t('i1', { shape_id: 'in', direction_id: 1 })];
    expect(computeTimetablePatterns('R', trips, [])).toEqual([
      { shapeId: 'out', directionId: 0 },
      { shapeId: 'in', directionId: 1 },
    ]);
    expect(unreachableTimetableTripIds(trips, []).size).toBe(0);
  });

  it('buckets ghosts on BOTH directions when each has shapeless trips alongside a shape', () => {
    const trips = [
      t('o-ghost'),                              // dir 0, no shape
      t('i-ghost', { direction_id: 1 }),         // dir 1, no shape
      t('o-ok', { shape_id: 'out' }),            // dir 0, real shape
    ];
    const patterns = computeTimetablePatterns('R', trips, []);
    expect(patterns).toContainEqual({ shapeId: noShapeBucketId(0), directionId: 0 });
    expect(patterns).toContainEqual({ shapeId: noShapeBucketId(1), directionId: 1 });
    expect([...unreachableTimetableTripIds(trips, [])].sort()).toEqual(['i-ghost', 'o-ghost']);
  });

  // Live reactivity: the timetable must pick up a shape added via Routes > Shapes
  // even before it has any stops/trips, so the direction control morphs live.
  it('surfaces a freshly drawn shape as a timetable pattern (shapes arg)', () => {
    const shape = (id: string, routeId?: string) => ({ shape_id: id, points: [], _route_id: routeId }) as never;
    // One real outbound shape; a second shape was just drawn (no stops/trips yet).
    const trips = [t('o1', { shape_id: 'out' })];
    // Without the drawn shape → 1 pattern (static-label territory).
    expect(computeTimetablePatterns('R', trips, [], [])).toEqual([{ shapeId: 'out', directionId: 0 }]);
    // With it → 2 patterns, so the control morphs to segmented and Split enables.
    expect(computeTimetablePatterns('R', trips, [], [shape('out', 'R'), shape('in', 'R')])).toEqual([
      { shapeId: 'out', directionId: 0 },
      { shapeId: 'in', directionId: 1 },
    ]);
    // A drawn shape carries no trips, so it never creates ghosts.
    expect(unreachableTimetableTripIds(trips, []).size).toBe(0);
  });

  it("a trip's own non-empty shape_id always forms a reachable pattern (never a ghost)", () => {
    // Even a dangling shape_id (the Shape row was deleted) is reachable: like
    // computeShapePatterns, the helper turns every non-empty trip shape_id into
    // a selectable pattern, so the trip is never hidden — no false ghost.
    const trips = [t('dangling', { shape_id: 'gone' }), t('ok', { shape_id: 'in', direction_id: 1 })];
    expect(unreachableTimetableTripIds(trips, []).has('dangling')).toBe(false);
  });
});
