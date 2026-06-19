import type { StateCreator } from 'zustand';
import type { SidebarSection, BottomPanelTab, MapMode, StopPlacementMode, RouteDetailTab, StopDetailTab, CalendarDetailTab, StopAnalysisOverlay } from '../types/ui';

export interface UISlice {
  sidebarSection: SidebarSection | null;
  bottomPanelOpen: boolean;
  /** When true, the bottom panel expands to fill the whole editor area (the map
   *  row collapses) so the timetable / blocking Gantt gets full height. Toggled
   *  by the maximize button on the panel header. */
  bottomPanelMaximized: boolean;
  bottomPanelTab: BottomPanelTab;
  mapMode: MapMode;
  stopPlacementMode: StopPlacementMode;
  stopPlacementDirection: 0 | 1;
  // Shape the next placed stop attaches to (per-shape route stops). null = let
  // snap-to-route pick the nearest shape, or fall back to direction.
  stopPlacementShapeId: string | null;
  // The shape selected in the Stops sub-panel (store-backed so "Edit Stops" on
  // a shape row can focus it, even for same-direction branches). Stale ids fall
  // back to the first pattern.
  stopsPanelShapeId: string | null;
  /** Optional override name for the NEXT stop placed via the Add Stop tool.
   * Cleared after a single placement so each stop can have its own name (or
   * fall back to the auto-suggested intersection name). */
  nextStopName: string | null;
  timetableDirectionId: 0 | 1;
  /** Calendar (service pattern) currently selected in the timetable's service
   *  dropdown. Lives in the store rather than local component state so cross-
   *  panel handlers (e.g. Calendars > Routes > "View timetable") can switch
   *  the timetable to the calendar the user just clicked from. null = fall
   *  back to the first calendar in the feed. */
  timetableServiceId: string | null;
  /** Trip-pattern (shape_id) currently selected in the timetable. When set,
   *  the timetable filters trips to those with this shape — used for routes
   *  with 3+ patterns where the legacy direction-only toggle can't tell
   *  same-direction patterns apart. null = filter by direction only (the
   *  ≤2-pattern path). */
  timetableShapeId: string | null;
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
  // When true, the in-progress draw creates a new route on finish (the default
  // from the Draw Route tool). When false, the shape attaches to drawingRouteId.
  drawingNewRoute: boolean;
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
  /** Contextual map overlay set by the Stop Analysis panel; cleared when the
   *  user leaves the Stop Analysis section. */
  stopAnalysisOverlay: StopAnalysisOverlay | null;
  /** Shape id the user wants to enter edit mode on, set by a component
   *  outside RouteShapesTab (e.g. the RoutePopup "Edit Shape" button).
   *  RouteShapesTab watches this on mount / change, dispatches its
   *  existing handleEditShape (which runs the dense-shape warning), then
   *  clears it. */
  pendingShapeEditId: string | null;
  /** Holiday names checked in the Calendars > Exceptions "Add US holidays"
   *  picker. Persisted in-memory across calendars within a session so the
   *  user doesn't re-check the same boxes per calendar — defaults to the
   *  six big federal holidays transit typically skips. Resets on page
   *  reload (intentionally session-scoped, not durable). */
  selectedHolidayNames: string[];
  routeDeleteConfirmId: string | null;
  toggleRouteVisibility: (routeId: string) => void;
  setHiddenRouteIds: (ids: string[]) => void;
  toggleRouteType: (routeType: number) => void;
  toggleShapeVisibility: (shapeId: string) => void;
  setSidebarSection: (section: SidebarSection | null) => void;
  setBottomPanelOpen: (open: boolean) => void;
  setBottomPanelMaximized: (v: boolean) => void;
  toggleBottomPanelMaximized: () => void;
  toggleBottomPanel: () => void;
  setBottomPanelTab: (tab: BottomPanelTab) => void;
  setMapMode: (mode: MapMode) => void;
  setStopPlacementMode: (mode: StopPlacementMode) => void;
  setStopPlacementDirection: (dir: 0 | 1) => void;
  setStopPlacementShapeId: (id: string | null) => void;
  setStopsPanelShapeId: (id: string | null) => void;
  setNextStopName: (name: string | null) => void;
  setTimetableDirectionId: (dir: 0 | 1) => void;
  setTimetableServiceId: (id: string | null) => void;
  setTimetableShapeId: (id: string | null) => void;
  setTimetableSplitArrDep: (v: boolean) => void;
  selectRoute: (id: string | null) => void;
  selectStop: (id: string | null) => void;
  selectTrip: (id: string | null) => void;
  setDrawingRouteId: (id: string | null) => void;
  setDrawingNewRoute: (v: boolean) => void;
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
  setStopAnalysisOverlay: (overlay: StopAnalysisOverlay | null) => void;
  setPendingShapeEditId: (id: string | null) => void;
  setSelectedHolidayNames: (names: string[]) => void;
  setRouteDeleteConfirmId: (id: string | null) => void;
}

