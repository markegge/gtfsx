import JSZip from 'jszip';
import Papa from 'papaparse';
import length from '@turf/length';
import { lineString } from '@turf/helpers';
import { useStore } from '../store';
import { flexZoneHasGroup, type FlexZone } from '../store/flexSlice';
import type { Calendar, Route, ShapePoint, Trip } from '../types/gtfs';

/** Mirror of shapeSlice.recalcShapeDistances used as a last-resort safety
 *  net when a shape arrives at the exporter without real distances. Returns
 *  a new array; does NOT mutate the store. */
function fillShapeDistancesExport(points: ShapePoint[]): ShapePoint[] {
  const out = points.map((p) => ({ ...p }));
  const coords = out.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
  out[0].shape_dist_traveled = 0;
  for (let i = 1; i < out.length; i++) {
    out[i].shape_dist_traveled = length(lineString(coords.slice(0, i + 1)), { units: 'meters' });
  }
  return out;
}

// CSV input rows are heterogeneous (GTFS entity types with varying field
// sets); accept any object shape but flatten to a plain record before
// handing to PapaParse so it sees consistent keys.
//
// PapaParse derives the header from the FIRST row's keys only, which silently
// drops optional columns that are absent on row 0 but present on a later row
// (e.g. a frequencies row without exact_times, or a stop whose level_id is only
// set on platform stops further down the file). Build the union of keys across
// all rows — in first-seen order — and pass it explicitly so no column is lost
// on a round-trip.
function toCSV(data: readonly object[]): string {
  if (data.length === 0) return '';
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); columns.push(key); }
    }
  }
  return Papa.unparse(data as Record<string, unknown>[], { columns });
}

function stripUIFields<T extends object>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith('_') && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/** Build the feed_info.txt row (returns null if we don't have enough info to
 *  produce the three required fields). User-provided `state.feedInfo` always
 *  wins; the three required slots — feed_publisher_name / feed_publisher_url /
 *  feed_lang — fall back to the primary agency when unset. Optional fields
 *  only appear when the user explicitly set them. Emitting this file clears
 *  the validator's `missing_recommended_file` warning for feed_info.txt. */
function buildFeedInfoRow(state: ReturnType<typeof useStore.getState>): Record<string, unknown> | null {
  const primary = state.agencies[0];
  const userInfo = state.feedInfo;

  // Always attribute the publisher to GTFS·X — the tool that builds and publishes
  // the feed. A feed's prior/imported publisher stays in state.feedInfo (shown
  // read-only in the editor) but is never written to the exported feed_info.txt.
  const publisher_name = 'GTFS·X';
  const publisher_url = 'https://gtfsx.com';
  const lang = userInfo?.feed_lang
    || primary?.agency_lang
    || (typeof navigator !== 'undefined' ? navigator.language?.slice(0, 2) : undefined)
    || 'en';

  if (!publisher_name || !publisher_url) return null;

  const row: Record<string, unknown> = {
    feed_publisher_name: publisher_name,
    feed_publisher_url: publisher_url,
    feed_lang: lang,
  };
  if (userInfo?.default_lang) row.default_lang = userInfo.default_lang;
  if (userInfo?.feed_start_date) row.feed_start_date = userInfo.feed_start_date;
  if (userInfo?.feed_end_date) row.feed_end_date = userInfo.feed_end_date;
  if (userInfo?.feed_version) row.feed_version = userInfo.feed_version;
  if (userInfo?.feed_contact_email) row.feed_contact_email = userInfo.feed_contact_email;
  if (userInfo?.feed_contact_url) row.feed_contact_url = userInfo.feed_contact_url;
  return row;
}

/** trips.txt row for a flex trip. safe_duration_* are trips.txt fields in the
 *  flex spec (they are NOT stop_times fields). */
type FlexTrip = Trip & {
  safe_duration_factor?: number;
  safe_duration_offset?: number;
};

