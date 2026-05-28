/**
 * Lifecycle tests for the Routes > Shapes editing flow. These focus on the
 * store-level state transitions that gate the Save / Cancel UI in
 * RouteShapesTab and the map-mode controls in MapView. The bug Mark hit —
 * "I sometimes end up stuck in edit mode" — was that switching off the
 * Shapes tab (or the Routes section) didn't reset mapMode, so the user
 * was left in 'edit_shape' with no controls visible.
 *
 * These tests directly drive `useStore` rather than rendering React, so
 * they're fast and don't need RTL / a virtual DOM. They run under the
 * frontend vitest config (vitest.frontend.config.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store';

// Reset the slices these tests touch back to a known clean state.
function resetStore() {
  const s = useStore.getState();
  s.setRoutes([]);
  s.setTrips([]);
  s.setShapes([]);
  s.setMapMode('select');
  s.setEditingShapeId(null);
  s.setSidebarSection(null);
  s.setRouteDetailTab('details');
  s.selectRoute(null);
}

beforeEach(resetStore);
afterEach(resetStore);

// Helpers — build minimal Route / Trip / Shape rows for these tests so each
// case is self-contained.
function seedRoute(routeId = 'rA'): void {
  const s = useStore.getState();
  s.addRoute({
    route_id: routeId,
    agency_id: '',
    route_short_name: 'A',
    route_long_name: 'Test Route',
    route_type: 3,
    route_color: '274BAC',
    route_text_color: 'FFFFFF',
  });
}

function seedShape(shapeId: string, routeId: string, directionId: 0 | 1 = 0): void {
  const s = useStore.getState();
  s.addShape({
    shape_id: shapeId,
    points: [
      { shape_pt_lat: 0, shape_pt_lon: 0, shape_pt_sequence: 0, shape_dist_traveled: 0 },
      { shape_pt_lat: 0.001, shape_pt_lon: 0.001, shape_pt_sequence: 1, shape_dist_traveled: 50 },
      { shape_pt_lat: 0.002, shape_pt_lon: 0.002, shape_pt_sequence: 2, shape_dist_traveled: 100 },
    ],
  });
  s.addTrip({
    trip_id: `${shapeId}-t1`,
    route_id: routeId,
    service_id: 'svc1',
    direction_id: directionId,
    shape_id: shapeId,
    trip_headsign: 'Downtown',
  });
}

// ─── Entering / exiting edit mode ───────────────────────────────────────────

describe('Enter and leave edit_shape mode', () => {
  it('setting editingShapeId + mapMode is the canonical "enter edit" transition', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');
    const after = useStore.getState();
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s1');
  });

  it('save flow: clearing editingShapeId + mapMode=select leaves the store clean', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');
    // Equivalent to MapView.saveShapeEdit running:
    s.setEditingShapeId(null);
    s.setMapMode('select');
    const after = useStore.getState();
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
  });
});

// ─── The "stuck in edit mode" bug ───────────────────────────────────────────

describe('Switching tabs / sections while editing queues a confirm', () => {
  it('routeDetailTab change off "shapes" queues a pendingNav and does NOT change the tab', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setRouteDetailTab('shapes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setRouteDetailTab('details');

    const after = useStore.getState();
    // Still on the shapes tab — confirm dialog renders, change is queued.
    expect(after.routeDetailTab).toBe('shapes');
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s1');
    expect(after.pendingNav).toEqual({ kind: 'tab', tab: 'details' });
  });

  it('confirmPendingNav applies the queued tab and resets the edit', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setRouteDetailTab('shapes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');
    s.setRouteDetailTab('details'); // queued
    s.confirmPendingNav();

    const after = useStore.getState();
    expect(after.routeDetailTab).toBe('details');
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
    expect(after.pendingNav).toBeNull();
  });

  it('cancelPendingNav drops the queue and leaves the user in edit mode', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setRouteDetailTab('shapes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');
    s.setRouteDetailTab('details');
    s.cancelPendingNav();

    const after = useStore.getState();
    expect(after.routeDetailTab).toBe('shapes');
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s1');
    expect(after.pendingNav).toBeNull();
  });

  it('routeDetailTab change between non-shapes tabs (no edit in progress) applies immediately', () => {
    const s = useStore.getState();
    s.setRouteDetailTab('details');
    s.setMapMode('select');
    s.setEditingShapeId(null);

    s.setRouteDetailTab('trips');

    const after = useStore.getState();
    expect(after.routeDetailTab).toBe('trips');
    expect(after.pendingNav).toBeNull();
  });

  it('sidebarSection change off "routes" while editing queues a pendingNav', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setSidebarSection('routes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setSidebarSection('stops');

    const after = useStore.getState();
    expect(after.sidebarSection).toBe('routes');
    expect(after.mapMode).toBe('edit_shape');
    expect(after.pendingNav).toEqual({ kind: 'section', section: 'stops' });
  });

  it('confirmPendingNav (section variant) restores the full setSidebarSection side-effects', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setSidebarSection('routes');
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');
    s.setSidebarSection('stops'); // queued
    s.confirmPendingNav();

    const after = useStore.getState();
    expect(after.sidebarSection).toBe('stops');
    expect(after.rightRailOpen).toBe(true);
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
  });
});

// ─── Trim mode lifecycle ────────────────────────────────────────────────────
//
// Trim mode is a single-click action with no in-progress state to lose, so
// tab / section changes pass through without the confirm-discard dialog —
// unlike edit_shape, which queues a pendingNav.

describe('Trim mode passes through without a confirm', () => {
  it('routeDetailTab change off "shapes" immediately resets trim_shape mode', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setRouteDetailTab('shapes');
    s.setEditingShapeId('s1');
    s.setMapMode('trim_shape');

    s.setRouteDetailTab('details');

    const after = useStore.getState();
    expect(after.routeDetailTab).toBe('details');
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
    expect(after.pendingNav).toBeNull();
  });

  it('sidebarSection change off "routes" immediately resets trim_shape mode', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    s.setSidebarSection('routes');
    s.setEditingShapeId('s1');
    s.setMapMode('trim_shape');

    s.setSidebarSection('agency');

    const after = useStore.getState();
    expect(after.sidebarSection).toBe('agency');
    expect(after.mapMode).toBe('select');
    expect(after.editingShapeId).toBeNull();
    expect(after.pendingNav).toBeNull();
  });
});

// ─── Duplicate flow at the store level ──────────────────────────────────────

describe('Duplicate adds shape + trip', () => {
  it('after addShape + addTrip the new shape appears alongside the original', () => {
    seedRoute();
    seedShape('s1', 'rA');
    const s = useStore.getState();
    const before = s.shapes.length;
    s.addShape({
      shape_id: 's1-copy',
      points: s.shapes[0].points.map((p, i) => ({ ...p, shape_pt_sequence: i })),
    });
    s.addTrip({
      ...s.trips[0],
      trip_id: 's1-copy-t1',
      shape_id: 's1-copy',
      trip_headsign: 'Downtown (copy)',
    });
    const after = useStore.getState();
    expect(after.shapes.length).toBe(before + 1);
    expect(after.shapes.map((sh) => sh.shape_id)).toContain('s1-copy');
    expect(after.trips.filter((t) => t.shape_id === 's1-copy').length).toBe(1);
  });
});

// ─── Re-entering edit mode on a different shape ─────────────────────────────

describe('Switching between shapes mid-edit', () => {
  it('changing editingShapeId without leaving edit_shape stays in edit mode', () => {
    seedRoute();
    seedShape('s1', 'rA');
    seedShape('s2', 'rA', 1);
    const s = useStore.getState();
    s.setEditingShapeId('s1');
    s.setMapMode('edit_shape');

    s.setEditingShapeId('s2');

    const after = useStore.getState();
    expect(after.mapMode).toBe('edit_shape');
    expect(after.editingShapeId).toBe('s2');
  });
});
