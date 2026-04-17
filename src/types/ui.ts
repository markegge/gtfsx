export type SidebarSection =
  | 'agency'
  | 'calendar'
  | 'routes'
  | 'stops'
  | 'fares'
  | 'timetable'
  | 'flex'
  | 'costs'
  | 'coverage'
  | 'titlevi';

export type BottomPanelTab = 'timetable' | 'stops' | 'service-summary' | 'validation' | 'versions';

export type MapMode =
  | 'select'
  | 'draw_route'
  | 'place_stop'
  | 'move_stop'
  | 'edit_vertices'
  | 'edit_shape'
  | 'draw_flex_zone'
  | 'edit_flex_zone';

export type StopPlacementMode = 'snap_to_route' | 'freehand';

export interface ValidationMessage {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  entity_type?: string;
  entity_id?: string;
  field?: string;
}
