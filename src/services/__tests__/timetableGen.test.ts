// B1 timetable generation — pure generator + a store→export round-trip.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { generateTrips, validateGenerateParams, estimateRunSecs, type GenerateTripsParams } from '../timetableGen';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
import type { RouteStop } from '../../types/gtfs';

const PATTERN: RouteStop[] = [
  { route_id: 'R', stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false },
  { route_id: 'R', stop_id: 's2', direction_id: 0, stop_sequence: 2, _snapped: false },
  { route_id: 'R', stop_id: 's3', direction_id: 0, stop_sequence: 3, _snapped: false },
];

const base: GenerateTripsParams = {
  routeId: 'R',
  directionId: 0,
  serviceId: 'weekday',
  startTime: '06:00',
  endTime: '09:00',
  headwaySecs: 1800,
  runSecs: 1200, // 20 min first→last
  mode: 'explicit',
  routeStops: PATTERN,
  headsign: 'Downtown',
};

describe('generateTrips — explicit mode', () => {
  it('06:00–09:00 @30m makes 7 trips at the right departures', () => {
    const { trips, stopTimes } = generateTrips(base);
    expect(trips).toHaveLength(7);
    const firstDepartures = trips.map((t) => {
      const first = stopTimes
        .filter((st) => st.trip_id === t.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence)[0];
      return first.departure_time;
    });
    expect(firstDepartures).toEqual([
      '06:00:00', '06:30:00', '07:00:00', '07:30:00', '08:00:00', '08:30:00', '09:00:00',
    ]);
  });

  it('interpolates the run time across intermediate stops (first=start, last=start+run)', () => {
    const { stopTimes } = generateTrips(base);
    const t0 = stopTimes
      .filter((st) => st.trip_id === generateTrips(base).trips[0].trip_id)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    // Even spacing: 3 stops, 20 min run → 0, 10, 20 from 06:00.
    expect(t0.map((st) => st.arrival_time)).toEqual(['06:00:00', '06:10:00', '06:20:00']);
    // Endpoints timed, middle interpolated.
    expect(t0.map((st) => st.timepoint)).toEqual([1, 0, 1]);
  });

  it('produces deterministic, collision-free trip ids', () => {
    const a = generateTrips(base).trips.map((t) => t.trip_id);
    const b = generateTrips(base).trips.map((t) => t.trip_id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(a[0]).toBe('R-d0-weekday-0600');
  });

  it('carries headsign, route, service, direction, shape onto each trip', () => {
    const { trips } = generateTrips({ ...base, shapeId: 'shp1' });
    for (const t of trips) {
      expect(t).toMatchObject({ route_id: 'R', service_id: 'weekday', direction_id: 0, trip_headsign: 'Downtown', shape_id: 'shp1' });
    }
  });
});

describe('generateTrips — frequency mode', () => {
  it('writes ONE reference trip + one frequencies window', () => {
    const { trips, stopTimes, frequencies } = generateTrips({ ...base, mode: 'frequency' });
    expect(trips).toHaveLength(1);
    expect(stopTimes.filter((st) => st.trip_id === trips[0].trip_id)).toHaveLength(3);
    expect(frequencies).toHaveLength(1);
    expect(frequencies[0]).toMatchObject({
      trip_id: trips[0].trip_id,
      start_time: '06:00:00',
      // half-open window ends one headway past the last departure.
      end_time: '09:30:00',
      headway_secs: 1800,
    });
  });
});

describe('validateGenerateParams', () => {
  it('rejects bad headway, reversed window, non-positive run, too-few stops', () => {
    expect(validateGenerateParams({ ...base, headwaySecs: 0 }).ok).toBe(false);
    expect(validateGenerateParams({ ...base, startTime: '09:00', endTime: '06:00' }).ok).toBe(false);
    expect(validateGenerateParams({ ...base, runSecs: 0 }).ok).toBe(false);
    expect(validateGenerateParams({ ...base, routeStops: [PATTERN[0]] }).ok).toBe(false);
  });
  it('counts trips for a valid window', () => {
    expect(validateGenerateParams(base)).toMatchObject({ ok: true, tripCount: 7 });
  });
});

describe('estimateRunSecs', () => {
  it('derives a run time from straight-line stop distance when no shape', () => {
    const stops = [
      { stop_id: 's1', stop_lat: 45.0, stop_lon: -111.0 } as never,
      { stop_id: 's3', stop_lat: 45.05, stop_lon: -111.0 } as never,
    ];
    const secs = estimateRunSecs({ routeStops: [PATTERN[0], PATTERN[2]], stops, avgSpeedMph: 20 });
    // ~5.5 km at 20 mph ≈ 10-11 min; just assert it's a sane positive number.
    expect(secs).toBeGreaterThan(300);
    expect(secs).toBeLessThan(2000);
  });
});

describe('round-trips through exportGtfsZip', () => {
  beforeEach(() => {
    const s = useStore.getState();
    s.setTrips([]);
    s.setStopTimes([]);
    s.setFrequencies([]);
  });

  it('generated explicit trips export to trips.txt / stop_times.txt with matching counts', async () => {
    const gen = generateTrips(base);
    const s = useStore.getState();
    s.setTrips(gen.trips as never);
    s.setStopTimes(gen.stopTimes as never);

    const blob = await exportGtfsZip();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const tripsCsv = await zip.file('trips.txt')!.async('string');
    const stCsv = await zip.file('stop_times.txt')!.async('string');

    // header + 7 trip rows
    const tripRows = tripsCsv.trim().split('\n').length - 1;
    expect(tripRows).toBe(7);
    // header + 7 trips × 3 stops
    const stRows = stCsv.trim().split('\n').length - 1;
    expect(stRows).toBe(21);
    // a known departure survives the round-trip
    expect(stCsv).toContain('06:00:00');
    expect(tripsCsv).toContain('R-d0-weekday-0600');
  });
});
