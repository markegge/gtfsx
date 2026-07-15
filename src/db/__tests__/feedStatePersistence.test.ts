import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store';
import { applySnapshotToStore, buildSnapshot, resetEditorState, resetStoreEntities } from '../serverPersistence';
import type { Agency } from '../../types/gtfs';

const AGENCY: Agency = {
  agency_id: 'SVT',
  agency_name: 'Sample Valley Transit',
  agency_url: 'https://example.org',
  agency_timezone: 'America/Denver',
};

describe('feed-state persistence (license + agency external_id)', () => {
  beforeEach(() => {
    resetStoreEntities();
  });

  it("round-trips each agency's own external_id inside the agencies entity (no persistence key of its own)", () => {
    // The NTD / external ID belongs to the AGENCY, so it rides along in the
    // already-persisted `agencies` array. Leading zeros are significant: it is a
    // string end-to-end and must never be Number()-coerced.
    useStore.getState().setAgencies([
      { ...AGENCY, external_id: '01234' },
      { ...AGENCY, agency_id: 'MTA', agency_name: 'Metro', external_id: '00567' },
      { ...AGENCY, agency_id: 'RID', agency_name: 'Ridge' }, // none set
    ]);

    // Survives JSON serialization (what actually goes over the wire / to disk).
    const wire = JSON.parse(JSON.stringify(buildSnapshot()));
    expect(wire.agencies.map((a: Agency) => a.external_id)).toEqual(['01234', '00567', undefined]);

    resetStoreEntities();
    expect(useStore.getState().agencies).toHaveLength(0);

    applySnapshotToStore(wire);

    const restored = useStore.getState().agencies;
    expect(restored).toHaveLength(3);
    expect(restored[0].external_id).toBe('01234');
    expect(restored[1].external_id).toBe('00567');
    expect(restored[2].external_id).toBeUndefined();
    // A string, not a number — a Number() coercion anywhere would drop the zero.
    expect(typeof restored[0].external_id).toBe('string');
  });

  it('normalizes a cleared external_id to undefined, never an empty string', () => {
    const s = useStore.getState();
    s.setAgencies([{ ...AGENCY, external_id: '01234' }]);
    // What AgencyEditor's onChange does when the input is emptied. An '' here
    // would make the exporter emit an empty external_id column.
    s.updateAgency('SVT', { external_id: undefined });
    expect(useStore.getState().agencies[0].external_id).toBeUndefined();
    expect(JSON.parse(JSON.stringify(buildSnapshot())).agencies[0].external_id).toBeUndefined();
  });

  it('round-trips licenseSpdx as feed state and does not leak it across projects', () => {
    const s = useStore.getState();
    s.setLicenseSpdx('CC-BY-4.0');
    expect(useStore.getState().licenseSpdx).toBe('CC-BY-4.0');

    const snapshot = buildSnapshot();
    expect(snapshot.licenseSpdx).toBe('CC-BY-4.0');

    // Loading a *different* project whose snapshot has no license must clear it,
    // not inherit the previous project's terms.
    applySnapshotToStore({});
    expect(useStore.getState().licenseSpdx).toBeNull();

    applySnapshotToStore(snapshot);
    expect(useStore.getState().licenseSpdx).toBe('CC-BY-4.0');
  });

  it('normalizes a blank licenseSpdx to null', () => {
    useStore.getState().setLicenseSpdx('  ');
    expect(useStore.getState().licenseSpdx).toBeNull();
  });
});

// Regression for #42: opening a feed must not leak the previous feed's
// in-memory geometry or editing/view state onto the new feed's map. Every
// feed-boundary path funnels through resetEditorState (server load, replace
// import, create-new-feed, leaving /demo), so it is the seam to lock down.
describe('feed-open editor reset (issue #42 state leak)', () => {
  beforeEach(() => {
    resetEditorState();
  });

  // Populate the transient geometry + view state the way an open feed would.
  function seedDirtyEditor() {
    const s = useStore.getState();
    s.setShapes([
      { shape_id: 's1', points: [{ shape_pt_lat: 45, shape_pt_lon: -111, shape_pt_sequence: 0 }] },
    ] as never);
    s.setFlexZones([
      { id: 'z1', name: 'Zone 1', geojson: { type: 'FeatureCollection', features: [] } },
    ] as never);
    s.setRoutes([{ route_id: 'r1', route_short_name: '1', route_type: 3 }] as never);
    s.selectRoute('r1');
    s.selectStop('st1');
    s.selectTrip('t1');
    s.setEditingShapeId('s1');
    s.setEditingFlexZoneId('z1');
    s.setDrawingRouteId('r1');
    s.setEditingStopId('st1');
    s.setMapMode('edit_shape');
    useStore.setState((st) => {
      st.hiddenRouteIds = ['r9'];
      st.hiddenShapeIds = ['s9'];
    });
    s.setCoverageData({} as never);
    s.setValidationMessages([{ id: 'v1' }] as never);
    s.setAccessResult({} as never);
    s.setWalkshedProfiles({} as never);
    s.setStopAnalysisOverlay({} as never);
  }

  it('resetEditorState clears geometry AND all transient view/editing state', () => {
    seedDirtyEditor();
    // Sanity: everything is dirty before the reset.
    expect(useStore.getState().shapes.length).toBe(1);
    expect(useStore.getState().mapMode).toBe('edit_shape');

    resetEditorState();

    const s = useStore.getState();
    // Entities
    expect(s.shapes).toHaveLength(0);
    expect(s.flexZones).toHaveLength(0);
    expect(s.routes).toHaveLength(0);
    // Selection + in-progress editing
    expect(s.selectedRouteId).toBeNull();
    expect(s.selectedStopId).toBeNull();
    expect(s.selectedTripId).toBeNull();
    expect(s.editingShapeId).toBeNull();
    expect(s.editingFlexZoneId).toBeNull();
    expect(s.drawingRouteId).toBeNull();
    expect(s.editingStopId).toBeNull();
    // Map mode back to select — this is what makes MapView tear down the
    // imperative Mapbox Draw layer, so a half-drawn shape can't survive.
    expect(s.mapMode).toBe('select');
    // Per-feed visibility filters
    expect(s.hiddenRouteIds).toHaveLength(0);
    expect(s.hiddenShapeIds).toHaveLength(0);
    // Derived overlays / analytics
    expect(s.coverageData).toBeNull();
    expect(s.validationMessages).toHaveLength(0);
    expect(s.accessResult).toBeNull();
    expect(s.walkshedProfiles).toBeNull();
    expect(s.stopAnalysisOverlay).toBeNull();
  });

  it('opening an empty feed (applySnapshotToStore with no geometry) drops the previous feed\'s shapes + flex zones', () => {
    seedDirtyEditor();
    // Re-open a feed whose snapshot carries no shapes/flexZones keys at all —
    // the exact /demo-round-trip → empty-feed case in the bug report. The
    // per-key guards must NOT leave the demo's geometry behind.
    applySnapshotToStore({});
    const s = useStore.getState();
    expect(s.shapes).toHaveLength(0);
    expect(s.flexZones).toHaveLength(0);
    expect(s.routes).toHaveLength(0);
    expect(s.mapMode).toBe('select');
  });
});
