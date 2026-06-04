import type { ValidationMessage } from '../types/ui';
import type { AppStore } from '../store';
import { featureEnabled } from '../store/featuresSlice';
import { gtfsTimeToSeconds } from '../utils/time';
import { getUSHolidaysInRange } from '../utils/holidays';

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

  // Accessibility completeness — aggregate (one message, not one per stop) so
  // the warning is actionable without flooding the panel. Counts board points
  // (location_type 0/blank) where wheelchair_boarding is unset or 0 (= "no
  // information" per the GTFS spec). Detailed per-route breakdown lives in
  // Stop Analysis → Accessibility, which this cross-links to.
  const boardPoints = state.stops.filter((s) => (s.location_type ?? 0) === 0);
  const missingWheelchair = boardPoints.filter(
    (s) => s.wheelchair_boarding !== 1 && s.wheelchair_boarding !== 2,
  ).length;
  if (boardPoints.length > 0 && missingWheelchair > 0) {
    const pct = Math.round((missingWheelchair / boardPoints.length) * 100);
    messages.push(msg(
      'warning',
      `${missingWheelchair} of ${boardPoints.length} stops (${pct}%) are missing wheelchair_boarding — riders see "no accessibility information." Populate it in Stop Analysis → Accessibility.`,
      'stop',
    ));
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

  // Suspicious overnight times — GTFS allows hours > 24 for service that
  // crosses midnight, but a time past 48:00 is almost always a typo.
  for (const st of state.stopTimes) {
    for (const field of ['arrival_time', 'departure_time'] as const) {
      const t = st[field];
      if (!t) continue;
      const h = Number(t.split(':')[0]);
      if (Number.isFinite(h) && h >= 48) {
        messages.push(msg(
          'warning',
          `Trip "${st.trip_id}" ${field} "${t}" is past 48:00 — verify this isn't a typo (overnight services rarely exceed 30:00).`,
          'trip', st.trip_id,
        ));
        break; // one warning per stop_time row is enough
      }
    }
  }

  // Departure must be >= arrival on every stop_time row. The single-time
  // entry mode keeps them equal automatically; this catches typos in the
  // advanced separate-time mode (and bad imports).
  for (const st of state.stopTimes) {
    if (st.arrival_time && st.departure_time) {
      const a = st.arrival_time.split(':').map(Number);
      const d = st.departure_time.split(':').map(Number);
      const aSec = (a[0] || 0) * 3600 + (a[1] || 0) * 60 + (a[2] || 0);
      const dSec = (d[0] || 0) * 3600 + (d[1] || 0) * 60 + (d[2] || 0);
      if (dSec < aSec) {
        messages.push(msg(
          'error',
          `Trip "${st.trip_id}" stop "${st.stop_id}": departure_time ${st.departure_time} is before arrival_time ${st.arrival_time}.`,
          'trip', st.trip_id,
        ));
      }
    }
  }

  // Transfer reference checks
  for (const t of state.transfers) {
    if (!stopIdSet.has(t.from_stop_id)) {
      messages.push(msg('error', `Transfer references non-existent from_stop_id "${t.from_stop_id}"`, 'transfer'));
    }
    if (!stopIdSet.has(t.to_stop_id)) {
      messages.push(msg('error', `Transfer references non-existent to_stop_id "${t.to_stop_id}"`, 'transfer'));
    }
    if (t.transfer_type === 2 && (t.min_transfer_time === undefined || t.min_transfer_time < 0)) {
      messages.push(msg(
        'error',
        `Transfer ${t.from_stop_id} → ${t.to_stop_id} has transfer_type=2 but is missing min_transfer_time.`,
        'transfer',
      ));
    }
  }

  // Parent station integrity: a parent_station must point to a location_type=1 stop
  const stationIds = new Set(state.stops.filter((s) => s.location_type === 1).map((s) => s.stop_id));
  for (const s of state.stops) {
    if (!s.parent_station) continue;
    if (!stopIdSet.has(s.parent_station)) {
      messages.push(msg(
        'error',
        `Stop "${s.stop_name || s.stop_id}" references non-existent parent_station "${s.parent_station}".`,
        'stop', s.stop_id,
      ));
    } else if (!stationIds.has(s.parent_station)) {
      messages.push(msg(
        'error',
        `Stop "${s.stop_name || s.stop_id}" parent_station "${s.parent_station}" is not a Station (location_type=1).`,
        'stop', s.stop_id,
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
    messages.push(msg('warning', 'No fare information defined — strongly recommended', 'fare'));
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

  // ── Frequencies (#12) ──────────────────────────────────────────────────
  // Headway-based service per trip: end_time > start_time, headway_secs > 0,
  // and windows for the same trip must not overlap (a consumer can't resolve
  // two headways at the same instant). Times may exceed 24:00:00.
  const tripIdSet = new Set(state.trips.map((t) => t.trip_id));
  const freqByTrip = new Map<string, typeof state.frequencies>();
  for (const f of state.frequencies) {
    if (!tripIdSet.has(f.trip_id)) {
      messages.push(msg('error', `Frequency references non-existent trip "${f.trip_id}"`, 'trip', f.trip_id));
    }
    if (!(f.headway_secs > 0)) {
      messages.push(msg('error', `Frequency for trip "${f.trip_id}" has headway_secs ${f.headway_secs} — must be a positive number.`, 'trip', f.trip_id));
    }
    if (gtfsTimeToSeconds(f.end_time) <= gtfsTimeToSeconds(f.start_time)) {
      messages.push(msg('error', `Frequency for trip "${f.trip_id}" ends (${f.end_time}) at or before it starts (${f.start_time}).`, 'trip', f.trip_id));
    }
    const list = freqByTrip.get(f.trip_id) ?? [];
    list.push(f);
    freqByTrip.set(f.trip_id, list);
  }
  for (const [tripId, windows] of freqByTrip) {
    if (windows.length < 2) continue;
    const sorted = [...windows].sort((a, b) => gtfsTimeToSeconds(a.start_time) - gtfsTimeToSeconds(b.start_time));
    for (let i = 1; i < sorted.length; i++) {
      if (gtfsTimeToSeconds(sorted[i].start_time) < gtfsTimeToSeconds(sorted[i - 1].end_time)) {
        messages.push(msg(
          'error',
          `Trip "${tripId}" has overlapping frequency windows (${sorted[i - 1].start_time}–${sorted[i - 1].end_time} and ${sorted[i].start_time}–${sorted[i].end_time}).`,
          'trip', tripId,
        ));
      }
    }
  }

  // ── Levels & pathways (#13) ────────────────────────────────────────────
  const levelIdSet = new Set(state.levels.map((l) => l.level_id));
  for (const s of state.stops) {
    if (s.level_id && !levelIdSet.has(s.level_id)) {
      messages.push(msg('error', `Stop "${s.stop_name || s.stop_id}" references non-existent level_id "${s.level_id}".`, 'stop', s.stop_id));
    }
  }
  for (const p of state.pathways) {
    if (!stopIdSet.has(p.from_stop_id)) {
      messages.push(msg('error', `Pathway "${p.pathway_id}" references non-existent from_stop_id "${p.from_stop_id}".`, 'pathway', p.pathway_id));
    }
    if (!stopIdSet.has(p.to_stop_id)) {
      messages.push(msg('error', `Pathway "${p.pathway_id}" references non-existent to_stop_id "${p.to_stop_id}".`, 'pathway', p.pathway_id));
    }
    if (!(p.pathway_mode >= 1 && p.pathway_mode <= 7)) {
      messages.push(msg('error', `Pathway "${p.pathway_id}" has pathway_mode ${p.pathway_mode} — must be 1–7.`, 'pathway', p.pathway_id));
    }
    if (p.is_bidirectional !== 0 && p.is_bidirectional !== 1) {
      messages.push(msg('error', `Pathway "${p.pathway_id}" has is_bidirectional ${p.is_bidirectional} — must be 0 or 1.`, 'pathway', p.pathway_id));
    }
  }

  // ── Block overlap (#16) — soft warning ─────────────────────────────────
  // Two trips in the same block (one vehicle) on the same service day can't
  // run at once. Compute each trip's time span from its stop_times and flag
  // overlapping trips within a (block_id, service_id) group.
  const tripSpan = new Map<string, { start: number; end: number }>();
  for (const st of state.stopTimes) {
    const t = st.departure_time || st.arrival_time;
    if (!t) continue;
    const sec = gtfsTimeToSeconds(t);
    const span = tripSpan.get(st.trip_id);
    if (!span) tripSpan.set(st.trip_id, { start: sec, end: sec });
    else {
      if (sec < span.start) span.start = sec;
      if (sec > span.end) span.end = sec;
    }
  }
  const blockGroups = new Map<string, { trip_id: string; start: number; end: number }[]>();
  for (const t of state.trips) {
    if (!t.block_id) continue;
    const span = tripSpan.get(t.trip_id);
    if (!span) continue;
    const key = `${t.block_id} ${t.service_id}`;
    const list = blockGroups.get(key) ?? [];
    list.push({ trip_id: t.trip_id, start: span.start, end: span.end });
    blockGroups.set(key, list);
  }
  for (const [key, blockTrips] of blockGroups) {
    if (blockTrips.length < 2) continue;
    const blockId = key.split(' ')[0];
    const sorted = [...blockTrips].sort((a, b) => a.start - b.start);
    let maxEnd = sorted[0].end;
    let holder = sorted[0].trip_id;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < maxEnd) {
        messages.push(msg(
          'warning',
          `Trips "${holder}" and "${sorted[i].trip_id}" in block "${blockId}" overlap in time — a vehicle can't run two trips at once.`,
          'trip', sorted[i].trip_id,
        ));
      }
      if (sorted[i].end > maxEnd) { maxEnd = sorted[i].end; holder = sorted[i].trip_id; }
    }
  }

  // ── Holiday-exception nudge (#17) — soft warning ───────────────────────
  // Flag major US holidays that fall on a day a service runs, inside its
  // active range, with no calendar_dates exception. Scan at most the first
  // year of the range so a far-future end_date (e.g. the default 20991231)
  // doesn't generate decades of nudges; holidays repeat annually anyway.
  const dayFields = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
  const exceptionKeys = new Set(state.calendarDates.map((cd) => `${cd.service_id} ${cd.date}`));
  for (const c of state.calendars) {
    if (!c.start_date || !c.end_date || c.start_date.length !== 8) continue;
    const startYearPlusOne = `${Number(c.start_date.slice(0, 4)) + 1}${c.start_date.slice(4)}`;
    const scanEnd = c.end_date < startYearPlusOne ? c.end_date : startYearPlusOne;
    // Collect every holiday this service runs on without a calendar_dates
    // exception, then surface ONE consolidated warning per service rather
    // than a dozen near-identical ones (which flooded the export dialog).
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const h of getUSHolidaysInRange(c.start_date, scanEnd)) {
      if (c[dayFields[h.dayOfWeek]] !== 1) continue;
      if (exceptionKeys.has(`${c.service_id} ${h.gtfsDate}`)) continue;
      if (seen.has(h.name)) continue;
      seen.add(h.name);
      missing.push(h.name);
    }
    if (missing.length > 0) {
      const label = c._description || c.service_id;
      messages.push(msg(
        'warning',
        `Service "${label}" has no calendar_dates exception for ${missing.length} major US holiday${missing.length !== 1 ? 's' : ''} (${missing.join(', ')}). Most agencies run a holiday or reduced schedule those days; add exceptions if so.`,
        'calendar', c.service_id,
      ));
    }
  }

  // Demand-response / paratransit is on (the default) but the feed defines no
  // GTFS-Flex zones — nudge toward adding flex, or turning the setting off in
  // Settings. GTFS-Flex is widely under-used; this gentle prompt is deliberate.
  if (featureEnabled(state, 'demandResponse') && state.flexZones.length === 0) {
    messages.push(msg(
      'warning',
      'Demand-response service is on but no GTFS-Flex zones are defined. Add flex zones, or turn off Demand response in Settings.',
    ));
  }

  // ── GTFS-Fares v2: areas.txt + stop_areas.txt (#32, Phase 3) ───────────────
  // area_id must be unique within areas.txt; every stop_areas row must point at
  // an area that exists and a stop that exists. (Later phases add the deeper
  // cross-reference checks for networks, products, and leg/transfer rules.)
  const areaIdCounts = new Map<string, number>();
  for (const a of state.fareAreas) {
    if (!a.area_id) {
      messages.push(msg('error', 'A fare area is missing area_id.', 'area'));
      continue;
    }
    areaIdCounts.set(a.area_id, (areaIdCounts.get(a.area_id) ?? 0) + 1);
  }
  for (const [areaId, count] of areaIdCounts) {
    if (count > 1) {
      messages.push(msg(
        'error',
        `Fare area "${areaId}" is defined ${count} times in areas.txt — area_id must be unique.`,
        'area', areaId,
      ));
    }
  }
  const areaIdSet = new Set(areaIdCounts.keys());
  // De-dup the orphan/missing references so a feed with many bad rows surfaces
  // one message per offending area_id / stop_id rather than dozens.
  const reportedOrphanArea = new Set<string>();
  const reportedMissingStop = new Set<string>();
  const seenStopAreaPairs = new Set<string>();
  for (const sa of state.stopAreas) {
    if (sa.area_id && !areaIdSet.has(sa.area_id) && !reportedOrphanArea.has(sa.area_id)) {
      reportedOrphanArea.add(sa.area_id);
      messages.push(msg(
        'error',
        `stop_areas references non-existent area "${sa.area_id}" (no matching row in areas.txt).`,
        'stop_area', sa.area_id,
      ));
    }
    if (sa.stop_id && !stopIdSet.has(sa.stop_id) && !reportedMissingStop.has(sa.stop_id)) {
      reportedMissingStop.add(sa.stop_id);
      messages.push(msg(
        'error',
        `stop_areas references non-existent stop "${sa.stop_id}".`,
        'stop_area', sa.stop_id,
      ));
    }
    // Duplicate (area_id, stop_id) mapping — harmless but redundant; flag once.
    const key = `${sa.area_id} ${sa.stop_id}`;
    if (sa.area_id && sa.stop_id) {
      if (seenStopAreaPairs.has(key)) {
        messages.push(msg(
          'warning',
          `Stop "${sa.stop_id}" is assigned to area "${sa.area_id}" more than once in stop_areas.`,
          'stop_area', sa.area_id,
        ));
      } else {
        seenStopAreaPairs.add(key);
      }
    }
  }

  return messages;
}
