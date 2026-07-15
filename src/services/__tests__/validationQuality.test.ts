// Unit tests for the ported MobilityData-parity quality checks
// (services/validationQuality.ts, issue #50). Each finder is exercised with a
// happy path, the boundary case, and a false-positive guard.
import { describe, expect, it } from 'vitest';
import {
  findDecreasingShapeDistances,
  findDecreasingStopTimeDistances,
  findFastTravel,
  findStopsTooFarFromShape,
  checkFeedExpiry,
  maxVehicleSpeedKph,
  findRouteLongNameContainsShort,
  findRouteSameNameAndDesc,
  findDuplicateRouteNames,
} from '../validationQuality';
import type { Route, Shape, Stop, StopTime, Trip } from '../../types/gtfs';

const shape = (shape_id: string, dists: number[], opts: { unordered?: boolean } = {}): Shape => {
  const pts = dists.map((d, i) => ({
    shape_pt_lat: 45 + i * 0.001,
    shape_pt_lon: -111 + i * 0.001,
    shape_pt_sequence: i + 1,
    shape_dist_traveled: d,
  }));
  return { shape_id, points: opts.unordered ? [...pts].reverse() : pts };
};

const trip = (trip_id: string): Trip =>
  ({ trip_id, route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip);

const st = (trip_id: string, seq: number, dist: number | undefined): StopTime =>
  ({
    trip_id, stop_id: `s${seq}`, stop_sequence: seq,
    arrival_time: '', departure_time: '', shape_dist_traveled: dist,
  } as StopTime);

describe('findDecreasingShapeDistances (decreasing_shape_distance)', () => {
  it('flags a shape whose distance goes backwards', () => {
    const out = findDecreasingShapeDistances([shape('SH1', [0, 100, 90, 300])]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ shape_id: 'SH1', atSequence: 3, prevDist: 100, thisDist: 90 });
  });

  it('does not flag a strictly increasing shape (happy path)', () => {
    expect(findDecreasingShapeDistances([shape('SH1', [0, 100, 200, 300])])).toHaveLength(0);
  });

  it('does not flag an all-zero shape (owned by the separate all-zero warning)', () => {
    expect(findDecreasingShapeDistances([shape('SH1', [0, 0, 0, 0])])).toHaveLength(0);
  });

  it('evaluates points in shape_pt_sequence order, not array order', () => {
    // Points supplied reversed but sequence numbers still ascend → increasing.
    expect(findDecreasingShapeDistances([shape('SH1', [0, 100, 200], { unordered: true })])).toHaveLength(0);
  });

  it('treats equal consecutive distances as OK for shapes (only a decrease is a defect)', () => {
    // MobilityData flags decreasing (not equal) for shape points.
    expect(findDecreasingShapeDistances([shape('SH1', [0, 100, 100, 200])])).toHaveLength(0);
  });
});

describe('findDecreasingStopTimeDistances (decreasing_or_equal_stop_time_distance)', () => {
  it('flags a decreasing stop-time distance', () => {
    const out = findDecreasingStopTimeDistances(
      [trip('T1')],
      [st('T1', 1, 0), st('T1', 2, 500), st('T1', 3, 400)],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ trip_id: 'T1', atSequence: 3, equal: false });
  });

  it('flags an EQUAL stop-time distance (equal is a defect here, unlike shapes)', () => {
    const out = findDecreasingStopTimeDistances(
      [trip('T1')],
      [st('T1', 1, 0), st('T1', 2, 500), st('T1', 3, 500)],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ atSequence: 3, equal: true });
  });

  it('does not flag strictly increasing distances (happy path)', () => {
    expect(findDecreasingStopTimeDistances(
      [trip('T1')],
      [st('T1', 1, 0), st('T1', 2, 500), st('T1', 3, 900)],
    )).toHaveLength(0);
  });

  it('ignores rows with no shape_dist_traveled (feed omits stop-time distances)', () => {
    expect(findDecreasingStopTimeDistances(
      [trip('T1')],
      [st('T1', 1, undefined), st('T1', 2, undefined), st('T1', 3, undefined)],
    )).toHaveLength(0);
  });

  it('compares across an undefined gap using the last DEFINED distance', () => {
    // 0 → (undef) → 400 is fine; a later 300 after 400 is the defect.
    const out = findDecreasingStopTimeDistances(
      [trip('T1')],
      [st('T1', 1, 0), st('T1', 2, undefined), st('T1', 3, 400), st('T1', 4, 300)],
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ atSequence: 4, prevDist: 400, thisDist: 300 });
  });
});

// ─── Helpers for the geometry / naming finders ─────────────────────────────
const stopAt = (stop_id: string, lat: number, lon: number, extra: Partial<Stop> = {}): Stop =>
  ({ stop_id, stop_name: stop_id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0, ...extra } as Stop);

const route = (route_id: string, route_type: number, extra: Partial<Route> = {}): Route =>
  ({ route_id, agency_id: 'A1', route_short_name: '', route_long_name: '', route_type,
     route_color: '', route_text_color: '', ...extra } as Route);

