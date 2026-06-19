// A2 — feed variant fork / switch / compare round-trip against the real store.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import {
  createVariantFromCurrent,
  switchToVariant,
  compareActiveToBaseline,
  deleteVariant,
  baselineVariant,
  activeVariant,
} from '../variants';
import type { Route, Trip, StopTime } from '../../types/gtfs';

function seedFeed() {
  const s = useStore.getState();
  s.setVariants([]);
  s.setActiveVariantId(null);
  s.setRoutes([{ route_id: 'R1', route_short_name: 'R1', route_long_name: 'R1', route_type: 3 } as Route]);
  s.setRouteStops([
    { route_id: 'R1', stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false },
    { route_id: 'R1', stop_id: 's2', direction_id: 0, stop_sequence: 2, _snapped: false },
  ] as never);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setStops([
    { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never,
    { stop_id: 's2', stop_name: 'B', stop_lat: 45.05, stop_lon: -111, wheelchair_boarding: 0 } as never,
  ]);
  s.setTrips([{ trip_id: 't1', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
  s.setStopTimes([
    { trip_id: 't1', stop_id: 's1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 't1', stop_id: 's2', stop_sequence: 2, arrival_time: '08:30:00', departure_time: '08:30:00' },
  ] as StopTime[]);
}

const addTrip = (id: string) => {
  const s = useStore.getState();
  s.setTrips([...s.trips, { trip_id: id, route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
  s.setStopTimes([...s.stopTimes,
    { trip_id: id, stop_id: 's1', stop_sequence: 1, arrival_time: '09:00:00', departure_time: '09:00:00' },
    { trip_id: id, stop_id: 's2', stop_sequence: 2, arrival_time: '09:30:00', departure_time: '09:30:00' },
  ] as StopTime[]);
};

beforeEach(seedFeed);

describe('feed variants', () => {
  it('first fork captures a Baseline + a new active variant', () => {
    createVariantFromCurrent('Add a run');
    const st = useStore.getState();
    expect(st.variants).toHaveLength(2);
    expect(baselineVariant()?.name).toBe('Baseline');
    expect(activeVariant()?.name).toBe('Add a run');
    expect(activeVariant()?.baseline).toBe(false);
  });

  it('edits to a variant are isolated from the baseline and survive switching', () => {
    const vid = createVariantFromCurrent('Add a run');
    addTrip('t2'); // edit the active variant
    expect(useStore.getState().trips).toHaveLength(2);

    // Switch to baseline — the live feed reverts (no t2).
    const baseId = baselineVariant()!.id;
    switchToVariant(baseId);
    expect(useStore.getState().trips.map((t) => t.trip_id)).toEqual(['t1']);

    // Switch back to the variant — t2 is restored.
    switchToVariant(vid);
    expect(useStore.getState().trips.map((t) => t.trip_id).sort()).toEqual(['t1', 't2']);
  });

  it('compareActiveToBaseline reports the variant deltas', () => {
    createVariantFromCurrent('Add a run');
    addTrip('t2');
    const diff = compareActiveToBaseline();
    expect(diff).not.toBeNull();
    expect(diff!.trips.delta).toBe(1);
    expect(diff!.identical).toBe(false);
    const r1 = diff!.routeChanges.find((c) => c.routeId === 'R1');
    expect(r1!.tripsPerWeekDelta).toBe(5); // one weekday trip
  });

  it('on the baseline, compare shows no changes', () => {
    createVariantFromCurrent('Add a run');
    switchToVariant(baselineVariant()!.id);
    const diff = compareActiveToBaseline();
    expect(diff!.identical).toBe(true);
  });

  it('deleting the last variant collapses the layer', () => {
    const vid = createVariantFromCurrent('Add a run');
    deleteVariant(vid);
    expect(useStore.getState().variants).toHaveLength(0);
    expect(useStore.getState().activeVariantId).toBeNull();
  });
});
