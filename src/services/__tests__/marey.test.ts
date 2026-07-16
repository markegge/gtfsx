// Pure-logic tests for marey.ts: per-stop distance derivation (shape
// projection, straight-line fallback, evenly-spaced fallback) and the
// trip-polyline assembly from stop_times. No store / React / fetch involved.
import { describe, expect, it } from 'vitest';
import {
  buildMareyData,
  deriveStopDistances,
  enforceMonotonic,
  stopDistancesAlongShape,
  stopDistancesStraightLine,
} from '../marey';
import type { Shape, Stop, StopTime } from '../../types/gtfs';

function makeStop(id: string, lon: number, lat: number): Stop {
  return {
    stop_id: id,
    stop_name: `Stop ${id}`,
    stop_lat: lat,
    stop_lon: lon,
    location_type: 0,
    wheelchair_boarding: 0,
  };
}

// A straight west→east shape: 4 vertices spanning lon 0 → 0.03 at lat 0.
const straightShape: Shape = {
  shape_id: 'sh1',
  points: [
    { shape_pt_lat: 0, shape_pt_lon: 0, shape_pt_sequence: 0, shape_dist_traveled: 0 },
    { shape_pt_lat: 0, shape_pt_lon: 0.01, shape_pt_sequence: 1, shape_dist_traveled: 0 },
    { shape_pt_lat: 0, shape_pt_lon: 0.02, shape_pt_sequence: 2, shape_dist_traveled: 0 },
    { shape_pt_lat: 0, shape_pt_lon: 0.03, shape_pt_sequence: 3, shape_dist_traveled: 0 },
  ],
};

describe('enforceMonotonic', () => {
  it('clamps each value to the running max', () => {
    expect(enforceMonotonic([0, 2, 1, 3, 2.5])).toEqual([0, 2, 2, 3, 3]);
  });
});

describe('stopDistancesAlongShape', () => {
  it('measures cumulative distance along the shape in stop order', () => {
    const stops: [number, number][] = [[0, 0], [0.015, 0], [0.03, 0]];
    const d = stopDistancesAlongShape([[0, 0], [0.01, 0], [0.02, 0], [0.03, 0]], stops)!;
    expect(d[0]).toBeCloseTo(0, 3);
    expect(d[1]).toBeGreaterThan(d[0]);
    expect(d[2]).toBeGreaterThan(d[1]);
  });

  it('returns null for an unusable shape', () => {
    expect(stopDistancesAlongShape([[0, 0]], [[0, 0]])).toBeNull();
  });
});

describe('stopDistancesStraightLine', () => {
  it('is monotonic and carries forward across a missing coordinate', () => {
    const d = stopDistancesStraightLine([[0, 0], null, [0.02, 0]]);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(0);          // missing coord — no new distance
    expect(d[2]).toBeGreaterThan(0); // resumes from the last known point
  });
});

describe('deriveStopDistances', () => {
  const stops = [makeStop('a', 0, 0), makeStop('b', 0.015, 0), makeStop('c', 0.03, 0)];

  it('projects onto the shape when available', () => {
    const { distances, source } = deriveStopDistances(stops, straightShape);
    expect(source).toBe('shape');
    expect(distances).toHaveLength(3);
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
    }
  });

  it('falls back to straight-line distance with no shape', () => {
    const { distances, source } = deriveStopDistances(stops);
    expect(source).toBe('stops');
    expect(distances[2]).toBeGreaterThan(distances[0]);
  });

  it('falls back to evenly-spaced when no stop has coordinates', () => {
    const noCoords = [
      { ...makeStop('a', 0, 0), stop_lat: NaN, stop_lon: NaN },
      { ...makeStop('b', 0, 0), stop_lat: NaN, stop_lon: NaN },
      { ...makeStop('c', 0, 0), stop_lat: NaN, stop_lon: NaN },
    ];
    const { distances, source } = deriveStopDistances(noCoords);
    expect(source).toBe('sequence');
    expect(distances).toEqual([0, 0.5, 1]);
  });
});

