import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../store';
import type { Calendar, Route, Trip } from '../types/gtfs';

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

  // stops.txt — only export stops referenced by route-stop associations or stop_times
  if (state.stops.length > 0) {
    const referencedStopIds = new Set([
      ...state.routeStops.map((rs) => rs.stop_id),
      ...state.stopTimes.map((st) => st.stop_id),
    ]);
    const usedStops = state.stops.filter((s) => referencedStopIds.has(s.stop_id));
    if (usedStops.length > 0) {
      zip.file('stops.txt', toCSV(usedStops.map(stripUIFields)));
    }
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

  // stop_times.txt — blank arrival on first stop, blank departure on last stop per trip
  if (state.stopTimes.length > 0 || flex.flexStopTimes.length > 0) {
    // Build first/last stop_sequence per trip
    const tripFirstLast = new Map<string, { first: number; last: number }>();
    for (const st of state.stopTimes) {
      const entry = tripFirstLast.get(st.trip_id);
      if (!entry) {
        tripFirstLast.set(st.trip_id, { first: st.stop_sequence, last: st.stop_sequence });
      } else {
        if (st.stop_sequence < entry.first) entry.first = st.stop_sequence;
        if (st.stop_sequence > entry.last) entry.last = st.stop_sequence;
      }
    }

    const fixedRows = state.stopTimes.map((st) => {
      const clean = stripUIFields(st);
      const fl = tripFirstLast.get(st.trip_id);
      if (fl) {
        if (st.stop_sequence === fl.first) clean.arrival_time = '';
        if (st.stop_sequence === fl.last) clean.departure_time = '';
      }
      return clean;
    });
    zip.file('stop_times.txt', toCSV([...fixedRows, ...flex.flexStopTimes]));
  }

  // shapes.txt
  if (state.shapes.length > 0) {
    const shapeRows: Record<string, any>[] = [];
    for (const shape of state.shapes) {
      for (const pt of shape.points) {
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

  // feed_info.txt
  if (state.feedInfo) {
    zip.file('feed_info.txt', toCSV([stripUIFields(state.feedInfo)]));
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
