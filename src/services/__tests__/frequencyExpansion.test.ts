import { describe, it, expect } from 'vitest';
import { expandFrequencyTrip, templateStartSec, windowDepartureCount, type FrequencyWindow } from '../frequencyExpansion';
import type { StopTime } from '../../types/gtfs';

const st = (seq: number, hms: string): StopTime => ({
  trip_id: 'FQ', stop_id: `s${seq}`, stop_sequence: seq, arrival_time: hms, departure_time: hms,
});

// Template: departs 06:00, second stop +10 min.
const TEMPLATE: StopTime[] = [st(0, '06:00:00'), st(1, '06:10:00')];

describe('templateStartSec', () => {
  it('is the earliest set time across the trip', () => {
    expect(templateStartSec(TEMPLATE)).toBe(6 * 3600);
  });
  it('is null when the trip has no times', () => {
    expect(templateStartSec([st(0, ''), st(1, '')])).toBeNull();
  });
});

describe('windowDepartureCount', () => {
  it('counts start+k*headway < end (end exclusive)', () => {
    // 06:00–07:00 every 30 min → 06:00, 06:30 = 2.
    expect(windowDepartureCount([{ start_time: '06:00:00', end_time: '07:00:00', headway_secs: 1800 }])).toBe(2);
    // 06:00–22:00 every 30 min → 32.
    expect(windowDepartureCount([{ start_time: '06:00:00', end_time: '22:00:00', headway_secs: 1800 }])).toBe(32);
  });
  it('sums across multiple windows', () => {
    expect(windowDepartureCount([
      { start_time: '06:00:00', end_time: '07:00:00', headway_secs: 1800 },
      { start_time: '16:00:00', end_time: '17:00:00', headway_secs: 900 },
    ])).toBe(2 + 4);
  });
  it('ignores a zero/negative headway or empty window', () => {
    expect(windowDepartureCount([{ start_time: '06:00:00', end_time: '07:00:00', headway_secs: 0 }])).toBe(0);
    expect(windowDepartureCount([{ start_time: '07:00:00', end_time: '06:00:00', headway_secs: 900 }])).toBe(0);
  });
});

describe('expandFrequencyTrip', () => {
  const window1h: FrequencyWindow = { start_time: '06:00:00', end_time: '07:00:00', headway_secs: 1800 };

  it('projects every window departure except the one coinciding with the template', () => {
    const v = expandFrequencyTrip('FQ', TEMPLATE, [window1h]);
    // 06:00 (template, skipped) + 06:30 → one projection at 06:30.
    expect(v).toHaveLength(1);
    expect(v[0].departureSec).toBe(6 * 3600 + 1800);
  });

  it('shifts the template stop_times onto each projection (durations preserved)', () => {
    const v = expandFrequencyTrip('FQ', TEMPLATE, [window1h]);
    expect(v[0].stopTimes.map((s) => s.departure_time)).toEqual(['06:30:00', '06:40:00']);
  });

  it('expands multiple windows and sorts by departure', () => {
    const v = expandFrequencyTrip('FQ', TEMPLATE, [
      { start_time: '06:00:00', end_time: '07:00:00', headway_secs: 1800 }, // 06:30 (06:00 skipped)
      { start_time: '16:00:00', end_time: '16:31:00', headway_secs: 900 },  // 16:00, 16:15, 16:30
    ]);
    expect(v.map((x) => x.departureSec)).toEqual([
      6 * 3600 + 1800,        // 06:30
      16 * 3600,              // 16:00
      16 * 3600 + 900,        // 16:15
      16 * 3600 + 1800,       // 16:30
    ]);
  });

  it('carries exact_times through (default 0)', () => {
    const exact = expandFrequencyTrip('FQ', TEMPLATE, [{ ...window1h, exact_times: 1 }]);
    expect(exact[0].exactTimes).toBe(1);
    const approx = expandFrequencyTrip('FQ', TEMPLATE, [window1h]);
    expect(approx[0].exactTimes).toBe(0);
  });

  it('returns nothing for an untimed template', () => {
    expect(expandFrequencyTrip('FQ', [st(0, ''), st(1, '')], [window1h])).toEqual([]);
  });

  it('gives each projection a unique, stable key', () => {
    const v = expandFrequencyTrip('FQ', TEMPLATE, [{ start_time: '06:00:00', end_time: '08:00:00', headway_secs: 1800 }]);
    const keys = v.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
