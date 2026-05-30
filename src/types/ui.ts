export type SidebarSection =
  | 'agency'
  | 'calendar'
  | 'routes'
  | 'stops'
  | 'fares'
  | 'flex'
  | 'costs'
  | 'coverage'
  | 'titlevi'
  | 'stop-analysis'
  | 'alerts';

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
  | 'edit_flex_zone';

export type StopPlacementMode = 'snap_to_route' | 'freehand';

export type RouteDetailTab = 'details' | 'stops' | 'trips' | 'shapes' | 'costs';

export type StopDetailTab = 'details' | 'trips' | 'coverage';

export type CalendarDetailTab = 'details' | 'routes' | 'exceptions';

export interface ValidationMessage {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  entity_type?: string;
  entity_id?: string;
  field?: string;
}
