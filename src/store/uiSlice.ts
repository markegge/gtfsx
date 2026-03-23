import type { StateCreator } from 'zustand';
import type { SidebarSection, BottomPanelTab, MapMode, StopPlacementMode } from '../types/ui';

export interface UISlice {
  sidebarSection: SidebarSection;
  bottomPanelOpen: boolean;
  bottomPanelTab: BottomPanelTab;
  mapMode: MapMode;
  stopPlacementMode: StopPlacementMode;
  selectedRouteId: string | null;
  selectedStopId: string | null;
  selectedTripId: string | null;
  drawingRouteId: string | null;
  editingRouteId: string | null;
  editingShapeId: string | null;
  snapToRoad: boolean;
  hiddenRouteIds: string[];
  toggleRouteVisibility: (routeId: string) => void;
  setSidebarSection: (section: SidebarSection) => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setBottomPanelTab: (tab: BottomPanelTab) => void;
  setMapMode: (mode: MapMode) => void;
  setStopPlacementMode: (mode: StopPlacementMode) => void;
  selectRoute: (id: string | null) => void;
  selectStop: (id: string | null) => void;
  selectTrip: (id: string | null) => void;
  setDrawingRouteId: (id: string | null) => void;
  setEditingRouteId: (id: string | null) => void;
  setEditingShapeId: (id: string | null) => void;
  setSnapToRoad: (v: boolean) => void;
}

export const createUISlice: StateCreator<UISlice, [['zustand/immer', never]], [], UISlice> = (set) => ({
  sidebarSection: 'agency',
  bottomPanelOpen: false,
  bottomPanelTab: 'timetable',
  mapMode: 'select',
  stopPlacementMode: 'snap_to_route',
  selectedRouteId: null,
  selectedStopId: null,
  selectedTripId: null,
  drawingRouteId: null,
  editingRouteId: null,
  editingShapeId: null,
  snapToRoad: true,
  hiddenRouteIds: [],
  toggleRouteVisibility: (routeId) => set((state) => {
    const idx = state.hiddenRouteIds.indexOf(routeId);
    if (idx === -1) state.hiddenRouteIds.push(routeId);
    else state.hiddenRouteIds.splice(idx, 1);
  }),
  setSidebarSection: (section) => set((state) => { state.sidebarSection = section; }),
  setBottomPanelOpen: (open) => set((state) => { state.bottomPanelOpen = open; }),
  toggleBottomPanel: () => set((state) => { state.bottomPanelOpen = !state.bottomPanelOpen; }),
  setBottomPanelTab: (tab) => set((state) => { state.bottomPanelTab = tab; }),
  setMapMode: (mode) => set((state) => { state.mapMode = mode; }),
  setStopPlacementMode: (mode) => set((state) => { state.stopPlacementMode = mode; }),
  selectRoute: (id) => set((state) => { state.selectedRouteId = id; }),
  selectStop: (id) => set((state) => { state.selectedStopId = id; }),
  selectTrip: (id) => set((state) => { state.selectedTripId = id; }),
  setDrawingRouteId: (id) => set((state) => { state.drawingRouteId = id; }),
  setEditingRouteId: (id) => set((state) => { state.editingRouteId = id; }),
  setEditingShapeId: (id) => set((state) => { state.editingShapeId = id; }),
  setSnapToRoad: (v) => set((state) => { state.snapToRoad = v; }),
});
