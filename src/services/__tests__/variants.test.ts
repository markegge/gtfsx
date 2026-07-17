// A2 — feed variant fork / switch / compare round-trip against the real store.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import {
  createVariantFromCurrent,
  switchToVariant,
  compareActiveToBaseline,
  compareVariants,
  variantFeedState,
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

describe('A-vs-B variant comparison (compareVariants)', () => {
  it('the default pickers (baseline vs active) reproduce compareActiveToBaseline exactly', () => {
    const vid = createVariantFromCurrent('Add a run');
    addTrip('t2');
    const baseId = baselineVariant()!.id;

    const viaBaseline = compareActiveToBaseline();
    const viaVariants = compareVariants(baseId, vid);
    expect(viaVariants!.trips.delta).toBe(viaBaseline!.trips.delta);
    expect(viaVariants!.kpi.delta).toEqual(viaBaseline!.kpi.delta);
    expect(viaVariants!.identical).toBe(viaBaseline!.identical);
  });

  it('diffs two non-baseline variants against each other (B − A)', () => {
    const v1 = createVariantFromCurrent('V1');
    addTrip('t2'); // V1 = t1, t2
    const v2 = createVariantFromCurrent('V2'); // forks from V1 → V2 = t1, t2
    addTrip('t3'); // V2 (active) = t1, t2, t3

    // V1 is inactive (frozen snapshot, 2 trips); V2 is active (live, 3 trips).
    const diff = compareVariants(v1, v2);
    expect(diff!.trips.a).toBe(2);
    expect(diff!.trips.b).toBe(3);
    expect(diff!.trips.delta).toBe(1);

    // Order flips the sign.
    expect(compareVariants(v2, v1)!.trips.delta).toBe(-1);
  });

  it('reads the LIVE store for the active variant (unsaved edits) and the frozen snapshot for inactive ones', () => {
    const v1 = createVariantFromCurrent('V1'); // active, = t1
    addTrip('t2'); // live edit to the active variant, snapshot not yet re-serialized
    const baseId = baselineVariant()!.id;

    // Active variant reflects the unsaved edit…
    expect(variantFeedState(v1)!.trips.map((t) => t.trip_id).sort()).toEqual(['t1', 't2']);
    // …the frozen baseline does not.
    expect(variantFeedState(baseId)!.trips.map((t) => t.trip_id)).toEqual(['t1']);
    // Unknown id → null.
    expect(variantFeedState('nope')).toBeNull();
  });

  it('returns null when either side is an unknown variant id', () => {
    createVariantFromCurrent('V1');
    expect(compareVariants('nope', baselineVariant()!.id)).toBeNull();
    expect(compareVariants(baselineVariant()!.id, 'nope')).toBeNull();
  });
});
