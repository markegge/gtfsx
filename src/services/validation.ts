import type { ValidationMessage } from '../types/ui';
import type { AppStore } from '../store';

let msgId = 0;
function msg(severity: 'error' | 'warning', message: string, entity_type?: string, entity_id?: string): ValidationMessage {
  return { id: String(++msgId), severity, message, entity_type, entity_id };
}

export function runValidation(state: AppStore): ValidationMessage[] {
  msgId = 0;
  const messages: ValidationMessage[] = [];

  // Build lookup sets once
  const routeIdSet = new Set(state.routes.map((r) => r.route_id));
  const serviceIdSet = new Set(state.calendars.map((c) => c.service_id));
  const stopIdSet = new Set(state.stops.map((s) => s.stop_id));

  // Build stop_times index by trip_id
  const stopTimesByTrip = new Map<string, number>();
  const usedStopIds = new Set<string>();
  const badStopRefs = new Set<string>();

  for (const st of state.stopTimes) {
    stopTimesByTrip.set(st.trip_id, (stopTimesByTrip.get(st.trip_id) || 0) + 1);
    usedStopIds.add(st.stop_id);
    if (!stopIdSet.has(st.stop_id)) {
      badStopRefs.add(st.stop_id);
    }
  }

  // Agency checks
  if (state.agencies.length === 0) {
    messages.push(msg('error', 'At least one agency is required'));
  } else {
    for (const a of state.agencies) {
      if (!a.agency_name) messages.push(msg('error', `Agency "${a.agency_id}" is missing a name`, 'agency', a.agency_id));
      if (!a.agency_timezone) messages.push(msg('error', `Agency "${a.agency_id}" is missing a timezone`, 'agency', a.agency_id));
    }
  }

  // Calendar checks
  if (state.calendars.length === 0) {
    messages.push(msg('error', 'At least one service pattern (calendar) is required'));
  } else {
    // GTFS end_date is YYYYMMDD (inclusive). Compare as an integer to today's
    // YYYYMMDD so timezone drift never flips the boundary.
    const now = new Date();
    const todayYYYYMMDD =
      now.getFullYear() * 10000 +
      (now.getMonth() + 1) * 100 +
      now.getDate();
    for (const c of state.calendars) {
      if (!c.start_date) messages.push(msg('error', `Calendar "${c.service_id}" is missing start_date`, 'calendar', c.service_id));
      if (!c.end_date) {
        messages.push(msg('error', `Calendar "${c.service_id}" is missing end_date`, 'calendar', c.service_id));
        continue;
      }
      const endInt = Number(c.end_date);
      if (Number.isFinite(endInt) && endInt < todayYYYYMMDD) {
        const label = c._description || c.service_id;
        const pretty = c.end_date.length === 8
          ? `${c.end_date.slice(0, 4)}-${c.end_date.slice(4, 6)}-${c.end_date.slice(6, 8)}`
          : c.end_date;
        messages.push(msg(
          'warning',
          `Service pattern "${label}" is expired — end_date ${pretty} is in the past. Extend it before publishing or consumers will see no service on this pattern.`,
          'calendar',
          c.service_id,
        ));
      }
    }
  }

  // Route checks
  if (state.routes.length === 0) {
    messages.push(msg('warning', 'No routes defined'));
  } else {
    const routesWithTrips = new Set(state.trips.map((t) => t.route_id));
    // Routes that will receive a materialized trip from a flex zone at
    // export time (zone must have a pickup window to generate a trip).
    const routesWithFlexTrips = new Set(
      state.flexZones
        .filter((z) => z.routeId && z.pickupWindowStart && z.pickupWindowEnd)
        .map((z) => z.routeId as string),
    );
    for (const r of state.routes) {
      if (!r.route_short_name && !r.route_long_name) {
        messages.push(msg('error', `Route "${r.route_id}" needs either a short name or long name`, 'route', r.route_id));
      }
      if (!routesWithTrips.has(r.route_id) && !routesWithFlexTrips.has(r.route_id)) {
        messages.push(msg('warning', `Route "${r.route_short_name || r.route_id}" has no trips`, 'route', r.route_id));
      }
    }
  }

  // Stop checks
  for (const s of state.stops) {
    if (!s.stop_name) messages.push(msg('error', `Stop "${s.stop_id}" is missing a name`, 'stop', s.stop_id));
    if (!s.stop_lat || !s.stop_lon) messages.push(msg('error', `Stop "${s.stop_name || s.stop_id}" has invalid coordinates`, 'stop', s.stop_id));
  }

  // Trip checks (using pre-built indexes — O(n) not O(n²))
  for (const t of state.trips) {
    if (!routeIdSet.has(t.route_id)) {
      messages.push(msg('error', `Trip "${t.trip_id}" references non-existent route "${t.route_id}"`, 'trip', t.trip_id));
    }
    if (!serviceIdSet.has(t.service_id)) {
      messages.push(msg('warning', `Trip "${t.trip_id}" references non-existent calendar "${t.service_id}"`, 'trip', t.trip_id));
    }
    if (!stopTimesByTrip.has(t.trip_id)) {
      messages.push(msg('warning', `Trip "${t.trip_id}" has no stop times`, 'trip', t.trip_id));
    }
  }

  // Bad stop references in stop_times
  for (const sid of badStopRefs) {
    messages.push(msg('error', `Stop time references non-existent stop "${sid}"`, 'stop_time'));
  }

  // First + last stop of every trip must have BOTH arrival_time AND
  // departure_time per the GTFS spec. Intermediate stops may blank either.
  // Catches regressions of the exporter bug that blanked those fields.
  const tripFirstLast = new Map<string, { firstSeq: number; lastSeq: number }>();
  for (const st of state.stopTimes) {
    const fl = tripFirstLast.get(st.trip_id);
    if (!fl) tripFirstLast.set(st.trip_id, { firstSeq: st.stop_sequence, lastSeq: st.stop_sequence });
    else {
      if (st.stop_sequence < fl.firstSeq) fl.firstSeq = st.stop_sequence;
      if (st.stop_sequence > fl.lastSeq) fl.lastSeq = st.stop_sequence;
    }
  }
  for (const st of state.stopTimes) {
    const fl = tripFirstLast.get(st.trip_id);
    if (!fl) continue;
    const isFirst = st.stop_sequence === fl.firstSeq;
    const isLast = st.stop_sequence === fl.lastSeq;
    if ((isFirst || isLast) && (!st.arrival_time || !st.departure_time)) {
      const which = isFirst ? 'first' : 'last';
      messages.push(msg(
        'error',
        `${which[0].toUpperCase() + which.slice(1)} stop of trip "${st.trip_id}" is missing arrival_time or departure_time — both are required on trip endpoints`,
        'trip',
        st.trip_id,
      ));
    }
  }

  // Shapes must have real shape_dist_traveled values (not all-zero). Zero on
  // a non-first point next to different lat/lon coordinates trips GTFS
  // validators with `equal_shape_distance_diff_coordinates`. The exporter
  // auto-fills as a safety net; surfacing the warning here so the user can
  // see it in the validation panel before hitting Export.
  for (const shape of state.shapes) {
    if (shape.points.length < 2) continue;
    const anyNonZero = shape.points.some((p) => p.shape_dist_traveled !== 0);
    if (!anyNonZero) {
      messages.push(msg(
        'warning',
        `Shape "${shape.shape_id}" has no shape_dist_traveled values — export will compute them from geometry.`,
        'shape',
        shape.shape_id,
      ));
    }
  }

  // Fare checks
  if (state.fareAttributes.length === 0) {
    messages.push(msg('warning', 'No fare information defined — strongly recommended'));
  }
  for (const rule of state.fareRules) {
    if (rule.route_id && !routeIdSet.has(rule.route_id)) {
      messages.push(msg('error', `Fare rule for fare "${rule.fare_id}" references non-existent route "${rule.route_id}"`, 'fare_rule', rule.fare_id));
    }
  }

  // Unused stops
  if (state.stopTimes.length > 0) {
    for (const s of state.stops) {
      if (!usedStopIds.has(s.stop_id)) {
        messages.push(msg('warning', `Stop "${s.stop_name || s.stop_id}" is not used by any trip`, 'stop', s.stop_id));
      }
    }
  }

  // Flex zone checks — catch the silent-drop cases that otherwise leave a
  // user's zone missing from the exported feed with no explanation.
  const timeOk = (s?: string) => !s || /^\d{1,2}:\d{2}:\d{2}$/.test(s);
  for (const zone of state.flexZones) {
    const hasWindow = zone.pickupWindowStart && zone.pickupWindowEnd;
    if (!hasWindow) {
      messages.push(msg(
        'warning',
        `Flex zone "${zone.name}" has no pickup window — it will NOT be exported as a trip.`,
        'flex_zone', zone.id,
      ));
    }
    if (!timeOk(zone.pickupWindowStart)) {
      messages.push(msg(
        'error',
        `Flex zone "${zone.name}" pickup window start "${zone.pickupWindowStart}" must be HH:MM:SS`,
        'flex_zone', zone.id,
      ));
    }
    if (!timeOk(zone.pickupWindowEnd)) {
      messages.push(msg(
        'error',
        `Flex zone "${zone.name}" pickup window end "${zone.pickupWindowEnd}" must be HH:MM:SS`,
        'flex_zone', zone.id,
      ));
    }
    if (
      zone.pickupWindowStart && zone.pickupWindowEnd &&
      timeOk(zone.pickupWindowStart) && timeOk(zone.pickupWindowEnd) &&
      zone.pickupWindowStart > zone.pickupWindowEnd
    ) {
      messages.push(msg(
        'error',
        `Flex zone "${zone.name}" pickup window end is before start`,
        'flex_zone', zone.id,
      ));
    }
    if (hasWindow && state.calendars.length === 0) {
      messages.push(msg(
        'error',
        `Flex zone "${zone.name}" needs a service pattern (calendar) to produce a trip — define one in the Calendars tab.`,
        'flex_zone', zone.id,
      ));
    }
    if (hasWindow && zone.serviceId && !serviceIdSet.has(zone.serviceId)) {
      messages.push(msg(
        'error',
        `Flex zone "${zone.name}" references service_id "${zone.serviceId}" which no longer exists.`,
        'flex_zone', zone.id,
      ));
    }
    if (!zone.bookingRule) {
      messages.push(msg(
        'warning',
        `Flex zone "${zone.name}" has no booking rule — riders won't know how to request service.`,
        'flex_zone', zone.id,
      ));
    }
  }

  return messages;
}
