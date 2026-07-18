// #66 redesign — full save→reload round-trip through the real store, with only
// the network (projectsApi) mocked. Proves: baseline stays canonical in the
// feed slot, variants survive reload, and the active variant is restored.
import { vi, describe, it, expect, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ saved: { snapshot: null as Record<string, unknown> | null, version: 1 } }));

vi.mock('../projectsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projectsApi')>();
  return {
    ...actual,
    fetchWorkingState: async () => ({ snapshot: h.saved.snapshot, version: h.saved.version }),
    saveWorkingState: async (_id: string, snapshot: Record<string, unknown>) => {
      h.saved.snapshot = snapshot;
      h.saved.version += 1;
      return { workingStateVersion: h.saved.version };
    },
  };
});

import { useStore } from '../../store';
import {
  saveProjectNow,
  loadProjectFromServer,
  setCurrentWorkingStateVersion,
  resetEditorState,
} from '../../db/serverPersistence';
import {
  createVariantFromCurrent,
  switchToVariant,
  baselineVariant,
  promoteToBaseline,
} from '../variants';
import { VARIANTS_ENVELOPE_KEY } from '../variantPersistence';
import type { Route, Trip, StopTime } from '../../types/gtfs';

const PID = 'proj-1';

function seedBaseline() {
  const s = useStore.getState();
  resetEditorState();
  s.setRoutes([{ route_id: 'R1', route_short_name: 'R1', route_long_name: 'R1', route_type: 3 } as Route]);
  s.setStops([{ stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never]);
  s.setRouteStops([{ route_id: 'R1', stop_id: 's1', direction_id: 0, stop_sequence: 1, _snapped: false }] as never);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setTrips([{ trip_id: 't1', route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
  s.setStopTimes([{ trip_id: 't1', stop_id: 's1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' } as StopTime]);
  // #67: the baseline carries a transfer so we can prove transfers ride the
  // variant envelope through save→reload.
  s.setTransfers([{ from_stop_id: 's1', to_stop_id: 's1', transfer_type: 0 }] as never);
}

const addTrip = (id: string) => {
  const s = useStore.getState();
  s.setTrips([...s.trips, { trip_id: id, route_id: 'R1', service_id: 'wk', direction_id: 0 } as Trip]);
};
const addRoute = (id: string) => {
  const s = useStore.getState();
  s.setRoutes([...s.routes, { route_id: id, route_short_name: id, route_long_name: id, route_type: 3 } as Route]);
};

beforeEach(() => {
  h.saved = { snapshot: null, version: 1 };
  setCurrentWorkingStateVersion(PID, 1);
  seedBaseline();
});

describe('variant persistence save → reload round-trip', () => {
  it('keeps the baseline canonical, persists variants, and restores the active one', async () => {
    // Baseline = {R1, t1}. Fork V1 and add t2. Back to baseline, fork V2 and add R2.
    const v1 = createVariantFromCurrent('V1');
    addTrip('t2'); // V1 = t1,t2
    switchToVariant(baselineVariant()!.id);
    const v2 = createVariantFromCurrent('V2');
    addRoute('R2'); // V2 = R1,R2 (active)

    expect(useStore.getState().routes.map((r) => r.route_id).sort()).toEqual(['R1', 'R2']);

    await saveProjectNow(PID);

    // The persisted blob's flat top-level feed is the BASELINE (R1 only, t1
    // only) — never the active V2 experiment — plus a variant envelope.
    const blob = h.saved.snapshot!;
    expect((blob.routes as Route[]).map((r) => r.route_id)).toEqual(['R1']);
    expect((blob.trips as Trip[]).map((t) => t.trip_id)).toEqual(['t1']);
    expect(blob[VARIANTS_ENVELOPE_KEY]).toBeTruthy();

    // Simulate a hard reload: wipe the store, then load from the "server".
    resetEditorState();
    useStore.getState().setVariants([]);
    useStore.getState().setActiveVariantId(null);

    await loadProjectFromServer(PID);

    const st = useStore.getState();
    // Active variant (V2) restored into the live store.
    expect(st.activeVariantId).toBe(v2);
    expect(st.routes.map((r) => r.route_id).sort()).toEqual(['R1', 'R2']);
    // All three variants came back.
    expect(st.variants.map((v) => v.name).sort()).toEqual(['Baseline', 'V1', 'V2']);
    expect(st.isDirty).toBe(false);

    // Switching to V1 shows its edit; baseline is intact (never clobbered by V2).
    switchToVariant(v1);
    expect(useStore.getState().trips.map((t) => t.trip_id).sort()).toEqual(['t1', 't2']);
    switchToVariant(baselineVariant()!.id);
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['R1']);
    expect(useStore.getState().trips.map((t) => t.trip_id)).toEqual(['t1']);
  });

  it('transfers ride the variant envelope: baseline canonical, variant edit preserved (#67)', async () => {
    // Baseline has one transfer (from seed). Fork V1 and give it a 2nd transfer.
    const v1 = createVariantFromCurrent('V1');
    useStore.getState().setTransfers([
      { from_stop_id: 's1', to_stop_id: 's1', transfer_type: 0 },
      { from_stop_id: 's1', to_stop_id: 's2', transfer_type: 2, min_transfer_time: 120 },
    ] as never);

    await saveProjectNow(PID);
    // The flat top-level feed keeps only the BASELINE transfer.
    expect((h.saved.snapshot!.transfers as unknown[])).toHaveLength(1);

    // Hard reload.
    resetEditorState();
    useStore.getState().setVariants([]);
    useStore.getState().setActiveVariantId(null);
    await loadProjectFromServer(PID);

    const st = useStore.getState();
    // Active variant (V1) restored to the live store with BOTH transfers.
    expect(st.activeVariantId).toBe(v1);
    expect(st.transfers).toHaveLength(2);
    // Baseline reconstructed with only its single transfer (not clobbered).
    const baseSnap = st.variants.find((v) => v.baseline)!.snapshot;
    expect((baseSnap.transfers as unknown[])).toHaveLength(1);
    // Switching to baseline reverts the live transfers to the single one.
    switchToVariant(baselineVariant()!.id);
    expect(useStore.getState().transfers).toHaveLength(1);
  });

  it('promote → save → reload lands the promoted world (baseline = promoted, prior preserved)', async () => {
    const v1 = createVariantFromCurrent('V1');
    addRoute('R2'); // V1 = R1, R2
    switchToVariant(baselineVariant()!.id);
    createVariantFromCurrent('V2');
    addTrip('t2'); // V2 = R1 (t1, t2)

    promoteToBaseline(v1); // baseline := V1's content; old baseline kept as variant

    await saveProjectNow(PID);
    // Flat top-level feed is now the PROMOTED baseline (R1, R2).
    expect((h.saved.snapshot!.routes as Route[]).map((r) => r.route_id).sort()).toEqual(['R1', 'R2']);

    // Hard reload.
    resetEditorState();
    useStore.getState().setVariants([]);
    useStore.getState().setActiveVariantId(null);
    await loadProjectFromServer(PID);

    const st = useStore.getState();
    // Baseline is the promoted feed and is active.
    expect(st.variants.find((v) => v.baseline)!.id).toBe(st.activeVariantId);
    expect(st.routes.map((r) => r.route_id).sort()).toEqual(['R1', 'R2']);
    // Prior baseline preserved as a variant with its original content.
    const prior = st.variants.find((v) => v.name === 'Baseline (before V1)')!;
    expect(prior).toBeTruthy();
    expect((prior.snapshot.routes as Route[]).map((r) => r.route_id)).toEqual(['R1']);
    // V2 kept its forked state; the promoted variant is gone.
    const v2 = st.variants.find((v) => v.name === 'V2')!;
    expect((v2.snapshot.trips as Trip[]).map((t) => t.trip_id).sort()).toEqual(['t1', 't2']);
    expect(st.variants.some((v) => v.name === 'V1')).toBe(false);
  });

  it('a feed with no variants saves a flat, envelope-free blob (backward compatible)', async () => {
    await saveProjectNow(PID);
    expect(h.saved.snapshot![VARIANTS_ENVELOPE_KEY]).toBeUndefined();
    expect((h.saved.snapshot!.routes as Route[]).map((r) => r.route_id)).toEqual(['R1']);

    // And it loads back with no variant layer.
    resetEditorState();
    await loadProjectFromServer(PID);
    expect(useStore.getState().variants).toEqual([]);
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['R1']);
  });

  it('an old-style snapshot (no envelope) loads as a plain feed', async () => {
    h.saved.snapshot = { routes: [{ route_id: 'OLD' }], stops: [], trips: [] };
    resetEditorState();
    await loadProjectFromServer(PID);
    expect(useStore.getState().routes.map((r) => r.route_id)).toEqual(['OLD']);
    expect(useStore.getState().variants).toEqual([]);
  });
});
