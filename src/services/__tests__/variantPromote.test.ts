// Variants panel — promote-to-baseline and duplicate semantics (in-memory).
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { resetEditorState } from '../../db/serverPersistence';
import {
  createVariantFromCurrent,
  switchToVariant,
  duplicateVariant,
  promoteToBaseline,
  baselineVariant,
  activeVariant,
  deleteVariant,
} from '../variants';
import type { Route, Trip } from '../../types/gtfs';

function seedBaseline() {
  const s = useStore.getState();
  resetEditorState();
  s.setRoutes([{ route_id: 'R1', route_short_name: 'R1', route_long_name: 'R1', route_type: 3 } as Route]);
  s.setStops([{ stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never]);
  s.setRouteStops([{ route_id: 'R1', stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false }] as never);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setTrips([{ trip_id: 't1', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
  s.setStopTimes([]);
}
const routeIds = () => useStore.getState().routes.map((r) => r.route_id).sort();
const addRoute = (id: string) => {
  const s = useStore.getState();
  s.setRoutes([...s.routes, { route_id: id, route_short_name: id, route_long_name: id, route_type: 3 } as Route]);
};
const addTrip = (id: string) => {
  const s = useStore.getState();
  s.setTrips([...s.trips, { trip_id: id, route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
};
const snapRoutes = (id: string) =>
  ((useStore.getState().variants.find((v) => v.id === id)?.snapshot.routes ?? []) as Route[]).map((r) => r.route_id).sort();

beforeEach(seedBaseline);

describe('promoteToBaseline', () => {
  it('makes the variant the baseline, preserves the old baseline, keeps others forked, drops the promoted', () => {
    const v1 = createVariantFromCurrent('V1');
    addRoute('R2'); // V1 = R1, R2
    switchToVariant(baselineVariant()!.id);
    const v2 = createVariantFromCurrent('V2');
    addTrip('t2'); // V2 = R1 (t1,t2)

    promoteToBaseline(v1);
    const st = useStore.getState();

    // New baseline is active and holds V1's content.
    const base = baselineVariant()!;
    expect(activeVariant()!.id).toBe(base.id);
    expect(base.baseline).toBe(true);
    expect(routeIds()).toEqual(['R1', 'R2']); // live store == new baseline
    expect(snapRoutes(base.id)).toEqual(['R1', 'R2']);

    // Old baseline preserved as a normal variant, auto-named, original content.
    const prior = st.variants.find((v) => v.name === 'Baseline (before V1)');
    expect(prior).toBeTruthy();
    expect(prior!.baseline).toBe(false);
    expect(snapRoutes(prior!.id)).toEqual(['R1']);

    // V2 kept its forked state.
    const keptV2 = st.variants.find((v) => v.id === v2)!;
    expect(keptV2).toBeTruthy();
    expect((keptV2.snapshot.trips as Trip[]).map((t) => t.trip_id).sort()).toEqual(['t1', 't2']);

    // Promoted variant removed (it IS the baseline now).
    expect(st.variants.find((v) => v.id === v1)).toBeUndefined();
    expect(st.variants.some((v) => v.name === 'V1')).toBe(false);

    // Unsaved arrangement.
    expect(st.isDirty).toBe(true);
  });

  it('is a no-op on the baseline itself or an unknown id', () => {
    createVariantFromCurrent('V1');
    const before = useStore.getState().variants.map((v) => v.id);
    promoteToBaseline(baselineVariant()!.id);
    promoteToBaseline('nope');
    expect(useStore.getState().variants.map((v) => v.id)).toEqual(before);
  });

  it('does not collapse the layer: promoting the only variant leaves baseline + prior-baseline', () => {
    const v1 = createVariantFromCurrent('V1');
    addRoute('R2');
    promoteToBaseline(v1);
    const names = useStore.getState().variants.map((v) => v.name).sort();
    expect(names).toEqual(['Baseline', 'Baseline (before V1)']);
  });
});

describe('duplicateVariant', () => {
  it('copies any variant (active or not), becomes active, and is independent of the source', () => {
    const v1 = createVariantFromCurrent('V1');
    addRoute('R2'); // V1 active = R1, R2
    switchToVariant(baselineVariant()!.id); // leave V1 (flushes R1,R2 into V1)

    // Duplicate the INACTIVE V1.
    const dup = duplicateVariant(v1)!;
    expect(useStore.getState().activeVariantId).toBe(dup);
    expect(useStore.getState().variants.find((v) => v.id === dup)!.name).toBe('V1 copy');
    expect(routeIds()).toEqual(['R1', 'R2']); // copy has V1's content

    // Edit the copy; the source variant must not change.
    addRoute('R3');
    expect(routeIds()).toEqual(['R1', 'R2', 'R3']); // copy (live)
    expect(snapRoutes(v1)).toEqual(['R1', 'R2']); // source untouched
  });

  it('returns null for an unknown source', () => {
    createVariantFromCurrent('V1');
    expect(duplicateVariant('nope')).toBeNull();
  });
});

describe('delete edge cases', () => {
  it('deleting the ACTIVE variant (with others remaining) switches to baseline', () => {
    createVariantFromCurrent('V1');
    addRoute('R2'); // V1
    switchToVariant(baselineVariant()!.id);
    const v2 = createVariantFromCurrent('V2');
    addTrip('t2'); // active V2

    deleteVariant(v2);
    // Baseline + V1 remain, so the layer stays; live store reverts to baseline.
    expect(activeVariant()!.baseline).toBe(true);
    expect(routeIds()).toEqual(['R1']);
    expect(useStore.getState().variants.some((v) => v.name === 'V1')).toBe(true);
  });

  it('deleting the LAST variant collapses the layer back to a plain feed', () => {
    const v1 = createVariantFromCurrent('V1');
    addRoute('R2'); // active V1 (only non-baseline variant)
    deleteVariant(v1);
    // A lone baseline is just the feed → the whole layer is dropped.
    expect(useStore.getState().variants).toEqual([]);
    expect(useStore.getState().activeVariantId).toBeNull();
    expect(routeIds()).toEqual(['R1']); // baseline content is what's live
  });

  it('the baseline cannot be deleted', () => {
    createVariantFromCurrent('V1');
    const baseId = baselineVariant()!.id;
    deleteVariant(baseId);
    expect(useStore.getState().variants.some((v) => v.id === baseId)).toBe(true);
  });
});
