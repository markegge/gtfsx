import type { StateCreator } from 'zustand';
import type { SidebarSection, BottomPanelTab, MapMode, StopPlacementMode, RouteDetailTab, StopDetailTab, CalendarDetailTab } from '../types/ui';

export interface UISlice {
  sidebarSection: SidebarSection | null;
  bottomPanelOpen: boolean;
  bottomPanelTab: BottomPanelTab;
  mapMode: MapMode;
  stopPlacementMode: StopPlacementMode;
  stopPlacementDirection: 0 | 1;
  timetableDirectionId: 0 | 1;
  /** Advanced toggle on the timetable: when true, each stop cell exposes
   *  separate arrival and departure inputs so users can author dwell time at
   *  intermediate stops (ferry layovers, rail station holds, etc.). When
   *  false (default), the cell collapses to a single time and the editor
   *  keeps arrival_time === departure_time on commit. */
  timetableSplitArrDep: boolean;
  selectedRouteId: string | null;
  selectedStopId: string | null;
  selectedTripId: string | null;
  drawingRouteId: string | null;
  editingRouteId: string | null;
  editingShapeId: string | null;
  editingFlexZoneId: string | null;
  editingStopId: string | null;
  // service_id of the calendar (service pattern) currently in the detail
  // view. Mirrors editingRouteId — when set + the Calendars section is
  // active, the right rail renders the detail form with a breadcrumb back
  // to the list.
  editingCalendarServiceId: string | null;
  // When true, RightRail renders the CreateStopPanel sub-panel instead of
  // the section body. Origin is implied by sidebarSection + editingRouteId.
  creatingStop: boolean;
  // When the Stops panel narrows the list, the map fades non-matching stops
  // so the user can see the filter result in context without losing the rest
  // of the system. null = no filter active (all stops render normally).
  mapStopFilter: { matched: string[] } | null;
  snapToRoad: boolean;
  hiddenRouteIds: string[];
  // route_type values toggled OFF in the Routes panel's type filter. Empty =
  // no filter (all types shown). Routes of a hidden type are dimmed on the map.
  hiddenRouteTypes: number[];
  hiddenShapeIds: string[];
  leftRailWidth: number;
  rightRailOpen: boolean;
  rightRailWidth: number;
  routeDetailTab: RouteDetailTab;
  stopDetailTab: StopDetailTab;
  calendarDetailTab: CalendarDetailTab;
  routeDeleteConfirmId: string | null;
  toggleRouteVisibility: (routeId: string) => void;
  toggleRouteType: (routeType: number) => void;
  toggleShapeVisibility: (shapeId: string) => void;
  setSidebarSection: (section: SidebarSection | null) => void;
  setBottomPanelOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setBottomPanelTab: (tab: BottomPanelTab) => void;
  setMapMode: (mode: MapMode) => void;
  setStopPlacementMode: (mode: StopPlacementMode) => void;
  setStopPlacementDirection: (dir: 0 | 1) => void;
  setTimetableDirectionId: (dir: 0 | 1) => void;
  setTimetableSplitArrDep: (v: boolean) => void;
  selectRoute: (id: string | null) => void;
  selectStop: (id: string | null) => void;
  selectTrip: (id: string | null) => void;
  setDrawingRouteId: (id: string | null) => void;
  setEditingRouteId: (id: string | null) => void;
  setEditingShapeId: (id: string | null) => void;
  setEditingFlexZoneId: (id: string | null) => void;
  setEditingStopId: (id: string | null) => void;
  setEditingCalendarServiceId: (id: string | null) => void;
  setCreatingStop: (creating: boolean) => void;
  setMapStopFilter: (filter: { matched: string[] } | null) => void;
  setSnapToRoad: (v: boolean) => void;
  setLeftRailWidth: (w: number) => void;
  setRightRailOpen: (open: boolean) => void;
  setRightRailWidth: (w: number) => void;
  setRouteDetailTab: (tab: RouteDetailTab) => void;
  setStopDetailTab: (tab: StopDetailTab) => void;
  setCalendarDetailTab: (tab: CalendarDetailTab) => void;
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
  timetableSplitArrDep: false,
  selectedRouteId: null,
  selectedStopId: null,
  selectedTripId: null,
  drawingRouteId: null,
  editingRouteId: null,
  editingShapeId: null,
  editingFlexZoneId: null,
  editingStopId: null,
  editingCalendarServiceId: null,
  creatingStop: false,
  mapStopFilter: null,
  snapToRoad: true,
  hiddenRouteIds: [],
  hiddenRouteTypes: [],
  hiddenShapeIds: [],
  // Default width is set responsively in App init based on viewport — 96 for
  // medium screens, 260 for wide ones. The store falls back to 96 if it loads
  // before the responsive init runs.
  leftRailWidth: 96,
  rightRailOpen: false,
  rightRailWidth: 460,
  routeDetailTab: 'details',
  stopDetailTab: 'details',
  calendarDetailTab: 'details',
  routeDeleteConfirmId: null,
  toggleRouteVisibility: (routeId) => set((state) => {
    const idx = state.hiddenRouteIds.indexOf(routeId);
    if (idx === -1) state.hiddenRouteIds.push(routeId);
    else state.hiddenRouteIds.splice(idx, 1);
  }),
  toggleRouteType: (routeType) => set((state) => {
    const idx = state.hiddenRouteTypes.indexOf(routeType);
    if (idx === -1) state.hiddenRouteTypes.push(routeType);
    else state.hiddenRouteTypes.splice(idx, 1);
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
    // The stop edit / create sub-panels are contextual to the user's current
    // flow — switching nav sections discards them so the new section's body
    // renders.
    state.editingStopId = null;
    // Same logic as editingStopId: leaving Calendars discards the open detail.
    if (section !== 'calendar') state.editingCalendarServiceId = null;
    state.creatingStop = false;
    // Filter overlay on the map is only relevant while the Stops panel is
    // active; clear it when navigating elsewhere so other sections see the
    // full feed unmuted.
    if (section !== 'stops') state.mapStopFilter = null;
  }),
  setBottomPanelOpen: (open) => set((state) => { state.bottomPanelOpen = open; }),
  toggleBottomPanel: () => set((state) => { state.bottomPanelOpen = !state.bottomPanelOpen; }),
  setBottomPanelTab: (tab) => set((state) => { state.bottomPanelTab = tab; }),
  setMapMode: (mode) => set((state) => { state.mapMode = mode; }),
  setStopPlacementMode: (mode) => set((state) => { state.stopPlacementMode = mode; }),
  setStopPlacementDirection: (dir) => set((state) => { state.stopPlacementDirection = dir; }),
  setTimetableDirectionId: (dir) => set((state) => { state.timetableDirectionId = dir; }),
  setTimetableSplitArrDep: (v) => set((state) => { state.timetableSplitArrDep = v; }),
  selectRoute: (id) => set((state) => { state.selectedRouteId = id; }),
  selectStop: (id) => set((state) => { state.selectedStopId = id; }),
  selectTrip: (id) => set((state) => { state.selectedTripId = id; }),
  setDrawingRouteId: (id) => set((state) => { state.drawingRouteId = id; }),
  setEditingRouteId: (id) => set((state) => { state.editingRouteId = id; }),
  setEditingShapeId: (id) => set((state) => { state.editingShapeId = id; }),
  setEditingFlexZoneId: (id) => set((state) => { state.editingFlexZoneId = id; }),
  setEditingStopId: (id) => set((state) => {
    state.editingStopId = id;
    // Open each stop on its Details tab rather than wherever the last one left off.
    if (id) state.stopDetailTab = 'details';
  }),
  setEditingCalendarServiceId: (id) => set((state) => {
    state.editingCalendarServiceId = id;
    // Open each calendar on its Details tab rather than wherever the last one left off.
    if (id) state.calendarDetailTab = 'details';
  }),
  setCreatingStop: (creating) => set((state) => {
    state.creatingStop = creating;
    // Entering creating mode clears any open edit-stop sub-panel so the
    // user sees a fresh placement form, not someone else's properties.
    if (creating) state.editingStopId = null;
  }),
  setMapStopFilter: (filter) => set((state) => { state.mapStopFilter = filter; }),
  setSnapToRoad: (v) => set((state) => { state.snapToRoad = v; }),
  setLeftRailWidth: (w) => set((state) => { state.leftRailWidth = w; }),
  setRightRailOpen: (open) => set((state) => { state.rightRailOpen = open; }),
  setRightRailWidth: (w) => set((state) => { state.rightRailWidth = w; }),
  setRouteDetailTab: (tab) => set((state) => { state.routeDetailTab = tab; }),
  setStopDetailTab: (tab) => set((state) => { state.stopDetailTab = tab; }),
  setCalendarDetailTab: (tab) => set((state) => { state.calendarDetailTab = tab; }),
  setRouteDeleteConfirmId: (id) => set((state) => { state.routeDeleteConfirmId = id; }),
});
