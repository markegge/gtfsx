import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../store';
import type { Agency, Calendar, CalendarDate, Route, Shape, ShapePoint, Stop, Trip, StopTime, FeedInfo, RouteStop, FareAttribute, FareRule } from '../types/gtfs';
import type { FlexZone, BookingRule } from '../store/flexSlice';

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
  flexZones: FlexZone[];
  warnings: string[];
}> {
  const zip = await JSZip.loadAsync(file);

  // Detect if files are nested inside a subfolder
  const warnings: string[] = [];
  const hasRootAgency = !!zip.file('agency.txt');
  const hasRootRoutes = !!zip.file('routes.txt');
  if (!hasRootAgency && !hasRootRoutes) {
    const nestedAgency = zip.file(/agency\.txt$/);
    const nestedRoutes = zip.file(/routes\.txt$/);
    if (nestedAgency.length > 0 || nestedRoutes.length > 0) {
      const path = (nestedAgency[0] || nestedRoutes[0]).name;
      const folder = path.split('/').slice(0, -1).join('/');
      warnings.push(`Feed files are inside a subfolder "${folder}/" in the ZIP. GTFS files should be at the root of the archive. This has been handled automatically and will be corrected on export.`);
    }
  }

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

  // Stop times. A flex stop_time has a location_id instead of a stop_id;
  // we split those out so they can feed back into FlexZone metadata (and
  // don't pollute the fixed-route stop_times table).
  const stopTimesText = await readFile('stop_times.txt');
  const stopTimesAll = stopTimesText ? parseCSV<any>(stopTimesText) : [];
  const flexStopTimeRows: any[] = [];
  const stopTimes: StopTime[] = [];
  for (const row of stopTimesAll) {
    if (row.location_id && !row.stop_id) {
      flexStopTimeRows.push(row);
      continue;
    }
    stopTimes.push({
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
    });
  }
  const flexTripIds = new Set<string>(flexStopTimeRows.map((r) => String(r.trip_id)));

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

  // directions.txt (non-standard but widely supported)
  const directionsText = await readFile('directions.txt');
  if (directionsText) {
    const dirRows = parseCSV<any>(directionsText);
    for (const row of dirRows) {
      const route = routes.find((r) => r.route_id === String(row.route_id));
      if (!route) continue;
      const dir = num(row.direction_id);
      if (dir === 0) route._direction_0_name = row.direction || undefined;
      else if (dir === 1) route._direction_1_name = row.direction || undefined;
    }
  } else {
    // Fallback: populate direction names from trip_headsign values
    for (const route of routes) {
      const routeTrips = trips.filter((t) => t.route_id === route.route_id);
      const dir0Trip = routeTrips.find((t) => t.direction_id === 0 && t.trip_headsign);
      const dir1Trip = routeTrips.find((t) => t.direction_id === 1 && t.trip_headsign);
      if (dir0Trip?.trip_headsign) route._direction_0_name = dir0Trip.trip_headsign;
      if (dir1Trip?.trip_headsign) route._direction_1_name = dir1Trip.trip_headsign;
    }
  }

  // ─── GTFS-Flex: locations.geojson + booking_rules.txt ────────────────────

  /**
   * Key a flex location_id back to a zone_id. The export writes features
   * as `${zoneId}-${featureIndex}` (single-digit in practice), so stripping
   * a trailing `-0..9` recovers the zone id.
   */
  const zoneIdFromLocationId = (loc: string): string => loc.replace(/-\d+$/, '');

  // booking_rules.txt → id → BookingRule
  const bookingRulesText = await readFile('booking_rules.txt');
  const bookingRuleMap = new Map<string, BookingRule>();
  if (bookingRulesText) {
    for (const row of parseCSV<any>(bookingRulesText)) {
      const id = String(row.booking_rule_id || '');
      if (!id) continue;
      bookingRuleMap.set(id, {
        bookingType: (num(row.booking_type) as 0 | 1 | 2),
        priorNoticeDurationMin: row.prior_notice_duration_min ? num(row.prior_notice_duration_min) : undefined,
        priorNoticeDurationMax: row.prior_notice_duration_max ? num(row.prior_notice_duration_max) : undefined,
        priorNoticeLastDay: row.prior_notice_last_day ? num(row.prior_notice_last_day) : undefined,
        priorNoticeLastTime: row.prior_notice_last_time || undefined,
        priorNoticeStartDay: row.prior_notice_start_day ? num(row.prior_notice_start_day) : undefined,
        priorNoticeStartTime: row.prior_notice_start_time || undefined,
        message: row.message || undefined,
        pickupMessage: row.pickup_message || undefined,
        dropOffMessage: row.drop_off_message || undefined,
        phoneNumber: row.phone_number || undefined,
        infoUrl: row.info_url || undefined,
        bookingUrl: row.booking_url || undefined,
      });
    }
  }

  // locations.geojson → FlexZone[]
  const locationsText = await readFile('locations.geojson');
  const flexZones: FlexZone[] = [];
  if (locationsText) {
    try {
      const geo = JSON.parse(locationsText) as GeoJSON.FeatureCollection;
      // Group features by zone id (location_id prefix before the -N suffix)
      const byZone = new Map<string, GeoJSON.Feature[]>();
      for (const f of geo.features || []) {
        const locId = String(f.properties?.stop_id || f.properties?.id || '');
        if (!locId) continue;
        const zoneId = zoneIdFromLocationId(locId);
        const list = byZone.get(zoneId) || [];
        list.push(f);
        byZone.set(zoneId, list);
      }
      // Build one FlexZone per group.
      for (const [zoneId, features] of byZone) {
        const first = features[0];
        const props = (first.properties || {}) as Record<string, any>;
        const bookingId = props.pickup_booking_rule_id || props.drop_off_booking_rule_id;
        const bookingRule = bookingId ? bookingRuleMap.get(String(bookingId)) : undefined;

        // Find pickup/drop-off windows from the flex stop_times rows
        // referencing any of this zone's location_ids.
        const myLocIds = new Set(features.map((f) => String(f.properties?.stop_id || '')));
        const flexRow = flexStopTimeRows.find((r) => myLocIds.has(String(r.location_id)));
        const pickupStart = flexRow?.start_pickup_drop_off_window || props.start_pickup_drop_off_window;
        const pickupEnd = flexRow?.end_pickup_drop_off_window || props.end_pickup_drop_off_window;

        // Figure out this zone's trip and route (via stop_times.trip_id →
        // trips.route_id) and its service_id — so re-export preserves the
        // same route association and service pattern.
        let routeId: string | undefined;
        let serviceId: string | undefined;
        if (flexRow) {
          const trip = trips.find((t) => t.trip_id === String(flexRow.trip_id));
          if (trip) {
            routeId = trip.route_id;
            serviceId = trip.service_id;
          }
        }

        flexZones.push({
          id: zoneId,
          name: props.stop_name || zoneId,
          bufferMiles: 0,
          geojson: { type: 'FeatureCollection', features },
          bookingRule,
          pickupWindowStart: pickupStart || undefined,
          pickupWindowEnd: pickupEnd || undefined,
          serviceId,
          routeId,
        });
      }
    } catch (e) {
      warnings.push(`Could not parse locations.geojson: ${(e as Error).message}`);
    }
  }

  // Strip the synthetic flex trips from trips[] so re-exporting doesn't
  // create a duplicate (materializeFlex regenerates them from the zones).
  const flexZoneRouteIds = new Set(flexZones.map((z) => z.routeId).filter(Boolean) as string[]);
  const tripsWithoutFlex = trips.filter((t) => !flexTripIds.has(t.trip_id));
  // Remove routes that ONLY existed to carry flex trips. If a route lost all
  // of its trips AND belongs to a flex zone, drop it — the zone re-creates
  // it on the next export.
  const routesWithoutFlex = routes.filter((r) => {
    if (!flexZoneRouteIds.has(r.route_id)) return true;
    const remainingTrips = tripsWithoutFlex.filter((t) => t.route_id === r.route_id);
    return remainingTrips.length > 0;
  });
  // Re-point flex zones that lost their route to the kept route (if any).
  for (const zone of flexZones) {
    if (zone.routeId && !routesWithoutFlex.some((r) => r.route_id === zone.routeId)) {
      zone.routeId = undefined;
    }
  }

  return {
    agencies, calendars, calendarDates,
    routes: routesWithoutFlex, shapes, stops,
    trips: tripsWithoutFlex, stopTimes, feedInfo,
    routeStops, fareAttributes, fareRules,
    flexZones, warnings,
  };
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
  store.setFlexZones(data.flexZones);
}