interface FlexMaterialized {
  routes: Route[];
  /** Net-new calendar rows we had to synthesize (usually empty). */
  calendars: Calendar[];
  trips: FlexTrip[];
  /** stop_times rows that reference a location_id or location_group_id. */
  flexStopTimes: Record<string, unknown>[];
  fareRules: Record<string, unknown>[];
  /** location_groups.txt rows (for group-based flex zones). */
  locationGroups: Record<string, unknown>[];
  /** location_group_stops.txt rows (group_id, stop_id). */
  locationGroupStops: Record<string, unknown>[];
  /**
   * The zones that actually materialized into trips + stop_times. locations.geojson
   * and booking_rules.txt are written from THIS set (not all of state.flexZones) so
   * the zip carries no geometry or booking rule that nothing references.
   */
  zones: FlexZone[];
}

/**
 * With a pickup/drop-off window defined, the flex spec forbids pickup_type 0
 * (regular) and 3 (coordinate with driver), and drop_off_type 0. Anything
 * forbidden falls back to 2 — phone the agency — the canonical on-demand value.
 */
function clampFlexPickupType(t: number | undefined): 0 | 1 | 2 | 3 {
  return t === 1 || t === 2 ? t : 2;
}

function clampFlexDropOffType(t: number | undefined): 0 | 1 | 2 | 3 {
  return t === 1 || t === 2 || t === 3 ? t : 2;
}

/**
 * One flex zone = one location_id = one locations.geojson Feature. A zone drawn
 * as several polygons merges into a single MultiPolygon: the flex stop_times
 * rows reference the zone by one id, so any extra Feature would be an orphan
 * location nothing points at. Per the spec a Feature carries its id at the TOP
 * level (unique across stops.stop_id / locations.geojson id / location_group_id),
 * its geometry must be Polygon or MultiPolygon, and its properties may hold only
 * stop_name and stop_desc. Returns null when the zone has no polygon geometry.
 */
function zonePolygons(zone: FlexZone): GeoJSON.Position[][][] {
  const polygons: GeoJSON.Position[][][] = [];
  for (const f of zone.geojson?.features || []) {
    const g = f.geometry;
    if (g?.type === 'Polygon') polygons.push(g.coordinates);
    else if (g?.type === 'MultiPolygon') polygons.push(...g.coordinates);
  }
  return polygons;
}

function zoneLocationFeature(zone: FlexZone): GeoJSON.Feature | null {
  const polygons = zonePolygons(zone);
  if (polygons.length === 0) return null;

  let stopDesc: string | undefined;
  for (const f of zone.geojson.features) {
    const desc = (f.properties || {}).stop_desc;
    if (typeof desc === 'string' && desc !== '') { stopDesc = desc; break; }
  }

  return {
    type: 'Feature',
    id: zone.id,
    properties: {
      stop_name: zone.name,
      ...(stopDesc ? { stop_desc: stopDesc } : {}),
    },
    geometry: polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons },
  };
}

/**
 * Turn each flex zone with a service window + picked service_id into a
 * synthetic trip + stop_times rows + (if no route picked) a synthetic flex
 * route. Uses the zone's chosen service_id (from calendar.txt). If the zone
 * has no service_id yet, falls back to the first available calendar.
 */
