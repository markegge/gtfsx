// Pure-logic tests for the system-wide "vehicles required for peak service"
// computation: the max simultaneous vehicles in service across the whole
// system, service_id grouping, block_id handling, and frequencies.txt support.
import { describe, expect, it } from 'vitest';
import {
  calculateSystemPeakVehicles,
  calculateSystemStats,
  calculateRouteSpans,
} from '../costEstimation';
import { secondsToGtfsTime } from '../../utils/time';
import type { Calendar, Frequency, Route, StopTime, Trip } from '../../types/gtfs';

// --- fixture factories -------------------------------------------------------

function route(id: string): Route {
  return {
    route_id: id,
    agency_id: 'a1',
    route_short_name: id,
    route_long_name: id,
    route_type: 3,
    route_color: 'ffffff',
    route_text_color: '000000',
  };
}

function weekdayCal(serviceId: string): Calendar {
  return {
    service_id: serviceId,
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
    start_date: '20260101', end_date: '20261231',
  };
}

/** A trip plus its two bracketing stop_times defining an in-service span. */
function makeTrip(
  tripId: string,
  routeId: string,
  serviceId: string,
  startSec: number,
  endSec: number,
  blockId?: string,
): { trip: Trip; stopTimes: StopTime[] } {
  const trip: Trip = { trip_id: tripId, route_id: routeId, service_id: serviceId, direction_id: 0 };
  if (blockId) trip.block_id = blockId;
  const stopTimes: StopTime[] = [
    { trip_id: tripId, arrival_time: secondsToGtfsTime(startSec), departure_time: secondsToGtfsTime(startSec), stop_id: `${tripId}-s0`, stop_sequence: 1 },
    { trip_id: tripId, arrival_time: secondsToGtfsTime(endSec), departure_time: secondsToGtfsTime(endSec), stop_id: `${tripId}-s1`, stop_sequence: 2 },
  ];
  return { trip, stopTimes };
}

const H = 3600;

function assemble(parts: { trip: Trip; stopTimes: StopTime[] }[]) {
  return {
    trips: parts.map((p) => p.trip),
    stopTimes: parts.flatMap((p) => p.stopTimes),
  };
}

// --- calculateSystemPeakVehicles --------------------------------------------

