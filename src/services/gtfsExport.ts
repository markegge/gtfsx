import JSZip from 'jszip';
import Papa from 'papaparse';
import length from '@turf/length';
import { lineString } from '@turf/helpers';
import { useStore } from '../store';
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

function toCSV(data: Record<string, any>[]): string {
  if (data.length === 0) return '';
  return Papa.unparse(data);
}

function stripUIFields(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
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
function buildFeedInfoRow(state: ReturnType<typeof useStore.getState>): Record<string, any> | null {
  const primary = state.agencies[0];
  const userInfo = state.feedInfo;

  const publisher_name = userInfo?.feed_publisher_name || primary?.agency_name || '';
  const publisher_url = userInfo?.feed_publisher_url || primary?.agency_url || '';
  const lang = userInfo?.feed_lang
    || primary?.agency_lang
    || (typeof navigator !== 'undefined' ? navigator.language?.slice(0, 2) : undefined)
    || 'en';

  if (!publisher_name || !publisher_url) return null;

  const row: Record<string, any> = {
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

interface FlexMaterialized {
  routes: Route[];
  /** Net-new calendar rows we had to synthesize (usually empty). */
  calendars: Calendar[];
  trips: Trip[];
  /** stop_times rows that reference a location_id or location_group_id. */
  flexStopTimes: Record<string, any>[];
  fareRules: Record<string, any>[];
  /** location_groups.txt rows (for group-based flex zones). */
  locationGroups: Record<string, any>[];
  /** location_group_stops.txt rows (group_id, stop_id). */
  locationGroupStops: Record<string, any>[];
}

/**
 * Turn each flex zone with a service window + picked service_id into a
 * synthetic trip + stop_times row + (if no route picked) a synthetic flex
 * route. Uses the zone's chosen service_id (from calendar.txt). If the zone
 * has no service_id yet, falls back to the first available calendar.
 */
function materializeFlex(state: ReturnType<typeof useStore.getState>): FlexMaterialized {
  const out: FlexMaterialized = {
    routes: [], calendars: [], trips: [], flexStopTimes: [], fareRules: [],
    locationGroups: [], locationGroupStops: [],
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
          route_type: 3, // Bus — widely supported across validators
          route_color: '7C3AED',
          route_text_color: 'FFFFFF',
        });
      }
    }

    const bookingId = zone.bookingRule ? `${zone.id}-booking` : undefined;
    const isGroupZone = Array.isArray(zone.stopIds) && zone.stopIds.length > 0;

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
    if (isGroupZone) {
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

    // Now one trip + one stop_times row per window.
    for (const w of windows) {
      const tripId = `${zone.id}${w.suffix}`;
      out.trips.push({
        trip_id: tripId,
        route_id: routeId,
        service_id: w.serviceId,
        direction_id: 0,
        trip_headsign: zone.name,
      });
      out.flexStopTimes.push({
        trip_id: tripId,
        stop_sequence: 1,
        ...(isGroupZone
          ? { location_group_id: groupId }
          : { location_id: `${zone.id}-0` }),
        start_pickup_drop_off_window: w.start,
        end_pickup_drop_off_window: w.end,
        pickup_type: 2,
        drop_off_type: 2,
        ...(bookingId ? {
          pickup_booking_rule_id: bookingId,
          drop_off_booking_rule_id: bookingId,
        } : {}),
        ...(zone.meanDurationFactor != null ? { mean_duration_factor: zone.meanDurationFactor } : {}),
        ...(zone.meanDurationOffset != null ? { mean_duration_offset: zone.meanDurationOffset } : {}),
        ...(zone.safeDurationFactor != null ? { safe_duration_factor: zone.safeDurationFactor } : {}),
        ...(zone.safeDurationOffset != null ? { safe_duration_offset: zone.safeDurationOffset } : {}),
      });
    }

    if (zone.fareId) {
      out.fareRules.push({ fare_id: zone.fareId, route_id: routeId });
    }
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
  const directionRows: Record<string, any>[] = [];
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
    zip.file('stops.txt', toCSV(state.stops.map(stripUIFields)));
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
  // Per the GTFS spec both `arrival_time` and `departure_time` are REQUIRED
  // on the first and last stop of every trip — a previous version of this
  // exporter deliberately blanked them (inverted the spec requirement), which
  // produced MobilityData `missing_trip_edge` + `stop_time_with_only_arrival_
  // or_departure_time` errors on every exported feed. Export the store's
  // values verbatim; the editor guarantees both fields are populated when the
  // user types a time because `setStopTime` writes both sides.
  if (state.stopTimes.length > 0 || flex.flexStopTimes.length > 0) {
    const fixedRows = state.stopTimes.map((st) => stripUIFields(st));
    zip.file('stop_times.txt', toCSV([...fixedRows, ...flex.flexStopTimes]));
  }

  // shapes.txt. Safety net: if any shape still has all-zero shape_dist_traveled
  // (e.g. a code path missed calling recalcShapeDistances), recompute it here
  // before writing so we never emit a shape with duplicate cumulative
  // distances across distinct lat/lon points.
  if (state.shapes.length > 0) {
    const shapeRows: Record<string, any>[] = [];
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

  // locations.geojson (GTFS-Flex, polygon-based zones only)
  const polygonZones = state.flexZones.filter(
    (z) => !(Array.isArray(z.stopIds) && z.stopIds.length > 0),
  );
  if (polygonZones.length > 0) {
    const allFeatures = polygonZones.flatMap((zone) => {
      const bookingId = zone.bookingRule ? `${zone.id}-booking` : undefined;
      return zone.geojson.features.map((f, i) => ({
        ...f,
        properties: {
          stop_id: `${zone.id}-${i}`,
          stop_name: zone.name,
          location_type: 4,
          ...(bookingId ? {
            pickup_booking_rule_id: bookingId,
            drop_off_booking_rule_id: bookingId,
          } : {}),
          ...(zone.pickupWindowStart ? { start_pickup_drop_off_window: zone.pickupWindowStart } : {}),
          ...(zone.pickupWindowEnd ? { end_pickup_drop_off_window: zone.pickupWindowEnd } : {}),
        },
      }));
    });
    zip.file('locations.geojson', JSON.stringify({ type: 'FeatureCollection', features: allFeatures }, null, 2));
  }

  // booking_rules.txt (emitted whenever ANY zone has a booking rule,
  // polygon or group — they share the same schema).
  if (state.flexZones.some((z) => z.bookingRule)) {

    const bookingRows = state.flexZones
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
