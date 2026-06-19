// E1 — feed-state diff. Pure; builds tiny hand-checkable fixtures.
import { describe, expect, it } from 'vitest';
import { diffFeedState, type FeedState } from '../feedDiff';
import type { Route, Trip, StopTime, Calendar } from '../../types/gtfs';

const weekday: Calendar = {
  service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
} as Calendar;

function route(id: string): Route {
  return { route_id: id, route_short_name: id, route_long_name: id, route_type: 3 } as Route;
}

/** A trip from 08:00 for `runMin` minutes over two stops. */
function tripWithTimes(id: string, routeId: string, startH: number, runMin = 30): { trip: Trip; times: StopTime[] } {
  const hh = String(startH).padStart(2, '0');
  const endMin = runMin % 60;
  const endH = startH + Math.floor(runMin / 60);
  const trip: Trip = { trip_id: id, route_id: routeId, service_id: 'wk', direction_id: 0 } as Trip;
  const times: StopTime[] = [
    { trip_id: id, stop_id: 's1', stop_sequence: 1, arrival_time: `${hh}:00:00`, departure_time: `${hh}:00:00` },
    { trip_id: id, stop_id: 's2', stop_sequence: 2, arrival_time: `${String(endH).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00`, departure_time: `${String(endH).padStart(2, '0')}:${String(endMin).padStart(2, '0')}:00` },
  ];
  return { trip, times };
}

function feed(routes: Route[], tt: { trip: Trip; times: StopTime[] }[]): FeedState {
  return {
    routes,
    routeStops: routes.flatMap((r) => [
      { route_id: r.route_id, stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false },
      { route_id: r.route_id, stop_id: 's2', direction_id: 0, stop_sequence: 2, _snapped: false },
    ]),
    trips: tt.map((x) => x.trip),
    stopTimes: tt.flatMap((x) => x.times),
    stops: [
      { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never,
      { stop_id: 's2', stop_name: 'B', stop_lat: 45.05, stop_lon: -111, wheelchair_boarding: 0 } as never,
    ],
    calendars: [weekday],
    calendarDates: [],
    frequencies: [],
  };
}

const A = feed([route('R1')], [tripWithTimes('t1', 'R1', 8), tripWithTimes('t2', 'R1', 9)]);

describe('diffFeedState', () => {
  it('diff(a, a) is empty and flagged identical', () => {
    const d = diffFeedState(A, A);
    expect(d.identical).toBe(true);
    expect(d.trips.delta).toBe(0);
    expect(d.routes.added + d.routes.removed + d.routes.changed).toBe(0);
    expect(d.kpi.delta.tripsPerWeek).toBe(0);
    expect(d.routeChanges).toHaveLength(0);
  });

  it('adding a route + trips reports it as added with positive deltas', () => {
    const B = feed([route('R1'), route('R2')], [
      tripWithTimes('t1', 'R1', 8), tripWithTimes('t2', 'R1', 9),
      tripWithTimes('t3', 'R2', 8),
    ]);
    const d = diffFeedState(A, B);
    expect(d.identical).toBe(false);
    expect(d.routes.added).toBe(1);
    expect(d.routes.addedIds).toContain('R2');
    expect(d.trips.delta).toBe(1);
    expect(d.kpi.delta.tripsPerWeek).toBeGreaterThan(0);
    expect(d.kpi.delta.revenueHoursWeekly).toBeGreaterThan(0);
    const r2 = d.routeChanges.find((c) => c.routeId === 'R2');
    expect(r2?.kind).toBe('added');
    expect(r2!.tripsPerWeekDelta).toBeGreaterThan(0);
  });

  it('removing a route reports it as removed', () => {
    const B = feed([], []);
    const d = diffFeedState(A, B);
    expect(d.routes.removed).toBe(1);
    expect(d.routes.removedIds).toContain('R1');
    expect(d.trips.delta).toBe(-2);
    const r1 = d.routeChanges.find((c) => c.routeId === 'R1');
    expect(r1?.kind).toBe('removed');
    expect(r1!.tripsPerWeekDelta).toBeLessThan(0);
  });

  it('adding trips to an existing route shows a per-route changed delta', () => {
    const B = feed([route('R1')], [
      tripWithTimes('t1', 'R1', 8), tripWithTimes('t2', 'R1', 9), tripWithTimes('t3', 'R1', 10),
    ]);
    const d = diffFeedState(A, B);
    expect(d.routes.changed).toBe(0); // route metadata unchanged
    expect(d.trips.delta).toBe(1);
    const r1 = d.routeChanges.find((c) => c.routeId === 'R1');
    expect(r1?.kind).toBe('changed');
    // one more weekday trip → +5 trips/week (Mon–Fri)
    expect(r1!.tripsPerWeekDelta).toBe(5);
  });

  it('detects an added frequency window', () => {
    const B: FeedState = { ...A, frequencies: [{ trip_id: 't1', start_time: '08:00:00', end_time: '10:00:00', headway_secs: 1800 }] };
    const d = diffFeedState(A, B);
    expect(d.frequencies.added).toBe(1);
    expect(d.identical).toBe(false);
  });

  it('headline deltas equal the difference of the two system stats', () => {
    const B = feed([route('R1'), route('R2')], [
      tripWithTimes('t1', 'R1', 8), tripWithTimes('t2', 'R1', 9), tripWithTimes('t3', 'R2', 8),
    ]);
    const d = diffFeedState(A, B);
    expect(d.kpi.delta.annualCost).toBeCloseTo(d.kpi.b.totalAnnualCost - d.kpi.a.totalAnnualCost, 6);
    expect(d.kpi.delta.tripsPerWeek).toBe(d.kpi.b.totalTripsPerWeek - d.kpi.a.totalTripsPerWeek);
  });
});