describe('calculateSystemPeakVehicles', () => {
  it('returns 0 for an empty feed', () => {
    expect(calculateSystemPeakVehicles({ trips: [], stopTimes: [] })).toBe(0);
  });

  it('two routes whose trips do NOT overlap → system peak 1, below the sum of route peaks (2)', () => {
    const parts = [
      makeTrip('a1', 'A', 'wk', 8 * H, 9 * H),   // 08:00–09:00
      makeTrip('b1', 'B', 'wk', 10 * H, 11 * H), // 10:00–11:00
    ];
    const state = assemble(parts);
    const systemPeak = calculateSystemPeakVehicles(state);
    expect(systemPeak).toBe(1);

    // Sum of per-route peaks over-counts (each route peaks at 1 → sum 2).
    const sumOfRoutePeaks =
      calculateRouteSpans('A', { ...state, routes: [route('A')], calendars: [weekdayCal('wk')], calendarDates: [] }).peakVehicles +
      calculateRouteSpans('B', { ...state, routes: [route('B')], calendars: [weekdayCal('wk')], calendarDates: [] }).peakVehicles;
    expect(sumOfRoutePeaks).toBe(2);
    expect(systemPeak).toBeLessThanOrEqual(sumOfRoutePeaks);
  });

  it('two routes whose trips overlap in time → system peak 2', () => {
    const state = assemble([
      makeTrip('a1', 'A', 'wk', 8 * H, 9 * H),        // 08:00–09:00
      makeTrip('b1', 'B', 'wk', 8 * H + 1800, 9 * H + 1800), // 08:30–09:30
    ]);
    expect(calculateSystemPeakVehicles(state)).toBe(2);
  });

  it('keeps service_ids separate: overlapping trips on different day-types do not stack', () => {
    // Both run 08:00–09:00 by the clock, but on different service_ids (weekday
    // vs Saturday) — they are never in service on the same date, so peak is 1.
    const state = assemble([
      makeTrip('wk1', 'A', 'weekday', 8 * H, 9 * H),
      makeTrip('sat1', 'A', 'saturday', 8 * H, 9 * H),
    ]);
    expect(calculateSystemPeakVehicles(state)).toBe(1);
  });

  it('does not special-case block_id: sequential trips on a block never overlap', () => {
    // Two trips chained on one block, back-to-back → still just 1 vehicle.
    const state = assemble([
      makeTrip('t1', 'A', 'wk', 8 * H, 9 * H, 'block1'),
      makeTrip('t2', 'A', 'wk', 9 * H, 10 * H, 'block1'),
    ]);
    expect(calculateSystemPeakVehicles(state)).toBe(1);
  });

  it('honors frequencies.txt: a headway trip contributes ceil(duration / headway) concurrent vehicles', () => {
    // One 30-min reference trip, run every 10 min from 08:00–09:00 →
    // ceil(1800/600) = 3 vehicles simultaneously in service.
    const { trip, stopTimes } = makeTrip('f1', 'A', 'wk', 8 * H, 8 * H + 1800);
    const frequencies: Frequency[] = [
      { trip_id: 'f1', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 },
    ];
    expect(calculateSystemPeakVehicles({ trips: [trip], stopTimes, frequencies })).toBe(3);
  });

  it('frequencies on separate routes stack into the system peak', () => {
    const a = makeTrip('fa', 'A', 'wk', 8 * H, 8 * H + 1200); // 20-min trip
    const b = makeTrip('fb', 'B', 'wk', 8 * H, 8 * H + 1200);
    const frequencies: Frequency[] = [
      { trip_id: 'fa', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 }, // ceil(1200/600)=2
      { trip_id: 'fb', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 }, // 2
    ];
    const state = { trips: [a.trip, b.trip], stopTimes: [...a.stopTimes, ...b.stopTimes], frequencies };
    expect(calculateSystemPeakVehicles(state)).toBe(4);
  });

  it('ignores invalid frequency windows and falls back to the reference run', () => {
    const { trip, stopTimes } = makeTrip('f1', 'A', 'wk', 8 * H, 9 * H);
    const frequencies: Frequency[] = [
      { trip_id: 'f1', start_time: '09:00:00', end_time: '08:00:00', headway_secs: 600 }, // empty window
      { trip_id: 'f1', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 0 },   // bad headway
    ];
    // All windows invalid → counts as the single reference vehicle.
    expect(calculateSystemPeakVehicles({ trips: [trip], stopTimes, frequencies })).toBe(1);
  });
});

// --- calculateSystemStats invariant -----------------------------------------

describe('calculateSystemStats system peak vs sum-of-peaks', () => {
  it('systemPeakVehicles ≤ totalPeakVehicles (sum), and equals the true overlap', () => {
    // Route A peaks at 2 (two overlapping morning trips); route B peaks at 1 in
    // the evening. Sum of route peaks = 3, but the true system peak = 2.
    const parts = [
      makeTrip('a1', 'A', 'wk', 8 * H, 9 * H),
      makeTrip('a2', 'A', 'wk', 8 * H + 1800, 9 * H + 1800),
      makeTrip('b1', 'B', 'wk', 18 * H, 19 * H),
    ];
    const state = {
      ...assemble(parts),
      routes: [route('A'), route('B')],
      calendars: [weekdayCal('wk')],
      calendarDates: [],
    };
    const stats = calculateSystemStats(state, 100, 1.2);
    expect(stats.totalPeakVehicles).toBe(3);     // 2 (A) + 1 (B)
    expect(stats.systemPeakVehicles).toBe(2);    // true simultaneous max
    expect(stats.systemPeakVehicles).toBeLessThanOrEqual(stats.totalPeakVehicles);
  });
});
