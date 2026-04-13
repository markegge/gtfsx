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

const DAY_FIELDS: (keyof Calendar)[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

interface FlexMaterialized {
  routes: Route[];
  calendars: Calendar[];
  trips: Trip[];
  /** stop_times rows that reference a location_id (flex extension). */
  flexStopTimes: Record<string, any>[];
  fareRules: Record<string, any>[];
}

/**
 * Turn each flex zone with a service window + days-of-week into a synthetic
 * trip + stop_times row + (if needed) a calendar entry + (if no route picked)
 * a synthetic flex route. Reuses existing calendars / routes when they match.
 */
function materializeFlex(state: ReturnType<typeof useStore.getState>): FlexMaterialized {
  const out: FlexMaterialized = {
    routes: [], calendars: [], trips: [], flexStopTimes: [], fareRules: [],
  };

  const eligibleZones = state.flexZones.filter((z) => z.pickupWindowStart && z.pickupWindowEnd);
  if (eligibleZones.length === 0) return out;

  const defaultStartDate = state.calendars[0]?.start_date || '20260101';
  const defaultEndDate = state.calendars[0]?.end_date || '20271231';
  const defaultAgencyId = state.agencies[0]?.agency_id || '';

  // Index existing calendars by their day pattern so multiple zones with the
  // same days share one service_id.
  function calendarKey(c: Pick<Calendar, 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'>) {
    return DAY_FIELDS.map((f) => c[f as keyof typeof c]).join('');
  }
  const existingCalKeys = new Map(state.calendars.map((c) => [calendarKey(c), c.service_id]));
  const synthCalKeys = new Map<string, string>();

  for (const zone of eligibleZones) {
    const days = zone.daysOfWeek ?? { mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true };
    const calPattern = {
      monday: (days.mon ? 1 : 0) as 0 | 1,
      tuesday: (days.tue ? 1 : 0) as 0 | 1,
      wednesday: (days.wed ? 1 : 0) as 0 | 1,
      thursday: (days.thu ? 1 : 0) as 0 | 1,
      friday: (days.fri ? 1 : 0) as 0 | 1,
      saturday: (days.sat ? 1 : 0) as 0 | 1,
      sunday: (days.sun ? 1 : 0) as 0 | 1,
    };
    const key = calendarKey(calPattern);
    let serviceId = existingCalKeys.get(key) ?? synthCalKeys.get(key);
    if (!serviceId) {
      const dayLabel = DAY_FIELDS
        .filter((d) => calPattern[d as keyof typeof calPattern] === 1)
        .map((d) => d.slice(0, 2))
        .join('') || 'never';
      serviceId = `flex-${dayLabel}`;
      synthCalKeys.set(key, serviceId);
      out.calendars.push({
        service_id: serviceId,
        ...calPattern,
        start_date: defaultStartDate,
        end_date: defaultEndDate,
      });
    }

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
          route_type: 715, // Demand and Response Bus Service (extended GTFS route_types)
          route_color: '7C3AED',
          route_text_color: 'FFFFFF',
        });
      }
    }

    const tripId = `${zone.id}-trip`;
    out.trips.push({
      trip_id: tripId,
      route_id: routeId,
      service_id: serviceId,
      direction_id: 0,
      trip_headsign: zone.name,
    });

    const bookingId = zone.bookingRule ? `${zone.id}-booking` : undefined;
    // For an area-based flex service, the spec accepts a single stop_times
    // row referencing the location_id (no arrival/departure_time).
    out.flexStopTimes.push({
      trip_id: tripId,
      stop_sequence: 1,
      location_id: `${zone.id}-0`,
      start_pickup_drop_off_window: zone.pickupWindowStart,
      end_pickup_drop_off_window: zone.pickupWindowEnd,
      pickup_type: 2,        // 2 = must phone agency to arrange
      drop_off_type: 2,
      ...(bookingId ? {
        pickup_booking_rule_id: bookingId,
        drop_off_booking_rule_id: bookingId,
      } : {}),
    });

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

  // locations.geojson + booking_rules.txt (GTFS-Flex)
  if (state.flexZones.length > 0) {
    const allFeatures = state.flexZones.flatMap((zone) => {
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
