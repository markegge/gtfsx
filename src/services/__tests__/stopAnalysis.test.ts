import { describe, it, expect } from 'vitest';
import type { Stop, Route, Trip, StopTime, Calendar } from '../../types/gtfs';
import {
  computeStopSpacing,
  computeBalancingCandidates,
  computeServiceIntensity,
  computeAccessibilityAudit,
  representativeDay,
  dominantPatterns,
  type FeedSlice,
} from '../stopAnalysis';

/* ── tiny builders ── */
function stop(id: string, lat: number, lon: number, extra: Partial<Stop> = {}): Stop {
  return { stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0, ...extra };
}
function route(id: string, extra: Partial<Route> = {}): Route {
  return {
    route_id: id, agency_id: 'A', route_short_name: id, route_long_name: '',
    route_type: 3, route_color: '000000', route_text_color: 'FFFFFF', ...extra,
  };
}
function trip(id: string, routeId: string, serviceId: string, dir: 0 | 1 = 0): Trip {
  return { trip_id: id, route_id: routeId, service_id: serviceId, direction_id: dir };
}
function st(tripId: string, stopId: string, seq: number, dep: string): StopTime {
  return { trip_id: tripId, arrival_time: dep, departure_time: dep, stop_id: stopId, stop_sequence: seq };
}
function weekdayCal(serviceId: string, days: Partial<Record<keyof Calendar, 0 | 1>>): Calendar {
  return {
    service_id: serviceId,
    monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0, sunday: 0,
    start_date: '20260101', end_date: '20261231', ...days,
  } as Calendar;
}
function feed(p: Partial<FeedSlice>): FeedSlice {
  return {
    stops: [], routes: [], routeStops: [], trips: [], stopTimes: [], calendars: [], calendarDates: [],
    ...p,
  };
}

/** A straight north–south line of stops. 0.001° latitude ≈ 365 ft. */
const LAT0 = 40.0;
const LON0 = -100.0;
function lineStop(id: string, latOffsetDeg: number, extra: Partial<Stop> = {}): Stop {
  return stop(id, LAT0 + latOffsetDeg, LON0, extra);
}

describe('representativeDay', () => {
  it('picks the weekday with the most trips', () => {
    const f = feed({
      calendars: [weekdayCal('WK', { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 }), weekdayCal('SAT', { saturday: 1 })],
      trips: [trip('t1', 'R', 'WK'), trip('t2', 'R', 'WK'), trip('t3', 'R', 'SAT')],
    });
    const rep = representativeDay(f);
    // WK runs Mon–Fri with 2 trips each weekday (4 total weekday-trip counts);
    // Saturday only has 1. So a weekday wins and WK is the active service.
    expect(rep.serviceIds.has('WK')).toBe(true);
    expect(rep.serviceIds.has('SAT')).toBe(false);
  });

  it('falls back to all services when there is no calendar', () => {
    const f = feed({ trips: [trip('t1', 'R', 'S1'), trip('t2', 'R', 'S2')] });
    const rep = representativeDay(f);
    expect(rep.weekday).toBeNull();
    expect(rep.serviceIds).toEqual(new Set(['S1', 'S2']));
  });
});

describe('dominantPatterns', () => {
  it('uses the longest trip per (route, direction)', () => {
    const f = feed({
      trips: [trip('short', 'R', 'WK'), trip('long', 'R', 'WK')],
      stopTimes: [
        st('short', 'a', 1, '08:00:00'), st('short', 'b', 2, '08:05:00'),
        st('long', 'a', 1, '09:00:00'), st('long', 'b', 2, '09:05:00'), st('long', 'c', 3, '09:10:00'),
      ],
    });
    const pats = dominantPatterns(f);
    expect(pats).toHaveLength(1);
    expect(pats[0].stopIds).toEqual(['a', 'b', 'c']);
  });
});

describe('computeStopSpacing', () => {
  it('reports a median close to the hand-computed great-circle spacing', () => {
    // Four evenly spaced stops, 0.001° (~365 ft) apart.
    const stops = [lineStop('s0', 0), lineStop('s1', 0.001), lineStop('s2', 0.002), lineStop('s3', 0.003)];
    const f = feed({
      stops,
      routes: [route('R')],
      trips: [trip('t', 'R', 'WK')],
      stopTimes: stops.map((s, i) => st('t', s.stop_id, i + 1, '08:00:00')),
    });
    const r = computeStopSpacing(f);
    expect(r.pairCount).toBe(3);
    // 0.001° latitude is ~365 ft; allow a generous tolerance for the model.
    expect(r.medianFt).toBeGreaterThan(330);
    expect(r.medianFt).toBeLessThan(400);
    expect(r.perRoute[0].routeId).toBe('R');
  });

  it('classifies counts against benchmarks', () => {
    const stops = [
      lineStop('a', 0),
      lineStop('b', 0.0005),   // ~182 ft — too close
      lineStop('c', 0.0055),   // ~1825 ft from b — in/above target
      lineStop('d', 0.0255),   // ~7300 ft from c — way past hard max
    ];
    const f = feed({
      stops, routes: [route('R')], trips: [trip('t', 'R', 'WK')],
      stopTimes: stops.map((s, i) => st('t', s.stop_id, i + 1, '08:00:00')),
    });
    const r = computeStopSpacing(f);
    expect(r.tooCloseCount).toBe(1);   // a→b
    expect(r.aboveMaxCount).toBe(1);   // c→d
  });
});