/**
 * Merge selected routes (and their associated stops, trips, stop times, shapes,
 * calendars, and route-stop associations) from an imported feed into the
 * existing project. Agency info and fares are NOT imported.
 * If any IDs conflict with existing ones, a numeric prefix is applied to all
 * imported IDs to guarantee uniqueness.
 */
export function mergeImportIntoStore(
  data: Awaited<ReturnType<typeof importGtfsZip>>,
  selectedRouteIds: Set<string>,
) {
  const store = useStore.getState();

  // Determine whether we need a prefix to avoid ID collisions
  const existingRouteIds = new Set(store.routes.map((r) => r.route_id));
  const existingStopIds  = new Set(store.stops.map((s) => s.stop_id));
  const existingTripIds  = new Set(store.trips.map((t) => t.trip_id));
  const existingShapeIds = new Set(store.shapes.map((s) => s.shape_id));

  const hasConflict =
    data.routes.some((r) => existingRouteIds.has(r.route_id)) ||
    data.stops.some((s)  => existingStopIds.has(s.stop_id))   ||
    data.trips.some((t)  => existingTripIds.has(t.trip_id))   ||
    data.shapes.some((s) => existingShapeIds.has(s.shape_id));

  let prefix = '';
  if (hasConflict) {
    for (let i = 2; i <= 99; i++) {
      const p = `i${i}_`;
      if (!data.routes.some((r) => existingRouteIds.has(p + r.route_id))) {
        prefix = p;
        break;
      }
    }
    if (!prefix) prefix = `imp${Date.now()}_`;
  }

  const pfx = (id: string) => (prefix ? prefix + id : id);

  // Build calendar service_id remap: match imported calendars to existing ones
  // by day-of-week pattern (the 7 boolean fields)
  const calendarDayKey = (c: { monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number }) =>
    `${c.monday}${c.tuesday}${c.wednesday}${c.thursday}${c.friday}${c.saturday}${c.sunday}`;

  const existingCalByPattern = new Map<string, string>();
  for (const c of store.calendars) {
    existingCalByPattern.set(calendarDayKey(c), c.service_id);
  }

  const serviceIdRemap = new Map<string, string>();
  for (const c of data.calendars) {
    const pattern = calendarDayKey(c);
    const existingId = existingCalByPattern.get(pattern);
    if (existingId) {
      serviceIdRemap.set(c.service_id, existingId);
    }
  }

  const remapServiceId = (id: string) => serviceIdRemap.get(id) ?? id;

  // Build stop remap: match imported stops to existing stops by name + location
  const stopIdRemap = new Map<string, string>();
  for (const importedStop of data.stops) {
    for (const existingStop of store.stops) {
      const sameName = existingStop.stop_name === importedStop.stop_name;
      const sameLat = Math.abs(existingStop.stop_lat - importedStop.stop_lat) < 0.0001;
      const sameLon = Math.abs(existingStop.stop_lon - importedStop.stop_lon) < 0.0001;
      if (sameName && sameLat && sameLon) {
        stopIdRemap.set(importedStop.stop_id, existingStop.stop_id);
        break;
      }
    }
  }

  const remapStopId = (id: string) => stopIdRemap.get(id) ?? pfx(id);

  // Narrow to selected routes and their dependent data
  const selectedRoutes    = data.routes.filter((r) => selectedRouteIds.has(r.route_id));
  const selRouteGtfsIds   = new Set(selectedRoutes.map((r) => r.route_id));

  const selectedTrips     = data.trips.filter((t) => selRouteGtfsIds.has(t.route_id));
  const selTripGtfsIds    = new Set(selectedTrips.map((t) => t.trip_id));

  const selectedStopTimes = data.stopTimes.filter((st) => selTripGtfsIds.has(st.trip_id));

  const neededStopIds = new Set([
    ...selectedStopTimes.map((st) => st.stop_id),
    ...data.routeStops.filter((rs) => selRouteGtfsIds.has(rs.route_id)).map((rs) => rs.stop_id),
  ]);
  // Only import stops that aren't remapped to existing ones
  const selectedStops = data.stops.filter(
    (s) => neededStopIds.has(s.stop_id) && !stopIdRemap.has(s.stop_id)
  );

  const neededShapeIds = new Set(
    selectedTrips.map((t) => t.shape_id).filter(Boolean) as string[],
  );
  const selectedShapes     = data.shapes.filter((s) => neededShapeIds.has(s.shape_id));
  const selectedRouteStops = data.routeStops.filter((rs) => selRouteGtfsIds.has(rs.route_id));

  // Append routes
  for (const route of selectedRoutes) {
    store.addRoute({ ...route, route_id: pfx(route.route_id) });
  }

  // Append stops that aren't matched to existing ones
  const storeAfterRoutes  = useStore.getState();
  const existingStopIdsNow = new Set(storeAfterRoutes.stops.map((s) => s.stop_id));
  for (const stop of selectedStops) {
    const newId = pfx(stop.stop_id);
    if (!existingStopIdsNow.has(newId)) {
      storeAfterRoutes.addStop({ ...stop, stop_id: newId });
    }
  }

  // Append trips (remap service_id to existing calendar if pattern matches)
  for (const trip of selectedTrips) {
    store.addTrip({
      ...trip,
      trip_id:  pfx(trip.trip_id),
      route_id: pfx(trip.route_id),
      service_id: remapServiceId(trip.service_id),
      shape_id: trip.shape_id ? pfx(trip.shape_id) : undefined,
    });
  }

  // Append stop times (batch to avoid many individual Immer drafts)
  const s1 = useStore.getState();
  s1.setStopTimes([
    ...s1.stopTimes,
    ...selectedStopTimes.map((st) => ({
      ...st,
      trip_id: pfx(st.trip_id),
      stop_id: remapStopId(st.stop_id),
    })),
  ]);

  // Append shapes
  for (const shape of selectedShapes) {
    store.addShape({ ...shape, shape_id: pfx(shape.shape_id) });
  }

  // Append route-stop associations (batch)
  const s2 = useStore.getState();
  s2.setRouteStops([
    ...s2.routeStops,
    ...selectedRouteStops.map((rs) => ({
      ...rs,
      route_id: pfx(rs.route_id),
      stop_id:  remapStopId(rs.stop_id),
    })),
  ]);

  // Append calendars referenced by selected trips that weren't remapped
  const neededServiceIds = new Set(selectedTrips.map((t) => t.service_id));
  const s3 = useStore.getState();
  const currentCalendarIds = new Set(s3.calendars.map((c) => c.service_id));
  const calendarsToAdd = data.calendars.filter(
    (c) =>
      neededServiceIds.has(c.service_id) &&
      !currentCalendarIds.has(c.service_id) &&
      !serviceIdRemap.has(c.service_id),
  );
  if (calendarsToAdd.length > 0) {
    s3.setCalendars([...s3.calendars, ...calendarsToAdd]);
  }

  // Append calendar_dates for newly added calendars
  const addedServiceIds = new Set(calendarsToAdd.map((c) => c.service_id));
  if (addedServiceIds.size > 0) {
    const calDatesToAdd = data.calendarDates.filter(
      (cd) => addedServiceIds.has(cd.service_id),
    );
    if (calDatesToAdd.length > 0) {
      const s4 = useStore.getState();
      s4.setCalendarDates([...s4.calendarDates, ...calDatesToAdd]);
    }
  }
}
