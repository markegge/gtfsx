export type SidebarSection =
  | 'agency'
  | 'calendar'
  | 'routes'
  | 'stops'
  | 'fares'
  | 'flex'
  | 'costs'
  | 'coverage'
  | 'titlevi';

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

/** A navigation request the user made while a shape edit was in progress.
 *  Stashed in the store so the confirm-discard dialog can replay it after
 *  the user chooses Discard (or drop it on Keep editing). */
export type PendingNav =
  | { kind: 'tab'; tab: RouteDetailTab }
  | { kind: 'section'; section: SidebarSection | null };

export type StopDetailTab = 'details' | 'trips';

export type CalendarDetailTab = 'details' | 'routes' | 'exceptions';

export interface ValidationMessage {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  entity_type?: string;
  entity_id?: string;
  field?: string;
}
