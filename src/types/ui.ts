export type SidebarSection =
  | 'agency'
  | 'calendar'
  | 'routes'
  | 'stops'
  | 'stations'
  | 'frequencies'
  | 'blocks'
  | 'fares'
  | 'flex'
  | 'costs'
  | 'coverage'
  | 'titlevi'
  | 'stop-analysis'
  | 'alerts'
  | 'settings';

/**
 * Contextual map highlight driven by the Stop Analysis panel. `balancing` and
 * `accessibility` highlight a stop-id set; `intensity` colours stops on a
 * trips/day ramp (maxTrips sets the ramp ceiling). null = no overlay.
 */
export type StopAnalysisOverlay =
  | { kind: 'balancing'; stopIds: string[] }
  | { kind: 'accessibility'; stopIds: string[] }
  | { kind: 'intensity'; trips: Record<string, number>; maxTrips: number };

export type BottomPanelTab =
  | 'timetable'
  | 'blocks'
  | 'service-summary'
  | 'validation'
  | 'snapshots'
  | 'publish'
  | 'embed'
  | 'audit';

export type MapMode =
  | 'select'
  | 'draw_route'
  | 'place_stop'
  | 'move_stop'
  | 'edit_vertices'
  | 'edit_shape'
  | 'trim_shape'
  | 'draw_flex_zone'
  | 'edit_flex_zone'
  | 'draw_fare_zone'
  | 'select_stops_polygon';

export type StopPlacementMode = 'snap_to_route' | 'freehand';

export type RouteDetailTab = 'details' | 'stops' | 'trips' | 'shapes' | 'costs';

export type StopDetailTab = 'details' | 'trips' | 'coverage';

export type CalendarDetailTab = 'details' | 'routes' | 'exceptions';

/**
 * Stable id for an auto-applicable validation fix. A message carries only the
 * id; the human label, description, and the `apply` mutation live in the fix
 * registry (services/validationFixes.ts) so this types module stays free of any
 * store import. Grow the one-click "Fix" catalog by adding an id here and
 * registering it in that registry.
 */
export type ValidationFixId = 'fill-trip-edge-times';

export interface ValidationMessage {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  entity_type?: string;
  entity_id?: string;
  field?: string;
  /**
   * Stable rule code identifying the validation RULE that emitted this message
   * (unlike `id`, which is a per-run sequential index). Shared by every message
   * a rule produces, so a rule can be dismissed feed-wide by code. Only set on
   * rules that opt into being dismissible (see VALIDATION_CODES in
   * services/validation.ts). Absent → the message is not dismissible.
   */
  code?: string;
  /**
   * Optional one-click auto-fix descriptor. When present, the validation panel
   * renders a "Fix" button that looks the id up in the fix registry
   * (services/validationFixes.ts) and applies the store mutation that resolves
   * the issue (with undo). Absent → the issue is manual-only.
   */
  fix?: { id: ValidationFixId };
}