describe('buildMareyData', () => {
  const stops = [makeStop('a', 0, 0), makeStop('b', 0.015, 0), makeStop('c', 0.03, 0)];
  const byTrip = new Map<string, StopTime[]>([
    ['t1', [
      { trip_id: 't1', stop_id: 'a', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
      { trip_id: 't1', stop_id: 'b', stop_sequence: 2, arrival_time: '08:10:00', departure_time: '08:10:00' },
      { trip_id: 't1', stop_id: 'c', stop_sequence: 3, arrival_time: '08:20:00', departure_time: '08:20:00' },
    ]],
    ['t2', [ // overnight trip, only two stops with times
      { trip_id: 't2', stop_id: 'a', stop_sequence: 1, arrival_time: '23:50:00', departure_time: '23:50:00' },
      { trip_id: 't2', stop_id: 'c', stop_sequence: 3, arrival_time: '24:10:00', departure_time: '24:10:00' },
    ]],
  ]);

  it('builds one polyline per trip with points in stop order', () => {
    const data = buildMareyData({ orderedStops: stops, shape: straightShape, trips: [{ trip_id: 't1' }, { trip_id: 't2' }], stopTimesByTrip: byTrip });
    expect(data.trips).toHaveLength(2);
    const t1 = data.trips.find((t) => t.tripId === 't1')!;
    expect(t1.points.map((p) => p.stopId)).toEqual(['a', 'b', 'c']);
    expect(t1.points[0].timeSec).toBe(8 * 3600);
    expect(t1.points[2].timeSec).toBe(8 * 3600 + 1200);
  });

  it('flags overnight trips and tracks the time extent', () => {
    const data = buildMareyData({ orderedStops: stops, shape: straightShape, trips: [{ trip_id: 't1' }, { trip_id: 't2' }], stopTimesByTrip: byTrip });
    expect(data.hasOvernight).toBe(true);
    expect(data.minTimeSec).toBe(8 * 3600);
    expect(data.maxTimeSec).toBe(24 * 3600 + 600);
  });

  it('skips trips with fewer than two timed stops', () => {
    const sparse = new Map<string, StopTime[]>([
      ['t3', [{ trip_id: 't3', stop_id: 'a', stop_sequence: 1, arrival_time: '09:00:00', departure_time: '09:00:00' }]],
    ]);
    const data = buildMareyData({ orderedStops: stops, trips: [{ trip_id: 't3' }], stopTimesByTrip: sparse });
    expect(data.trips).toHaveLength(0);
  });

  it('plots frequency projections as derived lines alongside the template (item #10)', () => {
    const projections = [
      {
        templateTripId: 't1', key: 't1~f0k1', departureSec: 8 * 3600 + 1800, headwaySecs: 1800, exactTimes: 0 as const,
        stopTimes: [
          { trip_id: 't1', stop_id: 'a', stop_sequence: 1, arrival_time: '08:30:00', departure_time: '08:30:00' },
          { trip_id: 't1', stop_id: 'b', stop_sequence: 2, arrival_time: '08:40:00', departure_time: '08:40:00' },
          { trip_id: 't1', stop_id: 'c', stop_sequence: 3, arrival_time: '08:50:00', departure_time: '08:50:00' },
        ],
      },
    ];
    const data = buildMareyData({
      orderedStops: stops, shape: straightShape,
      trips: [{ trip_id: 't1' }], stopTimesByTrip: byTrip, virtualTrips: projections,
    });
    // The template line (real, full weight) + one derived projection.
    expect(data.trips).toHaveLength(2);
    const template = data.trips.find((t) => t.tripId === 't1')!;
    const derived = data.trips.find((t) => t.tripId === 't1~f0k1')!;
    expect(template.derived).toBeFalsy();
    expect(derived.derived).toBe(true);
    expect(derived.templateTripId).toBe('t1');
    expect(derived.exactTimes).toBe(0);
    // The projection's shifted times land on the same stop order, +30 min.
    expect(derived.points.map((p) => p.stopId)).toEqual(['a', 'b', 'c']);
    expect(derived.points[0].timeSec).toBe(8 * 3600 + 1800);
    // The derived departure widens the plotted time extent.
    expect(data.maxTimeSec).toBe(8 * 3600 + 1800 + 1200);
  });
});
