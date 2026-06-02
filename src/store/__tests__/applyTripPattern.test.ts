// applyTripPattern pushes a template trip's stop sequence + relative timing to
// sibling trips while preserving each sibling's own start time. See tripSlice.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

beforeEach(() => {
  const s = useStore.getState();
  s.setTrips([]);
  s.setStopTimes([]);
});

describe('applyTripPattern', () => {
  it('re-lays siblings to the template (incl. an added stop), keeping each start time', () => {
    const s = useStore.getState();
    s.setTrips([
      { trip_id: 'A', route_id: 'r', service_id: 'svc', direction_id: 0 },
      { trip_id: 'B', route_id: 'r', service_id: 'svc', direction_id: 0 },
    ] as never);
    s.setStopTimes([
      // Template A — edited to 3 stops (s2 inserted), 5 min apart from 08:00.
      { trip_id: 'A', stop_id: 's1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
      { trip_id: 'A', stop_id: 's2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' },
      { trip_id: 'A', stop_id: 's3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
      // Sibling B — old 2-stop pattern, departs 08:30.
      { trip_id: 'B', stop_id: 's1', stop_sequence: 1, arrival_time: '08:30:00', departure_time: '08:30:00' },
      { trip_id: 'B', stop_id: 's3', stop_sequence: 2, arrival_time: '08:40:00', departure_time: '08:40:00' },
    ] as never);

    useStore.getState().applyTripPattern('A', ['B']);

    const bTimes = useStore.getState().stopTimes
      .filter((st) => st.trip_id === 'B')
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    // B picks up A's full stop sequence (the inserted s2)...
    expect(bTimes.map((st) => st.stop_id)).toEqual(['s1', 's2', 's3']);
    // ...with A's relative timing, shifted to keep B's 08:30 start.
    expect(bTimes.map((st) => st.arrival_time)).toEqual(['08:30:00', '08:35:00', '08:40:00']);

    // Template A is untouched.
    const aTimes = useStore.getState().stopTimes.filter((st) => st.trip_id === 'A');
    expect(aTimes.length).toBe(3);
    expect(aTimes.find((st) => st.stop_id === 's1')!.arrival_time).toBe('08:00:00');
  });

  it('is a no-op for an empty target list', () => {
    const s = useStore.getState();
    s.setTrips([{ trip_id: 'A', route_id: 'r', service_id: 'svc', direction_id: 0 }] as never);
    s.setStopTimes([
      { trip_id: 'A', stop_id: 's1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    ] as never);
    useStore.getState().applyTripPattern('A', []);
    expect(useStore.getState().stopTimes.length).toBe(1);
  });
});