const stTimed = (trip_id: string, seq: number, stop_id: string, arr: string, dep: string): StopTime =>
  ({ trip_id, stop_id, stop_sequence: seq, arrival_time: arr, departure_time: dep } as StopTime);

describe('maxVehicleSpeedKph (per route_type, MobilityData)', () => {
  it('maps each route type to MobilityData ceilings', () => {
    expect(maxVehicleSpeedKph(0)).toBe(100);  // light rail
    expect(maxVehicleSpeedKph(2)).toBe(500);  // rail
    expect(maxVehicleSpeedKph(3)).toBe(150);  // bus
    expect(maxVehicleSpeedKph(4)).toBe(80);   // ferry
    expect(maxVehicleSpeedKph(5)).toBe(30);   // cable tram
    expect(maxVehicleSpeedKph(7)).toBe(50);   // funicular
    expect(maxVehicleSpeedKph(715)).toBe(200); // extended/unknown → default
  });
});

describe('findFastTravel (fast_travel_between_consecutive_stops / far_stops)', () => {
  // ~3.9 km apart (0.05° lon at lat 45), covered in 30 s → ~468 km/h.
  const near = [stopAt('a', 45, -111.0), stopAt('b', 45, -110.95)];
  const trips = [{ trip_id: 'T1', route_id: 'R', service_id: 'S', direction_id: 0 } as Trip];

  it('flags a consecutive hop that exceeds the bus ceiling (150 km/h)', () => {
    const out = findFastTravel(
      trips,
      [stTimed('T1', 1, 'a', '08:00:00', '08:00:00'), stTimed('T1', 2, 'b', '08:00:30', '08:00:30')],
      near, [route('R', 3)],
    );
    const consec = out.filter((f) => f.kind === 'consecutive');
    expect(consec).toHaveLength(1);
    expect(consec[0].maxSpeedKph).toBe(150);
    expect(consec[0].speedKph).toBeGreaterThan(150);
    // <10 km, so the far-stops notice does NOT also fire.
    expect(out.some((f) => f.kind === 'far')).toBe(false);
  });

  it('does NOT flag the same hop for a train (500 km/h ceiling) — false-positive guard', () => {
    const out = findFastTravel(
      trips,
      [stTimed('T1', 1, 'a', '08:00:00', '08:00:00'), stTimed('T1', 2, 'b', '08:00:30', '08:00:30')],
      near, [route('R', 2)], // rail
    );
    expect(out).toHaveLength(0);
  });

  it('does NOT flag a normal 5-minute bus hop (minute-resolution buffer applied)', () => {
    const out = findFastTravel(
      trips,
      [stTimed('T1', 1, 'a', '08:00:00', '08:00:00'), stTimed('T1', 2, 'b', '08:05:00', '08:05:00')],
      near, [route('R', 3)],
    );
    expect(out).toHaveLength(0);
  });

  it('flags a far-stops span over 10 km travelled implausibly fast', () => {
    // ~20 km apart (0.254° lon), 3 minutes → 300+ km/h over >10 km.
    const far = [stopAt('a', 45, -111.0), stopAt('b', 45, -110.746)];
    const out = findFastTravel(
      trips,
      [stTimed('T1', 1, 'a', '08:00:00', '08:00:00'), stTimed('T1', 2, 'b', '08:03:00', '08:03:00')],
      far, [route('R', 3)],
    );
    expect(out.some((f) => f.kind === 'far')).toBe(true);
    expect(out.find((f) => f.kind === 'far')!.distanceKm).toBeGreaterThan(10);
  });
});

describe('findStopsTooFarFromShape (stop_too_far_from_shape, 100 m)', () => {
  // A straight east-west shape at lat 45 from lon -111.0 to -110.9.
  const shp: Shape = {
    shape_id: 'SH', points: [
      { shape_pt_lat: 45, shape_pt_lon: -111.0, shape_pt_sequence: 1, shape_dist_traveled: 0 },
      { shape_pt_lat: 45, shape_pt_lon: -110.9, shape_pt_sequence: 2, shape_dist_traveled: 0 },
    ],
  };
  const trips = [{ trip_id: 'T1', route_id: 'R', service_id: 'S', direction_id: 0, shape_id: 'SH' } as Trip];
  const stimes = [stTimed('T1', 1, 'on', '08:00:00', '08:00:00'), stTimed('T1', 2, 'off', '08:10:00', '08:10:00')];

  it('flags a stop ~500 m off the shape', () => {
    const stops = [stopAt('on', 45, -110.95), stopAt('off', 45.0045, -110.95)]; // ~500 m north
    const out = findStopsTooFarFromShape(trips, stimes, stops, [shp]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ shape_id: 'SH', stop_id: 'off', route_id: 'R' });
    expect(out[0].distanceMeters).toBeGreaterThan(100);
  });

  it('does NOT flag a stop ~50 m off the shape — boundary/false-positive guard', () => {
    const stops = [stopAt('on', 45, -110.95), stopAt('off', 45.00045, -110.95)]; // ~50 m north
    expect(findStopsTooFarFromShape(trips, stimes, stops, [shp])).toHaveLength(0);
  });

  it('does NOT flag when the trip has no shape', () => {
    const noShapeTrip = [{ trip_id: 'T1', route_id: 'R', service_id: 'S', direction_id: 0 } as Trip];
    const stops = [stopAt('on', 45, -110.95), stopAt('off', 45.05, -110.95)];
    expect(findStopsTooFarFromShape(noShapeTrip, stimes, stops, [shp])).toHaveLength(0);
  });
});