function materializeFlex(state: ReturnType<typeof useStore.getState>): FlexMaterialized {
  const out: FlexMaterialized = {
    routes: [], calendars: [], trips: [], flexStopTimes: [], fareRules: [],
    locationGroups: [], locationGroupStops: [], zones: [],
  };

  const eligibleZones = state.flexZones.filter((z) => z.pickupWindowStart && z.pickupWindowEnd);
  if (eligibleZones.length === 0) return out;

  const defaultAgencyId = state.agencies[0]?.agency_id || '';
  const defaultServiceId = state.calendars[0]?.service_id;
  const knownServiceIds = new Set(state.calendars.map((c) => c.service_id));

  for (const zone of eligibleZones) {
    // Prefer the zone's picked service_id; fall back to the first calendar
    // if the user hasn't chosen one yet. If there's no calendar at all, the
    // zone can't be materialized into a spec-valid trip — skip it.
    const serviceId = (zone.serviceId && knownServiceIds.has(zone.serviceId))
      ? zone.serviceId
      : defaultServiceId;
    if (!serviceId) continue;

    // Route: reuse the user's pick, otherwise synthesize one per zone.
    let routeId = zone.routeId;
    if (!routeId || !state.routes.some((r) => r.route_id === routeId)) {
      routeId = `${zone.id}-route`;
      if (!out.routes.some((r) => r.route_id === routeId)) {
        out.routes.push({
          route_id: routeId,
          agency_id: defaultAgencyId,
          route_short_name: zone.name,
          route_long_name: `${zone.name} (Flex)`,
          route_type: 715, // Demand and Response Bus Service
          route_color: '7C3AED',
          route_text_color: 'FFFFFF',
        });
      }
    }

    const bookingId = zone.bookingRule ? `${zone.id}-booking` : undefined;
    // A zone may carry polygon geometry, a stop group, or BOTH (mixed). In
    // GTFS-Flex a single stop_times row references one location_id OR one
    // location_group_id — never both — so a mixed zone emits two stop_times
    // rows per window (one polygon, one group) on the same trip.
    const hasGroup = flexZoneHasGroup(zone) && (zone.stopIds?.length ?? 0) > 0;
    // Polygon-aware: a zone whose features carry no Polygon/MultiPolygon geometry
    // gets no locations.geojson feature, so it must not emit a location_id row
    // either — that would be a reference to a location the feed doesn't contain.
    const hasPolygons = zonePolygons(zone).length > 0;

    // Build the list of (service_id, window) pairs. The primary pair is
    // the zone's top-level serviceId + pickup window; any additionalWindows
    // entries materialize into their own trips + stop_times rows.
    type Window = { serviceId: string; start: string; end: string; suffix: string };
    const windows: Window[] = [
      {
        serviceId,
        start: zone.pickupWindowStart as string,
        end: zone.pickupWindowEnd as string,
        suffix: '-trip',
      },
    ];
    if (zone.additionalWindows) {
      zone.additionalWindows.forEach((w, i) => {
        if (!w.pickupWindowStart || !w.pickupWindowEnd) return;
        const addlSvc = knownServiceIds.has(w.serviceId) ? w.serviceId : serviceId;
        windows.push({
          serviceId: addlSvc,
          start: w.pickupWindowStart,
          end: w.pickupWindowEnd,
          suffix: `-trip-${i + 2}`,
        });
      });
    }

    // Emit location_groups / location_group_stops once per zone (not per window)
    let groupId: string | undefined;
    if (hasGroup) {
      groupId = `${zone.id}-group`;
      out.locationGroups.push({
        location_group_id: groupId,
        location_group_name: zone.name,
      });
      for (const stopId of zone.stopIds!) {
        out.locationGroupStops.push({
          location_group_id: groupId,
          stop_id: stopId,
        });
      }
    }

    // The shared booking fields written on every flex stop_times row.
    const flexRowExtras: Record<string, unknown> = bookingId ? {
      pickup_booking_rule_id: bookingId,
      drop_off_booking_rule_id: bookingId,
    } : {};

    const pickupType = clampFlexPickupType(zone.pickupType);
    const dropOffType = clampFlexDropOffType(zone.dropOffType);

    // The location references this zone contributes, in stop_sequence order:
    // polygon first (location_id), then stop group (location_group_id). A
    // mixed zone produces both; single-shape zones produce one. If a zone is
    // somehow empty (no polygon, no group), skip it — nothing to reference.
    // The whole zone is ONE location (a multi-polygon zone merges into a single
    // MultiPolygon feature), so the polygon ref is the zone id itself.
    const locationRefs: Array<Record<string, unknown>> = [];
    if (hasPolygons) locationRefs.push({ location_id: zone.id });
    if (hasGroup) locationRefs.push({ location_group_id: groupId });
    if (locationRefs.length === 0) continue;

    // "Travel within the same location group or GeoJSON location requires two
    // records in stop_times.txt with the same location_group_id or location_id."
    // So a single-shape zone (the canonical microtransit case: get on and off
    // anywhere inside the area) repeats its one reference at stop_sequence 1 and
    // 2, both rows carrying the window. A mixed zone already has two distinct
    // references — travel from the polygon area to the stop group.
    const rowRefs = locationRefs.length === 1
      ? [locationRefs[0], locationRefs[0]]
      : locationRefs;

    // Now one trip per window; two stop_times rows per trip.
    for (const w of windows) {
      const tripId = `${zone.id}${w.suffix}`;
      out.trips.push({
        trip_id: tripId,
        route_id: routeId,
        service_id: w.serviceId,
        direction_id: 0,
        trip_headsign: zone.name,
        ...(zone.safeDurationFactor != null ? { safe_duration_factor: zone.safeDurationFactor } : {}),
        ...(zone.safeDurationOffset != null ? { safe_duration_offset: zone.safeDurationOffset } : {}),
      });
      rowRefs.forEach((ref, i) => {
        out.flexStopTimes.push({
          trip_id: tripId,
          stop_sequence: i + 1,
          ...ref,
          start_pickup_drop_off_window: w.start,
          end_pickup_drop_off_window: w.end,
          pickup_type: pickupType,
          drop_off_type: dropOffType,
          ...flexRowExtras,
        });
      });
    }

    if (zone.fareId) {
      out.fareRules.push({ fare_id: zone.fareId, route_id: routeId });
    }

    out.zones.push(zone);
  }

  return out;
}

