// Store-level check for the frequency→trips converter (issue #65): applying a
// computed conversion appends the materialized trips + stop_times and drops the
// template's frequencies in one commit, and the timetable snapshot-Undo pattern
// ({trips, stopTimes, frequencies} → restore wholesale) round-trips it exactly.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { computeFrequencyConversion } from '../../services/frequencyConversion';
import type { Frequency, StopTime, Trip } from '../../types/gtfs';

beforeEach(() => {
  const s = useStore.getState();
  s.setRoutes([{ route_id: 'R1', agency_id: 'A', route_short_name: 'Blue', route_long_name: 'Blue Line', route_type: 3, route_color: 'FFFFFF', route_text_color: '000000' } as never]);
  s.setTrips([{ trip_id: 'FQ', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
  s.setStopTimes([
    { trip_id: 'FQ', stop_id: 's1', stop_sequence: 1, arrival_time: '06:00:00', departure_time: '06:00:00' },
    { trip_id: 'FQ', stop_id: 's2', stop_sequence: 2, arrival_time: '06:10:00', departure_time: '06:10:00' },
  ] as StopTime[]);
  s.setFrequencies([{ trip_id: 'FQ', start_time: '06:00:00', end_time: '08:00:00', headway_secs: 1800 }] as Frequency[]);
});

describe('applyFrequencyConversion + snapshot undo', () => {
  it('materializes the build-out and drops the template frequency, then restores wholesale on undo', () => {
    const s = useStore.getState();
    // Snapshot BEFORE (references are safe: immer replaces arrays immutably).
    const snapTrips = s.trips, snapStops = s.stopTimes, snapFreqs = s.frequencies;

    const result = computeFrequencyConversion({
      templateTripIds: ['FQ'], trips: s.trips, stopTimes: s.stopTimes, frequencies: s.frequencies, routes: s.routes,
    });
    // 06:00 (template), 06:30, 07:00, 07:30 → 3 new trips.
    expect(result.newTrips).toHaveLength(3);

    s.applyFrequencyConversion(result);

    const after = useStore.getState();
    expect(after.trips).toHaveLength(4);                     // template + 3 new
    expect(after.trips.some((t) => t.trip_id === 'FQ')).toBe(true); // template stays
    expect(after.frequencies).toHaveLength(0);              // freq rows removed
    // The three new trips each carry a full set of stop_times.
    expect(after.stopTimes).toHaveLength(8);                // 4 trips × 2 stops

    // Undo — restore the snapshotted arrays wholesale.
    after.setTrips(snapTrips);
    after.setStopTimes(snapStops);
    after.setFrequencies(snapFreqs);

    const restored = useStore.getState();
    expect(restored.trips).toEqual(snapTrips);
    expect(restored.stopTimes).toEqual(snapStops);
    expect(restored.frequencies).toEqual(snapFreqs);
    expect(restored.trips).toHaveLength(1);
    expect(restored.frequencies).toHaveLength(1);
  });
});
