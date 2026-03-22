import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../store';
import type { Agency, Calendar, CalendarDate, Route, Shape, ShapePoint, Stop, Trip, StopTime, FeedInfo, RouteStop, FareAttribute, FareRule } from '../types/gtfs';

function parseCSV<T>(text: string): T[] {
  const result = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
  return result.data as T[];
}

function num(v: any): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export async function importGtfsZip(file: File): Promise<{
  agencies: Agency[];
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  routes: Route[];
  shapes: Shape[];
  stops: Stop[];
  trips: Trip[];
  stopTimes: StopTime[];
  feedInfo: FeedInfo | null;
  routeStops: RouteStop[];
  fareAttributes: FareAttribute[];
  fareRules: FareRule[];
}> {
  const zip = await JSZip.loadAsync(file);

  const readFile = async (name: string): Promise<string | null> => {
    // Try both with and without folder prefix
    let entry = zip.file(name);
    if (!entry) {
      // Look in subdirectories
      const entries = zip.file(new RegExp(`${name}$`));
      entry = entries[0] || null;
    }
    if (!entry) return null;
    return await entry.async('string');
  };

  // Agency
  const agencyText = await readFile('agency.txt');
  const agencies: Agency[] = agencyText
    ? parseCSV<any>(agencyText).map((row) => ({
        agency_id: row.agency_id || '',
        agency_name: row.agency_name || '',
        agency_url: row.agency_url || '',
        agency_timezone: row.agency_timezone || 'America/New_York',
        agency_lang: row.agency_lang,
        agency_phone: row.agency_phone,
        agency_fare_url: row.agency_fare_url,
        agency_email: row.agency_email,
      }))
    : [];

  // Calendar
  const calendarText = await readFile('calendar.txt');
  const calendars: Calendar[] = calendarText
    ? parseCSV<any>(calendarText).map((row) => ({
        service_id: String(row.service_id),
        monday: (num(row.monday) as 0 | 1),
        tuesday: (num(row.tuesday) as 0 | 1),
        wednesday: (num(row.wednesday) as 0 | 1),
        thursday: (num(row.thursday) as 0 | 1),
        friday: (num(row.friday) as 0 | 1),
        saturday: (num(row.saturday) as 0 | 1),
        sunday: (num(row.sunday) as 0 | 1),
        start_date: String(row.start_date),
        end_date: String(row.end_date),
        _description: describeService(num(row.monday), num(row.tuesday), num(row.wednesday), num(row.thursday), num(row.friday), num(row.saturday), num(row.sunday)),
      }))
    : [];

  // Calendar dates
  const calDatesText = await readFile('calendar_dates.txt');
  const calendarDates: CalendarDate[] = calDatesText
    ? parseCSV<any>(calDatesText).map((row) => ({
        service_id: String(row.service_id),
        date: String(row.date),
        exception_type: num(row.exception_type) as 1 | 2,
      }))
    : [];

  // Routes
  const routesText = await readFile('routes.txt');
  const routes: Route[] = routesText
    ? parseCSV<any>(routesText).map((row) => ({
        route_id: String(row.route_id),
        agency_id: String(row.agency_id || agencies[0]?.agency_id || ''),
        route_short_name: row.route_short_name || '',
        route_long_name: row.route_long_name || '',
        route_desc: row.route_desc,
        route_type: num(row.route_type),
        route_url: row.route_url,
        route_color: (row.route_color || '888888').replace('#', ''),
        route_text_color: (row.route_text_color || 'FFFFFF').replace('#', ''),
      }))
    : [];

  // Shapes
  const shapesText = await readFile('shapes.txt');
  const shapesMap = new Map<string, ShapePoint[]>();
  if (shapesText) {
    const rows = parseCSV<any>(shapesText);
    for (const row of rows) {
      const id = String(row.shape_id);
      if (!shapesMap.has(id)) shapesMap.set(id, []);
      shapesMap.get(id)!.push({
        shape_pt_lat: num(row.shape_pt_lat),
        shape_pt_lon: num(row.shape_pt_lon),
        shape_pt_sequence: num(row.shape_pt_sequence),
        shape_dist_traveled: num(row.shape_dist_traveled),
      });
    }
  }
  const shapes: Shape[] = Array.from(shapesMap.entries()).map(([id, points]) => ({
    shape_id: id,
    points: points.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence),
  }));

  // Stops
  const stopsText = await readFile('stops.txt');
  const stops: Stop[] = stopsText
    ? parseCSV<any>(stopsText).map((row) => ({
        stop_id: String(row.stop_id),
        stop_code: row.stop_code || undefined,
        stop_name: row.stop_name || '',
        stop_desc: row.stop_desc || undefined,
        stop_lat: num(row.stop_lat),
        stop_lon: num(row.stop_lon),
        zone_id: row.zone_id || undefined,
        stop_url: row.stop_url || undefined,
        location_type: num(row.location_type),
        parent_station: row.parent_station || undefined,
        stop_timezone: row.stop_timezone || undefined,
        wheelchair_boarding: num(row.wheelchair_boarding),
      }))
    : [];

  // Trips
  const tripsText = await readFile('trips.txt');
  const trips: Trip[] = tripsText
    ? parseCSV<any>(tripsText).map((row) => ({
        trip_id: String(row.trip_id),
        route_id: String(row.route_id),
        service_id: String(row.service_id),
        trip_headsign: row.trip_headsign || undefined,
        trip_short_name: row.trip_short_name || undefined,
        direction_id: (num(row.direction_id) as 0 | 1),
        block_id: row.block_id ? String(row.block_id) : undefined,
        shape_id: row.shape_id ? String(row.shape_id) : undefined,
        wheelchair_accessible: row.wheelchair_accessible !== undefined ? num(row.wheelchair_accessible) : undefined,
      }))
    : [];

  // Stop times
  const stopTimesText = await readFile('stop_times.txt');
  const stopTimes: StopTime[] = stopTimesText
    ? parseCSV<any>(stopTimesText).map((row) => ({
        trip_id: String(row.trip_id),
        arrival_time: row.arrival_time || '',
        departure_time: row.departure_time || '',
        stop_id: String(row.stop_id),
        stop_sequence: num(row.stop_sequence),
        stop_headsign: row.stop_headsign || undefined,
        pickup_type: row.pickup_type !== undefined ? num(row.pickup_type) : undefined,
        drop_off_type: row.drop_off_type !== undefined ? num(row.drop_off_type) : undefined,
        shape_dist_traveled: row.shape_dist_traveled ? num(row.shape_dist_traveled) : undefined,
        timepoint: row.timepoint !== undefined ? (num(row.timepoint) as 0 | 1) : undefined,
      }))
    : [];

  // Feed info
  const feedInfoText = await readFile('feed_info.txt');
  let feedInfo: FeedInfo | null = null;
  if (feedInfoText) {
    const rows = parseCSV<any>(feedInfoText);
    if (rows[0]) {
      const r = rows[0];
      feedInfo = {
        feed_publisher_name: r.feed_publisher_name || '',
        feed_publisher_url: r.feed_publisher_url || '',
        feed_lang: r.feed_lang || 'en-US',
        default_lang: r.default_lang,
        feed_start_date: r.feed_start_date,
        feed_end_date: r.feed_end_date,
        feed_version: r.feed_version,
        feed_contact_email: r.feed_contact_email,
        feed_contact_url: r.feed_contact_url,
      };
    }
  }

  // Fare attributes
  const fareAttrText = await readFile('fare_attributes.txt');
  const fareAttributes: FareAttribute[] = fareAttrText
    ? parseCSV<any>(fareAttrText).map((row) => ({
        fare_id: String(row.fare_id),
        price: String(row.price),
        currency_type: String(row.currency_type || 'USD'),
        payment_method: num(row.payment_method) as 0 | 1,
        transfers: row.transfers === '' || row.transfers === undefined ? '' : (num(row.transfers) as 0 | 1 | 2),
        transfer_duration: row.transfer_duration ? num(row.transfer_duration) : undefined,
        agency_id: row.agency_id || undefined,
      }))
    : [];

  // Fare rules
  const fareRulesText = await readFile('fare_rules.txt');
  const fareRules: FareRule[] = fareRulesText
    ? parseCSV<any>(fareRulesText).map((row) => ({
        fare_id: String(row.fare_id),
        route_id: row.route_id || undefined,
        origin_id: row.origin_id || undefined,
        destination_id: row.destination_id || undefined,
        contains_id: row.contains_id || undefined,
      }))
    : [];

  // Build routeStops from stop_times: for each route, find unique stops in order
  const routeStops: RouteStop[] = [];
  const routeStopSet = new Set<string>();
  for (const route of routes) {
    const routeTrips = trips.filter((t) => t.route_id === route.route_id);
    for (const dir of [0, 1] as const) {
      const dirTrips = routeTrips.filter((t) => t.direction_id === dir);
      if (dirTrips.length === 0) continue;
      // Use the first trip's stop_times as the canonical order
      const firstTrip = dirTrips[0];
      const tripStopTimes = stopTimes
        .filter((st) => st.trip_id === firstTrip.trip_id)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      for (const st of tripStopTimes) {
        const key = `${route.route_id}-${st.stop_id}-${dir}`;
        if (!routeStopSet.has(key)) {
          routeStopSet.add(key);
          routeStops.push({
            route_id: route.route_id,
            stop_id: st.stop_id,
            direction_id: dir,
            stop_sequence: st.stop_sequence,
            _snapped: true,
          });
        }
      }
    }
  }

  return { agencies, calendars, calendarDates, routes, shapes, stops, trips, stopTimes, feedInfo, routeStops, fareAttributes, fareRules };
}

function describeService(...days: number[]): string {
  const [m, t, w, th, f, sa, su] = days;
  if (m && t && w && th && f && !sa && !su) return 'Weekdays';
  if (!m && !t && !w && !th && !f && sa && su) return 'Weekends';
  if (m && t && w && th && f && sa && su) return 'Daily';
  if (!m && !t && !w && !th && !f && sa && !su) return 'Saturday Only';
  if (!m && !t && !w && !th && !f && !sa && su) return 'Sunday Only';
  return 'Custom';
}

export function loadImportIntoStore(data: Awaited<ReturnType<typeof importGtfsZip>>) {
  const store = useStore.getState();
  store.setAgencies(data.agencies);
  store.setCalendars(data.calendars);
  store.setCalendarDates(data.calendarDates);
  store.setRoutes(data.routes);
  store.setShapes(data.shapes);
  store.setStops(data.stops);
  store.setTrips(data.trips);
  store.setStopTimes(data.stopTimes);
  store.setFeedInfo(data.feedInfo);
  store.setRouteStops(data.routeStops);
  store.setFareAttributes(data.fareAttributes);
  store.setFareRules(data.fareRules);
}