export async function exportGtfsZip(): Promise<Blob> {
  const state = useStore.getState();
  const zip = new JSZip();
  const flex = materializeFlex(state);

  // agency.txt
  if (state.agencies.length > 0) {
    zip.file('agency.txt', toCSV(state.agencies.map(stripUIFields)));
  }

  // calendar.txt (+ flex-synthesized service patterns)
  const allCalendars = [...state.calendars.map(stripUIFields), ...flex.calendars];
  if (allCalendars.length > 0) {
    zip.file('calendar.txt', toCSV(allCalendars));
  }

  // calendar_dates.txt
  if (state.calendarDates.length > 0) {
    zip.file('calendar_dates.txt', toCSV(state.calendarDates.map(stripUIFields)));
  }

  // routes.txt (+ flex-synthesized routes for zones without an assigned route)
  const allRoutes = [...state.routes.map(stripUIFields), ...flex.routes];
  if (allRoutes.length > 0) {
    zip.file('routes.txt', toCSV(allRoutes));
  }

  // directions.txt (non-standard but widely supported)
  const directionRows: Record<string, unknown>[] = [];
  for (const route of state.routes) {
    if (route._direction_0_name) {
      directionRows.push({ route_id: route.route_id, direction_id: 0, direction: route._direction_0_name });
    }
    if (route._direction_1_name) {
      directionRows.push({ route_id: route.route_id, direction_id: 1, direction: route._direction_1_name });
    }
  }
  if (directionRows.length > 0) {
    zip.file('directions.txt', toCSV(directionRows));
  }

  // stops.txt — export every stop in state. Editor state is the source of
  // truth for export; orphans are flagged by the validator and can be
  // auto-cleaned via the ExportDialog if the user opts in. Silently
  // dropping unreferenced stops here would surprise users who batch-add
  // stops before wiring them up (and broke round-trip fidelity — a stop
  // added but not yet placed would vanish on save → reload).
  if (state.stops.length > 0) {
    // Round coordinates to 6 decimals (~0.1 m) — plenty for transit, and keeps
    // stops.txt clean instead of carrying float noise from map drags.
    const round6 = (n: unknown) => (typeof n === 'number' ? Math.round(n * 1e6) / 1e6 : n);
    zip.file('stops.txt', toCSV(state.stops.map((s) => {
      const clean = stripUIFields(s);
      clean.stop_lat = round6(clean.stop_lat);
      clean.stop_lon = round6(clean.stop_lon);
      return clean;
    })));
  }

  // trips.txt — populate trip_headsign from route direction names if not already set
  if (state.trips.length > 0 || flex.trips.length > 0) {
    const routeMap = new Map(state.routes.map((r) => [r.route_id, r]));
    const fixedTrips = state.trips.map((trip) => {
      const clean = stripUIFields(trip);
      if (!clean.trip_headsign) {
        const route = routeMap.get(trip.route_id);
        if (route) {
          const name = trip.direction_id === 0 ? route._direction_0_name : route._direction_1_name;
          if (name) clean.trip_headsign = name;
        }
      }
      return clean;
    });
    zip.file('trips.txt', toCSV([...fixedTrips, ...flex.trips.map(stripUIFields)]));
  }

  // stop_times.txt
  //
  // Each (trip, stop) cell maps to one of three GTFS states:
  //   • TIMED        — a row with arrival_time / departure_time set.
  //   • INTERPOLATED — the stop is served but has no explicit time. We emit a
  //                    row with BLANK arrival/departure and `timepoint=0` so
  //                    consumers interpolate it. (A blank time with the default
  //                    timepoint=1/"exact" is a validator error, hence the 0.)
  //   • SKIPPED      — the trip doesn't serve the stop. There is NO row for it
  //                    in the store (the editor removes it), so it's naturally
  //                    omitted here and the trip's first/last become the
  //                    adjacent SERVED stops — both of which carry times.
  //
  // The first/last-must-be-timed rule is enforced by the pre-export validator,
  // not by blanking fields here (an earlier version inverted the spec and
  // produced MobilityData `missing_trip_edge` errors on every feed).
  if (state.stopTimes.length > 0 || flex.flexStopTimes.length > 0) {
    const fixedRows = state.stopTimes.map((st) => {
      const row = stripUIFields(st);
      const hasTime = !!st.arrival_time || !!st.departure_time;
      if (!hasTime) {
        // Interpolated: keep both times blank and mark the row approximate.
        row.arrival_time = '';
        row.departure_time = '';
        row.timepoint = 0;
      }
      return row;
    });
    zip.file('stop_times.txt', toCSV([...fixedRows, ...flex.flexStopTimes]));
  }

  // shapes.txt. Safety net: if any shape still has all-zero shape_dist_traveled
  // (e.g. a code path missed calling recalcShapeDistances), recompute it here
  // before writing so we never emit a shape with duplicate cumulative
  // distances across distinct lat/lon points.
  if (state.shapes.length > 0) {
    const shapeRows: Record<string, unknown>[] = [];
    for (const shape of state.shapes) {
      let pts = shape.points;
      const hasRealDistances = pts.some((p) => p.shape_dist_traveled !== 0);
      if (!hasRealDistances && pts.length >= 2) {
        pts = fillShapeDistancesExport(pts);
      }
      for (const pt of pts) {
        shapeRows.push({
          shape_id: shape.shape_id,
          shape_pt_lat: pt.shape_pt_lat,
          shape_pt_lon: pt.shape_pt_lon,
          shape_pt_sequence: pt.shape_pt_sequence,
          shape_dist_traveled: pt.shape_dist_traveled,
        });
      }
    }
    zip.file('shapes.txt', toCSV(shapeRows));
  }

  // fare_attributes.txt
  if (state.fareAttributes.length > 0) {
    zip.file('fare_attributes.txt', toCSV(state.fareAttributes.map(stripUIFields)));
  }

  // fare_rules.txt (+ flex-zone fare assignments)
  const allFareRules = [...state.fareRules.map(stripUIFields), ...flex.fareRules];
  if (allFareRules.length > 0) {
    zip.file('fare_rules.txt', toCSV(allFareRules));
  }

  // transfers.txt
  if (state.transfers.length > 0) {
    zip.file('transfers.txt', toCSV(state.transfers.map(stripUIFields)));
  }

  // frequencies.txt
  if (state.frequencies.length > 0) {
    zip.file('frequencies.txt', toCSV(state.frequencies.map(stripUIFields)));
  }

  // levels.txt
  if (state.levels.length > 0) {
    zip.file('levels.txt', toCSV(state.levels.map(stripUIFields)));
  }

  // pathways.txt
  if (state.pathways.length > 0) {
    zip.file('pathways.txt', toCSV(state.pathways.map(stripUIFields)));
  }

  // GTFS-Fares v2 — written when populated, alongside (not instead of) v1.
  // Consumers prefer v2 when present; agencies often publish both during
  // a transition window. There's no v1↔v2 cross-reference in the editor
  // today (Phase 1 round-trip only).
  if (state.fareAreas.length > 0) {
    zip.file('areas.txt', toCSV(state.fareAreas.map(stripUIFields)));
  }
  if (state.stopAreas.length > 0) {
    zip.file('stop_areas.txt', toCSV(state.stopAreas.map(stripUIFields)));
  }
  if (state.fareNetworks.length > 0) {
    zip.file('networks.txt', toCSV(state.fareNetworks.map(stripUIFields)));
  }
  if (state.routeNetworks.length > 0) {
    zip.file('route_networks.txt', toCSV(state.routeNetworks.map(stripUIFields)));
  }
  if (state.timeframes.length > 0) {
    zip.file('timeframes.txt', toCSV(state.timeframes.map(stripUIFields)));
  }
  if (state.riderCategories.length > 0) {
    zip.file('rider_categories.txt', toCSV(state.riderCategories.map(stripUIFields)));
  }
  if (state.fareMedia.length > 0) {
    zip.file('fare_media.txt', toCSV(state.fareMedia.map(stripUIFields)));
  }
  if (state.fareProducts.length > 0) {
    zip.file('fare_products.txt', toCSV(state.fareProducts.map(stripUIFields)));
  }
  if (state.fareLegRules.length > 0) {
    zip.file('fare_leg_rules.txt', toCSV(state.fareLegRules.map(stripUIFields)));
  }
  if (state.fareTransferRules.length > 0) {
    zip.file('fare_transfer_rules.txt', toCSV(state.fareTransferRules.map(stripUIFields)));
  }

  // feed_info.txt — recommended per the GTFS spec (MobilityData's validator
  // raises a `missing_recommended_file` warning when absent). When the user
  // hasn't filled out feed info explicitly, synthesize the three required
  // fields from the primary agency so every export carries a valid file.
  const feedInfoRow = buildFeedInfoRow(state);
  if (feedInfoRow) {
    zip.file('feed_info.txt', toCSV([feedInfoRow]));
  }

  // location_groups.txt + location_group_stops.txt (GTFS-Flex, group-based)
  if (flex.locationGroups.length > 0) {
    zip.file('location_groups.txt', toCSV(flex.locationGroups));
  }
  if (flex.locationGroupStops.length > 0) {
    zip.file('location_group_stops.txt', toCSV(flex.locationGroupStops));
  }

  // locations.geojson (GTFS-Flex) — one Feature per materialized zone that has
  // polygon geometry, including mixed (polygon + group) zones. Group-only zones
  // contribute no features here (their service area lives in
  // location_group_stops.txt). Zones that didn't materialize into a trip are
  // skipped so the file carries no location nothing references.
  const locationFeatures = flex.zones
    .map((z) => zoneLocationFeature(z))
    .filter((f): f is GeoJSON.Feature => f !== null);
  if (locationFeatures.length > 0) {
    zip.file('locations.geojson', JSON.stringify({ type: 'FeatureCollection', features: locationFeatures }, null, 2));
  }

  // booking_rules.txt (emitted whenever a materialized zone has a booking rule,
  // polygon or group — they share the same schema).
  const bookingRows = flex.zones
    .filter((z) => z.bookingRule)
    .map((z) => {
      const b = z.bookingRule!;
      return {
        booking_rule_id: `${z.id}-booking`,
        booking_type: b.bookingType,
        prior_notice_duration_min: b.priorNoticeDurationMin,
        prior_notice_duration_max: b.priorNoticeDurationMax,
        prior_notice_last_day: b.priorNoticeLastDay,
        prior_notice_last_time: b.priorNoticeLastTime,
        prior_notice_start_day: b.priorNoticeStartDay,
        prior_notice_start_time: b.priorNoticeStartTime,
        prior_notice_service_id: b.priorNoticeServiceId,
        message: b.message,
        pickup_message: b.pickupMessage,
        drop_off_message: b.dropOffMessage,
        phone_number: b.phoneNumber,
        info_url: b.infoUrl,
        booking_url: b.bookingUrl,
      };
    })
    .map((row) => Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== undefined && v !== ''),
    ));
  if (bookingRows.length > 0) {
    zip.file('booking_rules.txt', toCSV(bookingRows));
  }

  return await zip.generateAsync({ type: 'blob' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
