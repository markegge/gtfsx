import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../store';

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

export async function exportGtfsZip(): Promise<Blob> {
  const state = useStore.getState();
  const zip = new JSZip();

  // agency.txt
  if (state.agencies.length > 0) {
    zip.file('agency.txt', toCSV(state.agencies.map(stripUIFields)));
  }

  // calendar.txt
  if (state.calendars.length > 0) {
    zip.file('calendar.txt', toCSV(state.calendars.map(stripUIFields)));
  }

  // calendar_dates.txt
  if (state.calendarDates.length > 0) {
    zip.file('calendar_dates.txt', toCSV(state.calendarDates.map(stripUIFields)));
  }

  // routes.txt
  if (state.routes.length > 0) {
    zip.file('routes.txt', toCSV(state.routes.map(stripUIFields)));
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
  if (state.trips.length > 0) {
    const routeMap = new Map(state.routes.map((r) => [r.route_id, r]));
    zip.file('trips.txt', toCSV(state.trips.map((trip) => {
      const clean = stripUIFields(trip);
      if (!clean.trip_headsign) {
        const route = routeMap.get(trip.route_id);
        if (route) {
          const name = trip.direction_id === 0 ? route._direction_0_name : route._direction_1_name;
          if (name) clean.trip_headsign = name;
        }
      }
      return clean;
    })));
  }

  // stop_times.txt — blank arrival on first stop, blank departure on last stop per trip
  if (state.stopTimes.length > 0) {
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

    zip.file('stop_times.txt', toCSV(state.stopTimes.map((st) => {
      const clean = stripUIFields(st);
      const fl = tripFirstLast.get(st.trip_id);
      if (fl) {
        if (st.stop_sequence === fl.first) clean.arrival_time = '';
        if (st.stop_sequence === fl.last) clean.departure_time = '';
      }
      return clean;
    })));
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

  // fare_rules.txt
  if (state.fareRules.length > 0) {
    zip.file('fare_rules.txt', toCSV(state.fareRules.map(stripUIFields)));
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
