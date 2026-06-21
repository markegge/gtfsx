// Bulk-fill of wheelchair_boarding on stops missing a value (Stop Analysis →
// Accessibility completeness). "Missing" = not 1 and not 2 (0 / undefined =
// "no information" per the GTFS spec). Populated stops (1/2) are never touched,
// and the fill is undoable via the returned snapshot.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import type { Stop } from '../../types/gtfs';

function stop(id: string, wb?: number): Stop {
  return {
    stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111,
    location_type: 0, wheelchair_boarding: wb as number,
  };
}

const wbOf = (id: string) =>
  useStore.getState().stops.find((s) => s.stop_id === id)!.wheelchair_boarding;

beforeEach(() => {
  useStore.getState().setStops([]);
});

describe('fillMissingWheelchairBoarding', () => {
  it('fills only the missing stops and never overwrites 1 or 2', () => {
    useStore.getState().setStops([
      stop('a', 0),          // 0 = no information → fill
      stop('b', undefined),  // undefined at runtime → fill
      stop('c', 1),          // accessible → keep
      stop('d', 2),          // not accessible → keep
    ]);

    const changed = useStore.getState().fillMissingWheelchairBoarding(['a', 'b', 'c', 'd'], 2);

    expect(wbOf('a')).toBe(2);
    expect(wbOf('b')).toBe(2);
    expect(wbOf('c')).toBe(1); // untouched
    expect(wbOf('d')).toBe(2); // already 2 — not in the changed set

    // Only a and b were actually changed; their prior values are captured.
    expect(changed.map((e) => e.stop_id).sort()).toEqual(['a', 'b']);
    expect(changed.find((e) => e.stop_id === 'a')!.prev).toBe(0);
    expect(changed.find((e) => e.stop_id === 'b')!.prev).toBe(0); // undefined → 0
  });

  it('only touches stops in the passed id list', () => {
    useStore.getState().setStops([stop('a', 0), stop('b', 0)]);
    useStore.getState().fillMissingWheelchairBoarding(['a'], 1);
    expect(wbOf('a')).toBe(1);
    expect(wbOf('b')).toBe(0); // not in the list → untouched
  });

  it('restoreWheelchairBoarding reverts a fill to the captured values', () => {
    useStore.getState().setStops([stop('a', 0), stop('b', 2)]);
    const changed = useStore.getState().fillMissingWheelchairBoarding(['a', 'b'], 1);
    expect(wbOf('a')).toBe(1);

    useStore.getState().restoreWheelchairBoarding(changed);
    expect(wbOf('a')).toBe(0); // restored
    expect(wbOf('b')).toBe(2); // never changed (already populated)
  });
});
