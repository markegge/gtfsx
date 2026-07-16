// B2 — pattern runtimes: re-time trips, keep each start (headway) intact.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { applyPatternRunTime, applyPatternEstimate, currentPatternRunSecs } from '../runtimes';
import { gtfsTimeToSeconds } from '../../utils/time';
import type { Trip, StopTime, RouteStop } from '../../types/gtfs';

const PATTERN: RouteStop[] = [
  { route_id: 'R1', stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false },
  { route_id: 'R1', stop_id: 's2', direction_id: 0, stop_sequence: 2, _snapped: false },
  { route_id: 'R1', stop_id: 's3', direction_id: 0, stop_sequence: 3, _snapped: false },
];

const toT = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:00`;

/** Three stops, 30-min run, 15-min to the mid stop, starting at startSec. */
function tripTimes(id: string, startSec: number): StopTime[] {
  return [
    { trip_id: id, stop_id: 's1', stop_sequence: 1, arrival_time: toT(startSec), departure_time: toT(startSec) },
    { trip_id: id, stop_id: 's2', stop_sequence: 2, arrival_time: toT(startSec + 900), departure_time: toT(startSec + 900) },
    { trip_id: id, stop_id: 's3', stop_sequence: 3, arrival_time: toT(startSec + 1800), departure_time: toT(startSec + 1800) },
  ];
}

beforeEach(() => {
  const s = useStore.getState();
  s.setRoutes([{ route_id: 'R1', route_short_name: 'R1', route_long_name: 'R1', route_type: 3 } as never]);
  s.setRouteStops(PATTERN as never);
  s.setShapes([]);
  s.setStops([
    { stop_id: 's1', stop_name: 's1', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never,
    { stop_id: 's2', stop_name: 's2', stop_lat: 45.01, stop_lon: -111, wheelchair_boarding: 0 } as never,
    { stop_id: 's3', stop_name: 's3', stop_lat: 45.02, stop_lon: -111, wheelchair_boarding: 0 } as never,
  ]);
  s.setTrips([
    { trip_id: 't1', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip,
    { trip_id: 't2', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip,
  ]);
  // t1 starts 08:00, t2 starts 08:30 (30-min headway).
  s.setStopTimes([...tripTimes('t1', 8 * 3600), ...tripTimes('t2', 8 * 3600 + 1800)] as StopTime[]);
});

const startOf = (id: string) =>
  useStore.getState().stopTimes.filter((s) => s.trip_id === id).sort((a, b) => a.stop_sequence - b.stop_sequence)[0].departure_time;
const endOf = (id: string) => {
  const o = useStore.getState().stopTimes.filter((s) => s.trip_id === id).sort((a, b) => a.stop_sequence - b.stop_sequence);
  return o[o.length - 1].arrival_time;
};

describe('applyPatternRunTime', () => {
  it('reports the current run time', () => {
    expect(currentPatternRunSecs({ routeId: 'R1', directionId: 0 })).toBe(1800);
  });

  it('changes the run time but preserves each start (headway intact)', () => {
    const n = applyPatternRunTime({ routeId: 'R1', directionId: 0 }, 20 * 60);
    expect(n).toBe(2);
    // starts unchanged → headway still 30 min
    expect(startOf('t1')).toBe('08:00:00');
    expect(startOf('t2')).toBe('08:30:00');
    expect(gtfsTimeToSeconds(startOf('t2')) - gtfsTimeToSeconds(startOf('t1'))).toBe(1800);
    // each now runs 20 min
    expect(endOf('t1')).toBe('08:20:00');
    expect(endOf('t2')).toBe('08:50:00');
    // intermediate stop re-interpolated (equal spacing, no shape) → +10 min
    const t1mid = useStore.getState().stopTimes.find((s) => s.trip_id === 't1' && s.stop_sequence === 2);
    expect(t1mid?.arrival_time).toBe('08:10:00');
  });
});

describe('applyPatternEstimate', () => {
  // Road profile: 300s to the mid stop, 300s more to the last (cumulative).
  const orderedStops = [{ stopId: 's1', seq: 1 }, { stopId: 's2', seq: 2 }, { stopId: 's3', seq: 3 }];
  const cum = [0, 300, 600];

  it('lays every trip from the road profile, keeping each start (headway intact)', () => {
    const n = applyPatternEstimate({ routeId: 'R1', directionId: 0 }, orderedStops, cum, { dwellSec: 60, speedFactor: 1 });
    expect(n).toBe(2);
    // starts preserved
    expect(startOf('t1')).toBe('08:00:00');
    expect(startOf('t2')).toBe('08:30:00');
    // t1: s2 arr 08:05 (+300s), dep 08:06 (+60 dwell); s3 arr 08:11 (last, no dwell)
    const t1 = useStore.getState().stopTimes.filter((s) => s.trip_id === 't1').sort((a, b) => a.stop_sequence - b.stop_sequence);
    expect(t1.map((s) => s.arrival_time)).toEqual(['08:00:00', '08:05:00', '08:11:00']);
    expect(t1.map((s) => s.departure_time)).toEqual(['08:00:00', '08:06:00', '08:11:00']);
    // the speed factor slows travel
    useStore.getState().setStopTimes([...tripTimes('t1', 8 * 3600), ...tripTimes('t2', 8 * 3600 + 1800)] as StopTime[]);
    applyPatternEstimate({ routeId: 'R1', directionId: 0 }, orderedStops, cum, { dwellSec: 0, speedFactor: 2 });
    expect(endOf('t1')).toBe('08:20:00'); // 600s road × 2 = 1200s = 20 min
  });

  it('honors skips — never writes a stop the trip does not already time', () => {
    // t3 skips the middle stop (no s2 row).
    const st = useStore.getState();
    st.setTrips([...st.trips, { trip_id: 't3', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
    st.setStopTimes([
      ...st.stopTimes,
      { trip_id: 't3', stop_id: 's1', stop_sequence: 1, arrival_time: '09:00:00', departure_time: '09:00:00' },
      { trip_id: 't3', stop_id: 's3', stop_sequence: 3, arrival_time: '09:30:00', departure_time: '09:30:00' },
    ] as StopTime[]);
    applyPatternEstimate({ routeId: 'R1', directionId: 0 }, orderedStops, cum, { dwellSec: 60, speedFactor: 1 });
    const t3 = useStore.getState().stopTimes.filter((s) => s.trip_id === 't3');
    expect(t3.some((s) => s.stop_sequence === 2)).toBe(false); // skip stayed a skip
    expect(t3.find((s) => s.stop_sequence === 1)?.departure_time).toBe('09:00:00'); // start kept
    expect(t3.find((s) => s.stop_sequence === 3)?.arrival_time).toBe('09:11:00');  // re-laid from the profile
  });

  it('no-ops when the profile length does not match the stops', () => {
    expect(applyPatternEstimate({ routeId: 'R1', directionId: 0 }, orderedStops, [0, 300], { dwellSec: 60, speedFactor: 1 })).toBe(0);
  });
});