export const createUISlice: StateCreator<UISlice, [['zustand/immer', never]], [], UISlice> = (set) => ({
  sidebarSection: null,
  bottomPanelOpen: false,
  bottomPanelMaximized: false,
  bottomPanelTab: 'timetable',
  mapMode: 'select',
  stopPlacementMode: 'snap_to_route',
  stopPlacementDirection: 0,
  stopPlacementShapeId: null,
  stopsPanelShapeId: null,
  nextStopName: null,
  timetableDirectionId: 0,
  timetableServiceId: null,
  timetableShapeId: null,
  timetableSplitArrDep: false,
  selectedRouteId: null,
  selectedStopId: null,
  selectedTripId: null,
  drawingRouteId: null,
  drawingNewRoute: false,
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
  stopAnalysisOverlay: null,
  pendingShapeEditId: null,
  // Six federal holidays transit typically suspends service on — kept in sync
  // with the US_HOLIDAYS catalog names in CalendarEditor.tsx.
  selectedHolidayNames: [
    "New Year's Day",
    'Memorial Day',
    'Independence Day',
    'Labor Day',
    'Thanksgiving',
    'Christmas Day',
  ],
  routeDeleteConfirmId: null,
  toggleRouteVisibility: (routeId) => set((state) => {
    const idx = state.hiddenRouteIds.indexOf(routeId);
    if (idx === -1) state.hiddenRouteIds.push(routeId);
    else state.hiddenRouteIds.splice(idx, 1);
  }),
  setHiddenRouteIds: (ids) => set((state) => { state.hiddenRouteIds = ids; }),
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
    // trim_shape can be cleared immediately — no in-progress state to lose.
    if (section !== 'routes' && state.mapMode === 'trim_shape') {
      state.mapMode = 'select';
      state.editingShapeId = null;
    }
    // edit_shape DELIBERATELY survives rail/section changes — Save / Cancel
    // are anchored on the map (MapView, next to the Editing banner) so the
    // user can close the rail, switch tabs, then come back. The earlier
    // "auto-discard on leave" + "queue confirm dialog" pendingNav scheme
    // was punishing the user for normal navigation.
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
    // The Stop Analysis map overlay is scoped to its section — drop it on the
    // way out so balancing/intensity/accessibility highlights don't linger.
    if (section !== 'stop-analysis') state.stopAnalysisOverlay = null;
  }),
  setBottomPanelOpen: (open) => set((state) => { state.bottomPanelOpen = open; }),
  setBottomPanelMaximized: (v) => set((state) => { state.bottomPanelMaximized = v; }),
  toggleBottomPanelMaximized: () => set((state) => {
    state.bottomPanelMaximized = !state.bottomPanelMaximized;
    // Maximizing only makes sense with the panel open.
    if (state.bottomPanelMaximized) state.bottomPanelOpen = true;
  }),
  toggleBottomPanel: () => set((state) => { state.bottomPanelOpen = !state.bottomPanelOpen; }),
  setBottomPanelTab: (tab) => set((state) => { state.bottomPanelTab = tab; }),
  setMapMode: (mode) => set((state) => { state.mapMode = mode; }),
  setStopPlacementMode: (mode) => set((state) => { state.stopPlacementMode = mode; }),
  setStopPlacementDirection: (dir) => set((state) => { state.stopPlacementDirection = dir; }),
  setStopPlacementShapeId: (id) => set((state) => { state.stopPlacementShapeId = id; }),
  setStopsPanelShapeId: (id) => set((state) => { state.stopsPanelShapeId = id; }),
  setNextStopName: (name) => set((state) => { state.nextStopName = name; }),
  setTimetableDirectionId: (dir) => set((state) => { state.timetableDirectionId = dir; }),
  setTimetableServiceId: (id) => set((state) => { state.timetableServiceId = id; }),
  setTimetableShapeId: (id) => set((state) => { state.timetableShapeId = id; }),
  setTimetableSplitArrDep: (v) => set((state) => { state.timetableSplitArrDep = v; }),
  selectRoute: (id) => set((state) => { state.selectedRouteId = id; }),
  selectStop: (id) => set((state) => { state.selectedStopId = id; }),
  selectTrip: (id) => set((state) => { state.selectedTripId = id; }),
  setDrawingRouteId: (id) => set((state) => { state.drawingRouteId = id; }),
  setDrawingNewRoute: (v) => set((state) => { state.drawingNewRoute = v; }),
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
  setRouteDetailTab: (tab) => set((state) => {
    state.routeDetailTab = tab;
    // trim_shape can be cleared immediately on tab change — no in-progress
    // state. edit_shape stays alive across tab changes because Save / Cancel
    // are anchored on the map; the user can switch tabs freely.
    if (tab !== 'shapes' && state.mapMode === 'trim_shape') {
      state.mapMode = 'select';
      state.editingShapeId = null;
    }
  }),
  setPendingShapeEditId: (id) => set((state) => { state.pendingShapeEditId = id; }),
  setStopDetailTab: (tab) => set((state) => { state.stopDetailTab = tab; }),
  setCalendarDetailTab: (tab) => set((state) => { state.calendarDetailTab = tab; }),
  setStopAnalysisOverlay: (overlay) => set((state) => { state.stopAnalysisOverlay = overlay; }),
  setSelectedHolidayNames: (names) => set((state) => { state.selectedHolidayNames = names; }),
  setRouteDeleteConfirmId: (id) => set((state) => { state.routeDeleteConfirmId = id; }),
});
