export type SidebarSection =
  | 'agency'
  | 'calendar'
  | 'routes'
  | 'stops'
  | 'fares'
  | 'timetable'
  | 'flex'
  | 'costs'
  | 'coverage';

export type BottomPanelTab = 'timetable' | 'validation';

export type MapMode =
  | 'select'
  | 'draw_route'
  | 'place_stop'
  | 'edit_vertices'
  | 'edit_shape';

export type StopPlacementMode = 'snap_to_route' | 'freehand';

export interface ValidationMessage {
  id: string;
  severity: 'error' | 'warning';
  message: string;
  entity_type?: string;
  entity_id?: string;
  field?: string;
}
