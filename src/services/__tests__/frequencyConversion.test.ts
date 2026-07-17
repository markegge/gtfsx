import { describe, it, expect } from 'vitest';
import { computeFrequencyConversion, type ConversionInput } from '../frequencyConversion';
import type { Frequency, Route, StopTime, Trip } from '../../types/gtfs';

const route = (id: string, short: string): Route => ({
  route_id: id, agency_id: 'A', route_short_name: short, route_long_name: `${short} Line`,
  route_type: 3, route_color: 'FFFFFF', route_text_color: '000000',
});
const trip = (id: string, over: Partial<Trip> = {}): Trip => ({
  trip_id: id, route_id: 'R1', service_id: 'wk', direction_id: 0, ...over,
});
const st = (tripId: string, seq: number, hms: string, over: Partial<StopTime> = {}): StopTime => ({
  trip_id: tripId, stop_id: `s${seq}`, stop_sequence: seq, arrival_time: hms, departure_time: hms, ...over,
});
const freq = (tripId: string, start: string, end: string, headway: number, exact: 0 | 1 = 0): Frequency =>
  ({ trip_id: tripId, start_time: start, end_time: end, headway_secs: headway, exact_times: exact });

// A template FQ departing 06:00, next stop +10 min, on route "Blue".
const baseInput = (over: Partial<ConversionInput> = {}): ConversionInput => ({
  templateTripIds: ['FQ'],
  trips: [trip('FQ')],
  stopTimes: [st('FQ', 1, '06:00:00'), st('FQ', 2, '06:10:00')],
  frequencies: [freq('FQ', '06:00:00', '07:00:00', 1800)], // 06:00, 06:30 (06:00 is the template)
  routes: [route('R1', 'Blue')],
  ...over,
});

describe('computeFrequencyConversion', () => {
  it('converts a single window: the template stays, each other departure becomes a real trip', () => {
    const r = computeFrequencyConversion(baseInput());
    // 06:00 (template) + 06:30 → 1 new trip, 2 total.
    expect(r.newTrips).toHaveLength(1);
    expect(r.perTemplate[0]).toMatchObject({ templateTripId: 'FQ', newTripCount: 1, totalTripCount: 2 });
    expect(r.totalNewTrips).toBe(1);
    expect(r.totalResultTrips).toBe(2);
    expect(r.removedTemplateIds).toEqual(['FQ']);
  });

  it('shifts the template stop_times onto each new trip and reassigns their trip_id', () => {
    const r = computeFrequencyConversion(baseInput());
    const newId = r.newTrips[0].trip_id;
    const times = r.newStopTimes.filter((s) => s.trip_id === newId);
    expect(times.map((s) => s.departure_time)).toEqual(['06:30:00', '06:40:00']);
    // stop_id / stop_sequence carried over from the template.
    expect(times.map((s) => s.stop_sequence)).toEqual([1, 2]);
    expect(times.every((s) => s.trip_id === newId)).toBe(true);
  });

  it('carries route/service/direction/headsign over but drops trip_short_name and block_id', () => {
    const r = computeFrequencyConversion(baseInput({
      trips: [trip('FQ', { trip_short_name: '100', trip_headsign: 'Downtown', direction_id: 1, shape_id: 'shp1', block_id: 'blk9' })],
    }));
    const t = r.newTrips[0];
    expect(t).toMatchObject({ route_id: 'R1', service_id: 'wk', direction_id: 1, shape_id: 'shp1', trip_headsign: 'Downtown' });
    // A frequency template has no single vehicle — new trips start unassigned.
    expect(t.trip_short_name).toBeUndefined();
    expect(t.block_id).toBeUndefined();
  });

  it('expands multiple windows', () => {
    const r = computeFrequencyConversion(baseInput({
      frequencies: [
        freq('FQ', '06:00:00', '07:00:00', 1800), // 06:00 (template), 06:30 → 1 new
        freq('FQ', '16:00:00', '16:31:00', 900),  // 16:00, 16:15, 16:30 → 3 new
      ],
    }));
    expect(r.newTrips).toHaveLength(4);
    expect(r.perTemplate[0].totalTripCount).toBe(5);
  });

  it('handles an off-grid template: every grid slot is new and the template stays at its own time', () => {
    // Template departs 06:10, window grid is 06:00 / 06:30 — neither coincides,
    // so BOTH become new trips and the 06:10 template remains as a real trip.
    const r = computeFrequencyConversion(baseInput({
      stopTimes: [st('FQ', 1, '06:10:00'), st('FQ', 2, '06:20:00')],
    }));
    expect(r.newTrips).toHaveLength(2);
    expect(r.perTemplate[0].totalTripCount).toBe(3);
    const starts = r.newTrips
      .map((t) => r.newStopTimes.find((s) => s.trip_id === t.trip_id && s.stop_sequence === 1)!.departure_time)
      .sort();
    expect(starts).toEqual(['06:00:00', '06:30:00']);
  });

  it('flags approximate (exact_times ≠ 1) and not exact windows', () => {
    expect(computeFrequencyConversion(baseInput()).anyApproximate).toBe(true);          // default 0
    expect(computeFrequencyConversion(baseInput({
      frequencies: [freq('FQ', '06:00:00', '07:00:00', 1800, 1)],
    })).anyApproximate).toBe(false);                                                     // exact
    expect(computeFrequencyConversion(baseInput({
      frequencies: [freq('FQ', '06:00:00', '07:00:00', 1800, 1), freq('FQ', '16:00:00', '17:00:00', 1800, 0)],
    })).anyApproximate).toBe(true);                                                      // one approximate
  });

  it('mints pithy ids past the highest existing Blue-N (never renaming existing trips)', () => {
    const r = computeFrequencyConversion(baseInput({
      trips: [trip('FQ'), trip('Blue-1'), trip('Blue-2')],
      frequencies: [freq('FQ', '06:00:00', '08:00:00', 1800)], // 06:00 (template), 06:30, 07:00, 07:30 → 3 new
    }));
    expect(r.newTrips.map((t) => t.trip_id)).toEqual(['Blue-3', 'Blue-4', 'Blue-5']);
  });

  it('converts multiple templates without id collisions', () => {
    const r = computeFrequencyConversion({
      templateTripIds: ['FQ1', 'FQ2'],
      trips: [trip('FQ1'), trip('FQ2')],
      stopTimes: [
        st('FQ1', 1, '06:00:00'), st('FQ1', 2, '06:10:00'),
        st('FQ2', 1, '09:00:00'), st('FQ2', 2, '09:10:00'),
      ],
      frequencies: [
        freq('FQ1', '06:00:00', '07:00:00', 1800), // 1 new
        freq('FQ2', '09:00:00', '10:00:00', 1800), // 1 new
      ],
      routes: [route('R1', 'Blue')],
    });
    expect(r.removedTemplateIds).toEqual(['FQ1', 'FQ2']);
    const ids = r.newTrips.map((t) => t.trip_id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it('silently skips ids with no frequency windows or no trip row', () => {
    const r = computeFrequencyConversion(baseInput({ templateTripIds: ['FQ', 'plain', 'ghost'],
      trips: [trip('FQ'), trip('plain')] })); // 'plain' has no freq; 'ghost' has no trip row
    expect(r.removedTemplateIds).toEqual(['FQ']);
    expect(r.perTemplate).toHaveLength(1);
  });

  it('de-dupes repeated template ids', () => {
    const r = computeFrequencyConversion(baseInput({ templateTripIds: ['FQ', 'FQ'] }));
    expect(r.removedTemplateIds).toEqual(['FQ']);
    expect(r.newTrips).toHaveLength(1);
  });
});