describe('checkFeedExpiry (feed_expiration_date7_days / _30_days)', () => {
  const today = 20260715;

  it('flags the 7-day tier from feed_info.feed_end_date', () => {
    expect(checkFeedExpiry('20260720', [], today)).toMatchObject({ tier: 7, source: 'feed_info', daysRemaining: 5 });
  });
  it('flags the 30-day tier from feed_info.feed_end_date', () => {
    expect(checkFeedExpiry('20260804', [], today)).toMatchObject({ tier: 30, source: 'feed_info', daysRemaining: 20 });
  });
  it('does not flag when feed_info end date is more than 30 days out', () => {
    expect(checkFeedExpiry('20260824', [], today)).toBeNull();
  });
  it('still flags (7-day) when feed_info end date is already in the past — matches MobilityData', () => {
    expect(checkFeedExpiry('20260712', [], today)).toMatchObject({ tier: 7, source: 'feed_info', daysRemaining: -3 });
  });
  it('falls back to the service window (latest calendar end) when feed_info has no end date', () => {
    expect(checkFeedExpiry(undefined, ['20260101', '20260725'], today)).toMatchObject({ tier: 30, source: 'service_window' });
  });
  it('does NOT nudge on an already-expired service window (owned by the per-service check)', () => {
    expect(checkFeedExpiry(undefined, ['20260101', '20260601'], today)).toBeNull();
  });
  it('returns null with neither feed_info nor calendars', () => {
    expect(checkFeedExpiry(undefined, [], today)).toBeNull();
  });
});

describe('findRouteLongNameContainsShort (route_long_name_contains_short_name)', () => {
  it('flags when the long name starts with the short name + a separator', () => {
    const out = findRouteLongNameContainsShort([route('R', 3, { route_short_name: '10', route_long_name: '10 Downtown' })]);
    expect(out).toHaveLength(1);
  });
  it('flags when the long name IS the short name', () => {
    expect(findRouteLongNameContainsShort([route('R', 3, { route_short_name: '10', route_long_name: '10' })])).toHaveLength(1);
  });
  it('does NOT flag "10" inside "100 Express" — the separator guard', () => {
    expect(findRouteLongNameContainsShort([route('R', 3, { route_short_name: '10', route_long_name: '100 Express' })])).toHaveLength(0);
  });
  it('does NOT flag when the long name merely starts with the short letters (no separator)', () => {
    expect(findRouteLongNameContainsShort([route('R', 3, { route_short_name: 'R', route_long_name: 'Red Line' })])).toHaveLength(0);
  });
});

describe('findRouteSameNameAndDesc (same_name_and_description_for_route)', () => {
  it('flags a route_desc equal (case-insensitive) to the long name', () => {
    const out = findRouteSameNameAndDesc([route('R', 3, { route_long_name: 'Downtown Loop', route_desc: 'downtown loop' })]);
    expect(out).toEqual([{ route_id: 'R', which: 'long', name: 'Downtown Loop' }]);
  });
  it('flags a route_desc equal to the short name', () => {
    expect(findRouteSameNameAndDesc([route('R', 3, { route_short_name: '10', route_desc: '10' })])[0]).toMatchObject({ which: 'short' });
  });
  it('does NOT flag a genuinely descriptive route_desc — false-positive guard', () => {
    expect(findRouteSameNameAndDesc([route('R', 3, { route_long_name: 'Downtown Loop', route_desc: 'Serves the hospital and courthouse' })])).toHaveLength(0);
  });
});

describe('findDuplicateRouteNames (duplicate_route_name)', () => {
  it('flags two routes sharing long+short+type+agency', () => {
    const out = findDuplicateRouteNames([
      route('R1', 3, { route_short_name: '1', route_long_name: 'Main', agency_id: 'A1' }),
      route('R2', 3, { route_short_name: '1', route_long_name: 'Main', agency_id: 'A1' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].route_ids).toEqual(['R1', 'R2']);
  });
  it('does NOT flag when the agency differs — false-positive guard', () => {
    expect(findDuplicateRouteNames([
      route('R1', 3, { route_short_name: '1', route_long_name: 'Main', agency_id: 'A1' }),
      route('R2', 3, { route_short_name: '1', route_long_name: 'Main', agency_id: 'A2' }),
    ])).toHaveLength(0);
  });
  it('does NOT flag when the route_type differs', () => {
    expect(findDuplicateRouteNames([
      route('R1', 3, { route_short_name: '1', route_long_name: 'Main', agency_id: 'A1' }),
      route('R2', 2, { route_short_name: '1', route_long_name: 'Main', agency_id: 'A1' }),
    ])).toHaveLength(0);
  });
});
