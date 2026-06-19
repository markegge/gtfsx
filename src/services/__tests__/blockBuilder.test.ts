// B3 — Quick Block heuristic + overlap sweep.
import { describe, expect, it } from 'vitest';
import { buildBlocks, findBlockOverlaps } from '../blockBuilder';
import type { Trip, StopTime, Stop } from '../../types/gtfs';

const STOPS: Stop[] = [
  { stop_id: 's1', stop_name: 's1', stop_lat: 45.00, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
  { stop_id: 's2', stop_name: 's2', stop_lat: 45.01, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
  { stop_id: 'sFar', stop_name: 'sFar', stop_lat: 46.00, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
];

function trip(id: string, route: string, startHM: string, endHM: string, from = 's1', to = 's2'): { trip: Trip; times: StopTime[] } {
  return {
    trip: { trip_id: id, route_id: route, service_id: 'wk', direction_id: 0 } as Trip,
    times: [
      { trip_id: id, stop_id: from, stop_sequence: 1, arrival_time: `${startHM}:00`, departure_time: `${startHM}:00` },
      { trip_id: id, stop_id: to, stop_sequence: 2, arrival_time: `${endHM}:00`, departure_time: `${endHM}:00` },
    ],
  };
}

function run(items: { trip: Trip; times: StopTime[] }[], opts: Partial<Parameters<typeof buildBlocks>[3]> = {}) {
  const trips = items.map((i) => i.trip);
  const times = items.flatMap((i) => i.times);
  return buildBlocks(trips, times, STOPS, { serviceId: 'wk', interline: false, ...opts });
}

describe('buildBlocks', () => {
  it('chains two non-overlapping same-route trips into one block', () => {
    const a = trip('A', 'R1', '08:00', '08:30');
    const b = trip('B', 'R1', '09:00', '09:30');
    const m = run([a, b]);
    expect(m.get('A')).toBe(m.get('B'));
    expect(new Set(m.values()).size).toBe(1);
  });

  it('splits overlapping trips into two blocks', () => {
    const a = trip('A', 'R1', '08:00', '08:30');
    const c = trip('C', 'R1', '08:15', '08:45');
    const m = run([a, c]);
    expect(m.get('A')).not.toBe(m.get('C'));
    expect(new Set(m.values()).size).toBe(2);
  });

  it('respects the interline toggle', () => {
    const a = trip('A', 'R1', '08:00', '08:30');
    const d = trip('D', 'R2', '09:00', '09:30');
    expect(new Set(run([a, d], { interline: false }).values()).size).toBe(2);
    expect(new Set(run([a, d], { interline: true }).values()).size).toBe(1);
  });

  it('opens a new block when the deadhead cannot be made in the gap', () => {
    const a = trip('A', 'R1', '08:00', '08:30', 's1', 's2');     // ends at s2
    const f = trip('F', 'R1', '08:35', '09:05', 'sFar', 's2');   // starts ~111km away, 5 min later
    const m = run([a, f]);
    expect(m.get('A')).not.toBe(m.get('F'));
  });

  it('opens a new block when idle would exceed maxLayover', () => {
    const a = trip('A', 'R1', '08:00', '08:30');
    const late = trip('L', 'R1', '14:00', '14:30'); // ~5.5h later
    const m = run([a, late], { maxLayoverSecs: 3600 });
    expect(m.get('A')).not.toBe(m.get('L'));
  });

  it('is deterministic (B1, B2, … in start order)', () => {
    const items = [trip('A', 'R1', '08:00', '08:30'), trip('C', 'R1', '08:15', '08:45')];
    const m1 = run(items); const m2 = run(items);
    expect([...m1.entries()]).toEqual([...m2.entries()]);
    expect(m1.get('A')).toBe('B1');
    expect(m1.get('C')).toBe('B2');
  });

  it('Quick Block output never overlaps within a block', () => {
    const items = [
      trip('A', 'R1', '08:00', '08:30'), trip('C', 'R1', '08:15', '08:45'),
      trip('B', 'R1', '09:00', '09:30'), trip('E', 'R1', '09:10', '09:40'),
    ];
    const m = run(items);
    const trips = items.map((i) => ({ ...i.trip, block_id: m.get(i.trip.trip_id) }));
    const overlaps = findBlockOverlaps(trips as Trip[], items.flatMap((i) => i.times));
    expect(overlaps).toHaveLength(0);
  });
});

describe('findBlockOverlaps', () => {
  it('flags two trips that overlap in the same block', () => {
    const a = trip('A', 'R1', '08:00', '08:30');
    const c = trip('C', 'R1', '08:15', '08:45');
    const trips = [{ ...a.trip, block_id: 'X' }, { ...c.trip, block_id: 'X' }] as Trip[];
    const overlaps = findBlockOverlaps(trips, [...a.times, ...c.times]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].blockId).toBe('X');
  });
});
