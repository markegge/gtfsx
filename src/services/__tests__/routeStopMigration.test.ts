import { describe, it, expect } from 'vitest';
import { backfillRouteStopShapeIds } from '../routeStopMigration';
import type { RouteStop, Trip } from '../../types/gtfs';

const rs = (over: Partial<RouteStop>): RouteStop => ({
  route_id: 'r1', stop_id: 's1', direction_id: 0, stop_sequence: 0, _snapped: false, ...over,
});
const trip = (over: Partial<Trip>): Trip =>
  ({ trip_id: 't1', route_id: 'r1', service_id: 'wk', direction_id: 0, ...over }) as Trip;

describe('backfillRouteStopShapeIds', () => {
  it('assigns the representative shape per (route, direction) to shape-less stops', () => {
    // Reproduces the legacy-feed regression: old route stops carry no shape_id,
    // so the per-shape timetable/stops views show nothing until they are keyed.
    const stops = [
      rs({ stop_id: 'a', direction_id: 0 }),
      rs({ stop_id: 'b', direction_id: 0 }),
      rs({ stop_id: 'c', direction_id: 1 }),
    ];
    const trips = [
      trip({ direction_id: 0, shape_id: 'shp_out' }),
      trip({ direction_id: 1, shape_id: 'shp_in' }),
    ];
    const out = backfillRouteStopShapeIds(stops, trips);
    expect(out.map((s) => s.shape_id)).toEqual(['shp_out', 'shp_out', 'shp_in']);
  });

  it('uses the FIRST shape seen for a (route, direction)', () => {
    const stops = [rs({ stop_id: 'a', direction_id: 0 })];
    const trips = [
      trip({ trip_id: 't1', direction_id: 0, shape_id: 'first' }),
      trip({ trip_id: 't2', direction_id: 0, shape_id: 'second' }),
    ];
    expect(backfillRouteStopShapeIds(stops, trips)[0].shape_id).toBe('first');
  });

  it('leaves stops that already have a shape_id untouched (new feeds)', () => {
    const stops = [rs({ stop_id: 'a', shape_id: 'kept' })];
    const trips = [trip({ direction_id: 0, shape_id: 'other' })];
    const out = backfillRouteStopShapeIds(stops, trips);
    expect(out[0].shape_id).toBe('kept');
    expect(out).toBe(stops); // fast-path: same reference, no rebuild
  });

  it('leaves shape_id undefined when the feed has no trip shapes', () => {
    const stops = [rs({ stop_id: 'a' })];
    const trips = [trip({ direction_id: 0, shape_id: undefined })];
    expect(backfillRouteStopShapeIds(stops, trips)[0].shape_id).toBeUndefined();
  });

  it('handles empty input', () => {
    expect(backfillRouteStopShapeIds([], [])).toEqual([]);
  });
});
