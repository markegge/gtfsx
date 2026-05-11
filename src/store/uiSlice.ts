import type { StateCreator } from 'zustand';
import type { SidebarSection, BottomPanelTab, MapMode, StopPlacementMode, RouteDetailTab } from '../types/ui';

export interface UISlice {
  sidebarSection: SidebarSection | null;
  bottomPanelOpen: boolean;
  bottomPanelTab: BottomPanelTab;
  mapMode: MapMode;
  stopPlacementMode: StopPlacementMode;
  stopPlacementDirection: 0 | 1;
  timetableDirectionId: 0 | 1;
  selectedRouteId: string | null;
  selectedStopId: string | null;
  selectedTripId: string | null;
  drawingRouteId: string | null;
  editingRouteId: string | null;
  editingShapeId: string | null;
  editingFlexZoneId: string | null;
  snapToRoad: boolean;
  hiddenRouteIds: string[];
  hiddenShapeIds: string[];
  leftRailWidth: number;
  rightRailOpen: boolean;
  routeDetailTab: RouteDetailTab;
  routeDeleteConfirmId: string | null;
  toggleRouteVisibility: (routeId: string) => void;
  toggleShapeVisibility: (shapeId: string) => void;
  setSidebarSection: (section: SidebarSection | null) => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setBottomPanelTab: (tab: BottomPanelTab) => void;
  setMapMode: (mode: MapMode) => void;
  setStopPlacementMode: (mode: StopPlacementMode) => void;
  setStopPlacementDirection: (dir: 0 | 1) => void;
  setTimetableDirectionId: (dir: 0 | 1) => void;
  selectRoute: (id: string | null) => void;
  selectStop: (id: string | null) => void;
  selectTrip: (id: string | null) => void;
  setDrawingRouteId: (id: string | null) => void;
  setEditingRouteId: (id: string | null) => void;
  setEditingShapeId: (id: string | null) => void;
  setEditingFlexZoneId: (id: string | null) => void;
  setSnapToRoad: (v: boolean) => void;
  setLeftRailWidth: (w: number) => void;
  setRightRailOpen: (open: boolean) => void;
  setRouteDetailTab: (tab: RouteDetailTab) => void;
  setRouteDeleteConfirmId: (id: string | null) => void;
}

export const createUISlice: StateCreator<UISlice, [['zustand/immer', never]], [], UISlice> = (set) => ({
  sidebarSection: null,
  bottomPanelOpen: false,
  bottomPanelTab: 'timetable',
  mapMode: 'select',
  stopPlacementMode: 'snap_to_route',
  stopPlacementDirection: 0,
  timetableDirectionId: 0,
  selectedRouteId: null,
  selectedStopId: null,
  selectedTripId: null,
  drawingRouteId: null,
  editingRouteId: null,
  editingShapeId: null,
  editingFlexZoneId: null,
  snapToRoad: true,
  hiddenRouteIds: [],
  hiddenShapeIds: [],
  // Default width is set responsively in App init based on viewport — 96 for
  // medium screens, 260 for wide ones. The store falls back to 96 if it loads
  // before the responsive init runs.
  leftRailWidth: 96,
  rightRailOpen: false,
  routeDetailTab: 'details',
  routeDeleteConfirmId: null,
  toggleRouteVisibility: (routeId) => set((state) => {
    const idx = state.hiddenRouteIds.indexOf(routeId);
    if (idx === -1) state.hiddenRouteIds.push(routeId);
    else state.hiddenRouteIds.splice(idx, 1);
  }),
  toggleShapeVisibility: (shapeId) => set((state) => {
    const idx = state.hiddenShapeIds.indexOf(shapeId);
    if (idx === -1) state.hiddenShapeIds.push(shapeId);
    else state.hiddenShapeIds.splice(idx, 1);
  }),
  setSidebarSection: (section) => set((state) => {
    state.sidebarSection = section;
    // Selecting a section is the user's intent to edit it — open the right rail.
    // Clearing the section closes it.
    state.rightRailOpen = section !== null;
    // "Place Stops on Map" and "Move Stop" only make sense while the Stops
    // panel is active — auto-exit when the user navigates away so the map
    // doesn't keep capturing clicks for a mode whose UI is no longer visible.
    if (section !== 'stops' && (state.mapMode === 'place_stop' || state.mapMode === 'move_stop')) {
      state.mapMode = 'select';
    }
  }),
  setBottomPanelOpen: (open) => set((state) => { state.bottomPanelOpen = open; }),
  toggleBottomPanel: () => set((state) => { state.bottomPanelOpen = !state.bottomPanelOpen; }),
  setBottomPanelTab: (tab) => set((state) => { state.bottomPanelTab = tab; }),
  setMapMode: (mode) => set((state) => { state.mapMode = mode; }),
  setStopPlacementMode: (mode) => set((state) => { state.stopPlacementMode = mode; }),
  setStopPlacementDirection: (dir) => set((state) => { state.stopPlacementDirection = dir; }),
  setTimetableDirectionId: (dir) => set((state) => { state.timetableDirectionId = dir; }),
  selectRoute: (id) => set((state) => { state.selectedRouteId = id; }),
  selectStop: (id) => set((state) => { state.selectedStopId = id; }),
  selectTrip: (id) => set((state) => { state.selectedTripId = id; }),
  setDrawingRouteId: (id) => set((state) => { state.drawingRouteId = id; }),
  setEditingRouteId: (id) => set((state) => { state.editingRouteId = id; }),
  setEditingShapeId: (id) => set((state) => { state.editingShapeId = id; }),
  setEditingFlexZoneId: (id) => set((state) => { state.editingFlexZoneId = id; }),
  setSnapToRoad: (v) => set((state) => { state.snapToRoad = v; }),
  setLeftRailWidth: (w) => set((state) => { state.leftRailWidth = w; }),
  setRightRailOpen: (open) => set((state) => { state.rightRailOpen = open; }),
  setRouteDetailTab: (tab) => set((state) => { state.routeDetailTab = tab; }),
  setRouteDeleteConfirmId: (id) => set((state) => { state.routeDeleteConfirmId = id; }),
});
