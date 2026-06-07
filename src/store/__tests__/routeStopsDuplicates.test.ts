// A pattern may legally list the same stop_id more than once (a loop whose
// first and last stop are identical). The editor keys route_stops by a
// synthetic per-instance _uid so duplicates are individually addressable:
// add twice, remove one by _uid, reorder a list with a duplicate, and verify a
// trip generates two stop_times for the repeated stop at distinct sequences.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

beforeEach(() => {
  const s = useStore.getState();
  s.setRoutes([]);
  s.setRouteStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
});

const loopStops = () =>
  useStore.getState().routeStops
    .filter((rs) => rs.route_id === 'LOOP')
    .sort((a, b) => a.stop_sequence - b.stop_sequence);

function seedLoop() {
  const s = useStore.getState();
  s.setRoutes([
    { route_id: 'LOOP', route_short_name: 'L', route_long_name: 'Loop', route_type: 3 },
  ] as never);
  // L1, L2, then L1 AGAIN — the loop returns to its start.
  s.addRouteStop({ route_id: 'LOOP', stop_id: 'L1', direction_id: 0, stop_sequence: 0, _snapped: false, shape_id: 'SHL' } as never);
  s.addRouteStop({ route_id: 'LOOP', stop_id: 'L2', direction_id: 0, stop_sequence: 1, _snapped: false, shape_id: 'SHL' } as never);
  s.addRouteStop({ route_id: 'LOOP', stop_id: 'L1', direction_id: 0, stop_sequence: 2, _snapped: false, shape_id: 'SHL' } as never);
}

describe('duplicate stop in a pattern', () => {
  it('addRouteStop keeps both instances of a repeated stop, each with a distinct _uid', () => {
    seedLoop();
    const rs = loopStops();
    expect(rs).toHaveLength(3);
    expect(rs.filter((r) => r.stop_id === 'L1')).toHaveLength(2);
    expect(rs.every((r) => !!r._uid)).toBe(true);
    expect(new Set(rs.map((r) => r._uid)).size).toBe(3);
  });

  it('setRouteStops backfills a _uid on instances that lack one', () => {
    useStore.getState().setRouteStops([
      { route_id: 'LOOP', stop_id: 'L1', direction_id: 0, stop_sequence: 0, _snapped: false },
      { route_id: 'LOOP', stop_id: 'L1', direction_id: 0, stop_sequence: 1, _snapped: false },
    ] as never);
    const rs = loopStops();
    expect(rs.every((r) => !!r._uid)).toBe(true);
    expect(rs[0]._uid).not.toBe(rs[1]._uid);
  });

  it('removeRouteStop removes a single instance by _uid; the other survives', () => {
    seedLoop();
    // Remove the SECOND L1 (sequence 2).
    const second = loopStops().find((r) => r.stop_id === 'L1' && r.stop_sequence === 2)!;
    useStore.getState().removeRouteStop('LOOP', second._uid!);
    const rs = loopStops();
    expect(rs).toHaveLength(2);
    expect(rs.filter((r) => r.stop_id === 'L1')).toHaveLength(1);
    expect(rs.map((r) => r.stop_id)).toEqual(['L1', 'L2']);
  });

  it('reorderRouteStops reorders by _uid, keeping the duplicate, and remaps stop_times', () => {
    seedLoop();
    const s = useStore.getState();
    s.addTrip({ trip_id: 'LT', route_id: 'LOOP', service_id: 'SVC', direction_id: 0, shape_id: 'SHL' } as never);
    for (const r of loopStops()) {
      s.setStopTime('LT', r.stop_id, r.stop_sequence, {
        arrival_time: `08:0${r.stop_sequence}:00`, departure_time: `08:0${r.stop_sequence}:00`,
      });
    }
    const before = loopStops(); // [L1@0, L2@1, L1@2]
    // Move the trailing L1 to the front: uids order [2, 0, 1].
    useStore.getState().reorderRouteStops('LOOP', 0, [before[2]._uid!, before[0]._uid!, before[1]._uid!], 'SHL');
    const after = loopStops();
    expect(after).toHaveLength(3);
    expect(after.filter((r) => r.stop_id === 'L1')).toHaveLength(2);
    expect(after.map((r) => r.stop_sequence)).toEqual([0, 1, 2]);
    // The moved instance (08:02) is now first; its stop_time followed it.
    const movedNow = after.find((r) => r._uid === before[2]._uid)!;
    expect(movedNow.stop_sequence).toBe(0);
    const st0 = useStore.getState().stopTimes.find((st) => st.trip_id === 'LT' && st.stop_sequence === 0);
    expect(st0?.arrival_time).toBe('08:02:00');
  });

  it('setStopTime keys by stop_sequence, so a repeated stop yields two distinct stop_times', () => {
    seedLoop();
    const s = useStore.getState();
    s.addTrip({ trip_id: 'LT', route_id: 'LOOP', service_id: 'SVC', direction_id: 0, shape_id: 'SHL' } as never);
    for (const r of loopStops()) {
      s.setStopTime('LT', r.stop_id, r.stop_sequence, {
        arrival_time: `08:1${r.stop_sequence}:00`, departure_time: `08:1${r.stop_sequence}:00`,
      });
    }
    const times = useStore.getState().stopTimes
      .filter((st) => st.trip_id === 'LT')
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    expect(times).toHaveLength(3);
    expect(times.map((st) => st.stop_id)).toEqual(['L1', 'L2', 'L1']);
    const l1Times = times.filter((st) => st.stop_id === 'L1');
    // The two L1 cells are independent rows at different stop_sequence values.
    expect(l1Times[0].stop_sequence).not.toBe(l1Times[1].stop_sequence);
    expect(l1Times[0].arrival_time).not.toBe(l1Times[1].arrival_time);
  });

  it('duplicateRoute gives the copy fresh _uids (independent of the original)', () => {
    seedLoop();
    const newId = useStore.getState().duplicateRoute('LOOP');
    expect(newId).toBeTruthy();
    const origUids = new Set(loopStops().map((r) => r._uid));
    const copyUids = useStore.getState().routeStops
      .filter((r) => r.route_id === newId)
      .map((r) => r._uid);
    expect(copyUids).toHaveLength(3);
    expect(copyUids.every((u) => !!u && !origUids.has(u))).toBe(true);
  });
});
