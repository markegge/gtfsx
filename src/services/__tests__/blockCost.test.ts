// B3 — block-derived cost + no-block flat-factor fallback (regression guard).
import { describe, expect, it } from 'vitest';
import { calculateBlockCost, calculateSystemStats } from '../costEstimation';
import type { Trip, StopTime, Stop, Route, Calendar } from '../../types/gtfs';

const STOPS: Stop[] = [
  { stop_id: 's1', stop_name: 's1', stop_lat: 45.0, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
  { stop_id: 's2', stop_name: 's2', stop_lat: 45.01, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
];
const CAL: Calendar = {
  service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
  start_date: '20260101', end_date: '20261231',
} as Calendar;

function mkTrip(id: string, block: string | undefined, sH: string, eH: string): { trip: Trip; times: StopTime[] } {
  return {
    trip: { trip_id: id, route_id: 'R1', service_id: 'wk', direction_id: 0, block_id: block } as Trip,
    times: [
      { trip_id: id, stop_id: 's1', stop_sequence: 1, arrival_time: `${sH}:00`, departure_time: `${sH}:00` },
      { trip_id: id, stop_id: 's2', stop_sequence: 2, arrival_time: `${eH}:00`, departure_time: `${eH}:00` },
    ],
  };
}

// Two blocks: B1 = A(08:00-08:30)+B(09:00-09:30); B2 = C(08:15-08:45).
const BLOCKED = [mkTrip('A', 'B1', '08:00', '08:30'), mkTrip('B', 'B1', '09:00', '09:30'), mkTrip('C', 'B2', '08:15', '08:45')];
const UNBLOCKED = BLOCKED.map((x) => ({ ...x, trip: { ...x.trip, block_id: undefined } }));

function state(items: typeof BLOCKED) {
  return {
    trips: items.map((i) => i.trip),
    stopTimes: items.flatMap((i) => i.times),
    stops: STOPS,
    calendars: [CAL],
    calendarDates: [],
  };
}

const opts = { costPerHour: 100, costLayover: true, costDeadhead: true, deadheadSpeedMph: 25 };

describe('calculateBlockCost', () => {
  it('derives service / layover / deadhead hours from block geometry', () => {
    const r = calculateBlockCost(state(BLOCKED), opts);
    expect(r.hasBlocks).toBe(true);
    const wk = r.perService.find((s) => s.serviceId === 'wk')!;
    expect(wk.serviceHours).toBeCloseTo(1.5, 5);   // 3 × 30 min
    expect(wk.vehicles).toBe(2);                    // B1, B2
    expect(wk.layoverHours).toBeGreaterThan(0);     // the 30-min gap in B1
    expect(wk.deadheadHours).toBeGreaterThan(0);    // s2 → s1 reposition in B1
    expect(r.maxVehicles).toBe(2);
  });

  it('layover/deadhead toggles change the total as expected', () => {
    const withAll = calculateBlockCost(state(BLOCKED), opts);
    const noLayover = calculateBlockCost(state(BLOCKED), { ...opts, costLayover: false });
    const wkA = withAll.perService[0];
    const wkN = noLayover.perService[0];
    // Dropping layover from the cost reduces the daily cost by layoverHours × rate.
    expect(wkA.dailyCost - wkN.dailyCost).toBeCloseTo(wkA.layoverHours * opts.costPerHour, 4);
  });

  it('with no blocks, falls back to the flat-factor cost (matches calculateSystemStats)', () => {
    const s = state(UNBLOCKED);
    const block = calculateBlockCost(s, { ...opts, deadheadFactor: 1.2 });
    expect(block.hasBlocks).toBe(false);
    for (const svc of block.perService) {
      expect(svc.layoverHours).toBe(0);
      expect(svc.deadheadHours).toBe(0);
    }
    // Same numbers as the existing flat-factor system cost.
    const sys = calculateSystemStats(
      { ...s, routes: [{ route_id: 'R1', route_short_name: 'R1', route_long_name: 'R1', route_type: 3 } as Route] },
      100, 1.2,
    );
    expect(block.weeklyCost).toBeCloseTo(sys.totalWeeklyCost, 2);
    expect(block.annualCost).toBeCloseTo(sys.totalAnnualCost, 2);
  });
});