describe('computeBalancingCandidates', () => {
  // Terminal, S1, S2 (close to S1), S3, Terminal.
  const stops = [
    lineStop('T0', 0),
    lineStop('S1', 0.010),
    lineStop('S2', 0.0105),  // ~182 ft from S1 → too close
    lineStop('S3', 0.020),
    lineStop('T4', 0.030),
  ];
  const f = feed({
    stops,
    routes: [route('R')],
    calendars: [weekdayCal('WK', { monday: 1 })],
    trips: [trip('t1', 'R', 'WK'), trip('t2', 'R', 'WK')],
    stopTimes: [
      ...stops.map((s, i) => st('t1', s.stop_id, i + 1, '08:00:00')),
      ...stops.map((s, i) => st('t2', s.stop_id, i + 1, '09:00:00')),
    ],
  });

  it('flags the interior too-close pair, skips terminals and the far pair', () => {
    const r = computeBalancingCandidates(f, { thresholdFt: 600, dwellSeconds: 18, serviceIds: new Set(['WK']) });
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(new Set([c.stopAId, c.stopBId])).toEqual(new Set(['S1', 'S2']));
    // 2 trips/day × 18s = 36s saved.
    expect(c.tripsPerDay).toBe(2);
    expect(c.savingsSecPerDay).toBe(36);
  });

  it('does not flag stations', () => {
    const f2: FeedSlice = {
      ...f,
      stops: f.stops.map((s) => (s.stop_id === 'S2' ? { ...s, location_type: 1 } : s)),
    };
    const r = computeBalancingCandidates(f2, { thresholdFt: 600, dwellSeconds: 18, serviceIds: new Set(['WK']) });
    expect(r.candidates).toHaveLength(0);
  });
});

describe('computeServiceIntensity', () => {
  it('counts trips/day per stop on the active service', () => {
    const f = feed({
      stops: [stop('a', 40, -100), stop('b', 40.01, -100)],
      routes: [route('R')],
      calendars: [weekdayCal('WK', { monday: 1 })],
      trips: [trip('t1', 'R', 'WK'), trip('t2', 'R', 'WK')],
      routeStops: [
        { route_id: 'R', stop_id: 'a', direction_id: 0, stop_sequence: 1, _snapped: false },
        { route_id: 'R', stop_id: 'b', direction_id: 0, stop_sequence: 2, _snapped: false },
      ],
      stopTimes: [
        st('t1', 'a', 1, '08:00:00'), st('t1', 'b', 2, '08:10:00'),
        st('t2', 'a', 1, '09:00:00'), st('t2', 'b', 2, '09:10:00'),
      ],
    });
    const out = computeServiceIntensity(f, { serviceIds: new Set(['WK']) });
    const a = out.find((s) => s.stopId === 'a')!;
    expect(a.tripsPerDay).toBe(2);
    expect(a.routeCount).toBe(1);
    // sum of trips/day across stops = stops-per-trip × trips on the day = 2 × 2.
    expect(out.reduce((s, x) => s + x.tripsPerDay, 0)).toBe(4);
  });
});

describe('computeAccessibilityAudit', () => {
  it('reports 70% when 7 of 10 board points are populated', () => {
    const stops = Array.from({ length: 10 }, (_, i) =>
      stop(`s${i}`, 40 + i * 0.001, -100, { wheelchair_boarding: i < 7 ? 1 : 0 }),
    );
    const r = computeAccessibilityAudit(feed({ stops }));
    expect(r.totalStops).toBe(10);
    expect(r.populatedCount).toBe(7);
    expect(r.gapCount).toBe(3);
    expect(Math.round(r.pctPopulated)).toBe(70);
  });

  it('ignores stations / non-board points', () => {
    const stops = [
      stop('platform', 40, -100, { wheelchair_boarding: 1 }),
      stop('station', 40.01, -100, { location_type: 1, wheelchair_boarding: 0 }),
    ];
    const r = computeAccessibilityAudit(feed({ stops }));
    expect(r.totalStops).toBe(1);        // station excluded
    expect(r.pctPopulated).toBe(100);
  });
});
