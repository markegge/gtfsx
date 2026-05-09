// Subset of the editor state we read for embed rendering. Mirrors the
// shape stored in feed_version state.json.gz blobs (see
// `src/db/serverPersistence.ts:DATA_KEYS`). Keep field names lowercase
// snake_case to match GTFS / `src/types/gtfs.ts`.

export interface Agency {
  agency_id: string;
  agency_name: string;
  agency_url?: string;
  agency_timezone: string;
  agency_lang?: string;
  agency_phone?: string;
}

export interface Calendar {
  service_id: string;
  monday: 0 | 1;
  tuesday: 0 | 1;
  wednesday: 0 | 1;
  thursday: 0 | 1;
  friday: 0 | 1;
  saturday: 0 | 1;
  sunday: 0 | 1;
  start_date: string;
  end_date: string;
}

export interface CalendarDate {
  service_id: string;
  date: string;
  exception_type: 1 | 2;
}

export interface Route {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_desc?: string;
  route_type: number;
  route_color: string;
  route_text_color: string;
  _direction_0_name?: string;
  _direction_1_name?: string;
}

export interface ShapePoint {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
}

export interface Shape {
  shape_id: string;
  points: ShapePoint[];
}

export interface Stop {
  stop_id: string;
  stop_code?: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  location_type?: number;
  wheelchair_boarding?: number;
}

export interface Trip {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign?: string;
  direction_id: 0 | 1;
  shape_id?: string;
}

export interface StopTime {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: number;
  pickup_type?: number;
  drop_off_type?: number;
}

export interface FeedInfo {
  feed_publisher_name?: string;
  feed_publisher_url?: string;
  feed_lang?: string;
  feed_start_date?: string;
  feed_end_date?: string;
  feed_contact_email?: string;
}

export interface FeedState {
  agencies: Agency[];
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  routes: Route[];
  stops: Stop[];
  trips: Trip[];
  stopTimes: StopTime[];
  shapes: Shape[];
  feedInfo: FeedInfo | null;
}

export interface LoadedEmbedFeed {
  slug: string;
  projectId: string;
  versionId: string;
  publishedAt: number;
  projectName: string;
  // 6-char hex (no leading #) or null. Drives the embed accent CSS var.
  brandPrimaryColor: string | null;
  // Public URL for the owning org's brand logo (resolves on FEEDS_ORIGIN).
  // Null when the project is user-owned or the org has no logo.
  brandLogoUrl: string | null;
  state: FeedState;
}
