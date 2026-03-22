export interface Agency {
  agency_id: string;
  agency_name: string;
  agency_url: string;
  agency_timezone: string;
  agency_lang?: string;
  agency_phone?: string;
  agency_fare_url?: string;
  agency_email?: string;
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
  start_date: string; // YYYYMMDD
  end_date: string;   // YYYYMMDD
  _description?: string; // UI-only
}

export interface CalendarDate {
  service_id: string;
  date: string;           // YYYYMMDD
  exception_type: 1 | 2;  // 1=added, 2=removed
}

export interface Route {
  route_id: string;
  agency_id: string;
  route_short_name: string;
  route_long_name: string;
  route_desc?: string;
  route_type: number;
  route_url?: string;
  route_color: string;      // 6-char hex without #
  route_text_color: string;  // 6-char hex without #
}

export interface ShapePoint {
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
  shape_dist_traveled: number;
}

export interface Shape {
  shape_id: string;
  points: ShapePoint[];
}

export interface Stop {
  stop_id: string;
  stop_code?: string;
  stop_name: string;
  stop_desc?: string;
  stop_lat: number;
  stop_lon: number;
  zone_id?: string;
  stop_url?: string;
  location_type: number;
  parent_station?: string;
  stop_timezone?: string;
  wheelchair_boarding: number;
}

export interface Trip {
  trip_id: string;
  route_id: string;
  service_id: string;
  trip_headsign?: string;
  trip_short_name?: string;
  direction_id: 0 | 1;
  block_id?: string;
  shape_id?: string;
  wheelchair_accessible?: number;
}

export interface StopTime {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: number;
  stop_headsign?: string;
  pickup_type?: number;
  drop_off_type?: number;
  shape_dist_traveled?: number;
  timepoint?: 0 | 1;
}

export interface FeedInfo {
  feed_publisher_name: string;
  feed_publisher_url: string;
  feed_lang: string;
  default_lang?: string;
  feed_start_date?: string;
  feed_end_date?: string;
  feed_version?: string;
  feed_contact_email?: string;
  feed_contact_url?: string;
}

export interface FareAttribute {
  fare_id: string;
  price: string;
  currency_type: string;
  payment_method: 0 | 1;       // 0=on board, 1=before boarding
  transfers: 0 | 1 | 2 | '';   // ''=unlimited
  transfer_duration?: number;   // seconds
  agency_id?: string;
}

export interface FareRule {
  fare_id: string;
  route_id?: string;
  origin_id?: string;
  destination_id?: string;
  contains_id?: string;
}

export interface RouteStop {
  route_id: string;
  stop_id: string;
  direction_id: 0 | 1;
  stop_sequence: number;
  _snapped: boolean;
}
