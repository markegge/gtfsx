import type { ValidationMessage } from '../types/ui';
import type { AppStore } from '../store';
import { featureEnabled } from '../store/featuresSlice';
import { flexZoneHasGroup, flexZoneHasPolygons, flexZoneShape, type FlexZone } from '../store/flexSlice';
import { gtfsTimeToSeconds, secondsToGtfsTime, formatTimeShort } from '../utils/time';
import { getUSHolidaysInRange, serviceRunsOnDate } from '../utils/holidays';
import { findBlockOverlaps } from './blockBuilder';
import { unreachableTimetableTripIds } from '../components/ui/shapePatterns';
// Imported from the PURE plan module, not shapesFromStops.ts: the latter pulls in
// snapToRoad, whose module-scope `import.meta.env` read throws under plain Node,
// which would make this file (and the whole validation graph) unloadable in the
// tsx editor-test harness.
import { feedNeedsShapes } from './shapesFromStopsPlan';
import {
  findDecreasingShapeDistances,
  findDecreasingStopTimeDistances,
  findFastTravel,
  findStopsTooFarFromShape,
  checkFeedExpiry,
  findRouteLongNameContainsShort,
  findRouteSameNameAndDesc,
  findDuplicateRouteNames,
} from './validationQuality';

// Stable codes for validation rules the user can dismiss per feed. The code is
// attached to EVERY message a rule emits (a rule can emit one message per
// service/entity), so dismissing it silences the whole class for the current
// feed. Dismissal is persisted with the feed (IndexedDB + server), never global
// — a different feed still shows the rule. See store/validationSlice.ts.
export const VALIDATION_CODES = {
  // #17 holiday-exception nudge: a service runs on a major US holiday with no
  // calendar_dates exception. A soft "most agencies run a holiday schedule"
  // reminder, not a real defect — hence dismissible.
  holidayExceptions: 'holiday-exceptions',
  // A calendar_dates exception that doesn't change service: a "no service"
  // (exception_type 2) row on a day the weekly pattern is already off, or an
  // "added service" (exception_type 1) row on a day it already runs. Harmless
  // but noisy — a common artifact of bulk holiday-adders and rough imports —
  // so it's a dismissible cleanup nudge, not a hard error.
  redundantException: 'redundant-calendar-exception',
  // The feed has no route geometry at all (shapes.txt). Common for feeds
  // built with National RTAP's GTFS Builder, which leaves shapes as an
  // optional step. A real gap for rider apps (straight-line polylines instead
  // of street-following ones), but some agencies genuinely don't want
  // geometry (e.g. a hand-drawn ferry alignment they'll add later) — so it's
  // dismissible like the other soft nudges above.
  noShapeGeometry: 'no-shape-geometry',

  // #50 feed-expiry heads-up: feed_info.feed_end_date (or, absent that, the
  // latest calendar end_date) falls inside MobilityData's 7/30-day pre-expiry
  // windows. A soft "extend the feed before it lapses" nudge that auto-clears on
  // renewal, so it's dismissible for a publisher who's shipping a short-lived
  // feed on purpose.
  feedExpirySoon: 'feed-expiry-soon',

  // ── NTD reporting (FTA) ────────────────────────────────────────────────
  // FTA's July 10, 2025 final notice (FR 2025-12813) made agency_id
  // NON-conditional — i.e. always required — for NTD reporters, including in
  // routes.txt, because FTA crosswalks a feed to the agency's NTD ID (via the
  // P-50 form) on agency_id. The GTFS spec is looser (agency_id may be omitted
  // in a single-agency feed), so a perfectly spec-legal feed can still break an
  // agency's NTD reporting. Both codes are warnings, not errors, and both are
  // dismissible: an agency that knowingly doesn't report to the NTD can silence
  // them. Kept as two codes so the (real, spec-level) multi-agency defect and
  // the (advisory, spec-legal) single-agency nudge dismiss independently.
  ntdMissingAgencyId: 'ntd-missing-agency-id',
  ntdSingleAgencyNoAgencyId: 'ntd-single-agency-no-agency-id',

  // ── GTFS-Flex (gtfs.org/community/extensions/flex) ─────────────────────
  // One code per spec rule, named after the canonical MobilityData notice it
  // mirrors so tests/external/validator-parity-mapping.ts can line the two
  // vocabularies up 1:1. Zone/geography shape:
  flexNoServiceArea: 'flex-no-service-area',
  flexEmptyStopGroup: 'flex-empty-stop-group',
  flexDuplicateGroupStop: 'flex-duplicate-group-stop',
  flexUnknownGroupStop: 'flex-unknown-group-stop',
  flexDuplicateGeographyId: 'flex-duplicate-geography-id',
  flexUnsupportedGeometry: 'flex-unsupported-geometry-type',
  flexInvalidGeometry: 'flex-invalid-geometry',
  // Service window + calendar:
  flexNoPickupWindow: 'flex-no-pickup-window',
  flexMalformedWindow: 'flex-malformed-pickup-drop-off-window',
  flexInvalidWindow: 'flex-invalid-pickup-drop-off-window',
  flexNoServicePattern: 'flex-no-service-pattern',
  flexUnknownServicePattern: 'flex-unknown-service-pattern',
  // booking_rules.txt — conditional requirements keyed on booking_type:
  flexMissingBookingRule: 'flex-missing-pickup-drop-off-booking-rule-id',
  flexInvalidBookingType: 'flex-invalid-booking-type',
  flexMissingPriorNoticeDurationMin: 'flex-missing-prior-notice-duration-min',
  flexInvalidPriorNoticeDurationMin: 'flex-invalid-prior-notice-duration-min',
  flexMissingPriorNoticeLastDay: 'flex-missing-prior-notice-last-day',
  flexMissingPriorNoticeLastTime: 'flex-missing-prior-notice-last-time',
  flexMissingPriorNoticeStartTime: 'flex-missing-prior-notice-start-time',
  flexForbiddenRealTimeBookingField: 'flex-forbidden-real-time-booking-field-value',
  flexForbiddenSameDayBookingField: 'flex-forbidden-same-day-booking-field-value',
  flexForbiddenPriorDayBookingField: 'flex-forbidden-prior-day-booking-field-value',
  flexForbiddenPriorNoticeStartDay: 'flex-forbidden-prior-notice-start-day',
  flexForbiddenPriorNoticeStartTime: 'flex-forbidden-prior-notice-start-time',
  flexPriorNoticeLastDayAfterStartDay: 'flex-prior-notice-last-day-after-start-day',
  flexUnknownPriorNoticeService: 'flex-unknown-prior-notice-service',
} as const;

// Human label for each dismissible rule, shown in the validation panel's
// "dismissed" drawer so a silenced rule stays identifiable and restorable.
export const DISMISSIBLE_RULE_LABELS: Record<string, string> = {
  [VALIDATION_CODES.holidayExceptions]: 'Holiday calendar_dates reminders',
  [VALIDATION_CODES.redundantException]: 'Redundant calendar_dates exceptions',
  [VALIDATION_CODES.noShapeGeometry]: 'No route geometry (shapes.txt) reminder',
  [VALIDATION_CODES.feedExpirySoon]: 'Feed expiring soon (7/30-day heads-up)',

  [VALIDATION_CODES.ntdMissingAgencyId]: 'Missing agency_id (required in a multi-agency feed; NTD reporting)',
  [VALIDATION_CODES.ntdSingleAgencyNoAgencyId]: 'Single-agency feed omits agency_id (NTD reporting advisory)',

  [VALIDATION_CODES.flexNoServiceArea]: 'Flex zone has no service area',
  [VALIDATION_CODES.flexEmptyStopGroup]: 'Flex stop group has no stops',
  [VALIDATION_CODES.flexDuplicateGroupStop]: 'Flex stop group lists a stop twice',
  [VALIDATION_CODES.flexUnknownGroupStop]: 'Flex stop group references a missing stop',
  [VALIDATION_CODES.flexDuplicateGeographyId]: 'Flex geography id collides with another id',
  [VALIDATION_CODES.flexUnsupportedGeometry]: 'Flex zone geometry is not a polygon',
  [VALIDATION_CODES.flexInvalidGeometry]: 'Flex zone polygon is malformed',
  [VALIDATION_CODES.flexNoPickupWindow]: 'Flex zone has no pickup/drop-off window',
  [VALIDATION_CODES.flexMalformedWindow]: 'Flex pickup/drop-off window is not HH:MM:SS',
  [VALIDATION_CODES.flexInvalidWindow]: 'Flex pickup/drop-off window ends before it starts',
  [VALIDATION_CODES.flexNoServicePattern]: 'Flex zone has no service pattern',
  [VALIDATION_CODES.flexUnknownServicePattern]: 'Flex zone references a missing service pattern',
  [VALIDATION_CODES.flexMissingBookingRule]: 'Flex zone has no booking rule',
  [VALIDATION_CODES.flexInvalidBookingType]: 'Booking rule has an invalid booking_type',
  [VALIDATION_CODES.flexMissingPriorNoticeDurationMin]: 'Same-day booking is missing prior_notice_duration_min',
  [VALIDATION_CODES.flexInvalidPriorNoticeDurationMin]: 'prior_notice_duration_max is below prior_notice_duration_min',
  [VALIDATION_CODES.flexMissingPriorNoticeLastDay]: 'Prior-day booking is missing prior_notice_last_day',
  [VALIDATION_CODES.flexMissingPriorNoticeLastTime]: 'Prior-day booking is missing prior_notice_last_time',
  [VALIDATION_CODES.flexMissingPriorNoticeStartTime]: 'Booking rule is missing prior_notice_start_time',
  [VALIDATION_CODES.flexForbiddenRealTimeBookingField]: 'Real-time booking sets a forbidden prior-notice field',
  [VALIDATION_CODES.flexForbiddenSameDayBookingField]: 'Same-day booking sets a forbidden prior-notice field',
  [VALIDATION_CODES.flexForbiddenPriorDayBookingField]: 'Prior-day booking sets a forbidden prior-notice field',
  [VALIDATION_CODES.flexForbiddenPriorNoticeStartDay]: 'prior_notice_start_day is forbidden here',
  [VALIDATION_CODES.flexForbiddenPriorNoticeStartTime]: 'prior_notice_start_time is forbidden here',
  [VALIDATION_CODES.flexPriorNoticeLastDayAfterStartDay]: 'Booking closes before it opens',
  [VALIDATION_CODES.flexUnknownPriorNoticeService]: 'Booking rule references a missing service pattern',
};

let msgId = 0;
function msg(
  severity: 'error' | 'warning',
  message: string,
  entity_type?: string,
  entity_id?: string,
  code?: string,
): ValidationMessage {
  return { id: String(++msgId), severity, message, entity_type, entity_id, code };
}

/** GTFS YYYYMMDD → YYYY-MM-DD for human-readable messages. */
function prettyGtfs(d: string): string {
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
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
    // entity_type 'agency' so ValidationPanel deep-links this to the Agency panel.
    messages.push(msg('error', 'At least one agency is required', 'agency'));
  } else {
    for (const a of state.agencies) {
      if (!a.agency_name) messages.push(msg('error', `Agency "${a.agency_id}" is missing a name`, 'agency', a.agency_id));
      if (!a.agency_timezone) messages.push(msg('error', `Agency "${a.agency_id}" is missing a timezone`, 'agency', a.agency_id));
    }
  }

  // agency_id presence — GTFS spec + FTA NTD reporting (see VALIDATION_CODES).
  // Silent on an empty feed: "At least one agency is required" above already
  // covers that, and nagging about agency_id on a feed with no agency is noise.
  const blank = (v: string | undefined) => !v || !v.trim();
  if (state.agencies.length > 1) {
    // Multi-agency: the GTFS spec itself requires agency_id here, so this is a
    // real defect, not just an NTD one. Per-entity so each row is fixable.
    for (const a of state.agencies) {
      if (blank(a.agency_id)) {
        messages.push(msg(
          'warning',
          `Agency "${a.agency_name || '(unnamed)'}" is missing an agency_id, which is required in a feed with more than one agency. Give it a stable id (e.g. "MTA") and reference that id from its routes — FTA crosswalks the feed to your NTD ID on agency_id.`,
          'agency',
          a.agency_id || undefined,
          VALIDATION_CODES.ntdMissingAgencyId,
        ));
      }
    }
    for (const r of state.routes) {
      if (blank(r.agency_id)) {
        messages.push(msg(
          'warning',
          `Route "${r.route_short_name || r.route_long_name || r.route_id}" is missing an agency_id, which is required in routes.txt when the feed has more than one agency. Set it to the agency_id of the agency that operates the route, so riders and FTA can tell whose service it is.`,
          'route',
          r.route_id,
          VALIDATION_CODES.ntdMissingAgencyId,
        ));
      }
    }
  } else if (state.agencies.length === 1) {
    // Single agency: omitting agency_id is spec-legal, so this is ADVISORY and
    // is emitted at most ONCE for the whole feed (never once per route).
    const agencyRowMissing = blank(state.agencies[0].agency_id);
    const routesMissing = state.routes.filter((r) => blank(r.agency_id)).length;
    if (agencyRowMissing || routesMissing > 0) {
      const where = agencyRowMissing && routesMissing > 0
        ? `agencies.txt and on ${routesMissing} route${routesMissing === 1 ? '' : 's'}`
        : agencyRowMissing
          ? 'agencies.txt'
          : `${routesMissing} route${routesMissing === 1 ? '' : 's'} in routes.txt`;
      messages.push(msg(
        'warning',
        `agency_id is not set in ${where}. That is allowed by the GTFS spec in a single-agency feed, but FTA's July 2025 final notice (FR 2025-12813) made agency_id non-conditional for NTD reporters — including in routes.txt — and FTA cannot crosswalk this feed to your NTD ID without it. If you report to the NTD, set a stable agency_id on the agency and on every route; otherwise dismiss this warning.`,
        'agency',
        state.agencies[0].agency_id || undefined,
        VALIDATION_CODES.ntdSingleAgencyNoAgencyId,
      ));
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
  // A demand-response-only feed has no routes.txt rows in the editor: the flex
  // route is synthesized per zone at export time. So "no routes" is only a
  // finding when nothing will materialize one either.
  const flexZonesMaterializingTrips = state.flexZones.filter(
    (z) => z.pickupWindowStart && z.pickupWindowEnd,
  );
  if (state.routes.length === 0) {
    if (flexZonesMaterializingTrips.length === 0) {
      messages.push(msg('warning', 'No routes defined'));
    }
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

  // Stop checks. Per the GTFS spec, stop_name is required only for stops/
  // platforms (location_type 0), stations (1) and entrances/exits (2); it is
  // optional for generic nodes (3) and boarding areas (4).
  for (const s of state.stops) {
    const lt = s.location_type ?? 0;
    if (!s.stop_name && lt <= 2) messages.push(msg('error', `Stop "${s.stop_id}" is missing a name`, 'stop', s.stop_id));
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
    const wcMsg = msg(
      'warning',
      `${missingWheelchair} of ${boardPoints.length} stops (${pct}%) are missing wheelchair_boarding — riders see "no accessibility information." Open the Fix recipe to pick a value (accessible / not accessible / no info) and fill them all, or set stops individually in Stop Analysis → Accessibility.`,
      'stop',
    );
    wcMsg.fix = { id: 'fill-missing-wheelchair' };
    messages.push(wcMsg);
  }

  // "Ghost" trips: unreachable in the timetable editor. Once a route has a real
  // shape the timetable filters trips by shape_id, so a trip with no/unknown
  // shape on that route matches no pattern selector and becomes invisible AND
  // undeletable in the grid (the reported repro: an outbound timetable built
  // before any shape existed, then an inbound shape drawn → outbound trips
  // vanish). Surface them with a one-click bulk delete. Computed once (O(n)).
  const ghostTripIds = unreachableTimetableTripIds(state.trips, state.routeStops);

  // Trip checks (using pre-built indexes — O(n) not O(n²))
  for (const t of state.trips) {
    if (!routeIdSet.has(t.route_id)) {
      messages.push(msg('error', `Trip "${t.trip_id}" references non-existent route "${t.route_id}"`, 'trip', t.trip_id));
    }
    if (!serviceIdSet.has(t.service_id)) {
      const m = msg('warning', `Trip "${t.trip_id}" references non-existent calendar "${t.service_id}"`, 'trip', t.trip_id);
      m.fix = { id: 'remove-orphan-trips' };
      messages.push(m);
    }
    if (!stopTimesByTrip.has(t.trip_id)) {
      messages.push(msg('warning', `Trip "${t.trip_id}" has no stop times`, 'trip', t.trip_id));
    }
    if (ghostTripIds.has(t.trip_id)) {
      const m = msg(
        'warning',
        `Trip "${t.trip_id}" can't be reached in the timetable editor — its route has shapes but this trip has no matching shape, so the grid hides it. Open the Fix recipe to delete it (and its stop times), or assign it a shape.`,
        'trip',
        t.trip_id,
      );
      m.fix = { id: 'remove-ghost-trips' };
      messages.push(m);
    }
  }

  // Bad stop references in stop_times
  for (const sid of badStopRefs) {
    messages.push(msg('error', `Stop time references non-existent stop "${sid}"`, 'stop_time'));
  }

  // A trip's first and last SERVED stops must be TIMED. "Served" = the stop
  // has a stop_time row; skipped stops have no row, so they drop out of the
  // sequence and the endpoints become the adjacent served stops (computing
  // first/last from the existing rows handles this automatically). An
  // interpolated stop (served, blank times) is only valid for intermediate
  // stops — at an endpoint it leaves the trip with no defined start/end time.
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
      const label = isFirst ? 'First' : 'Last';
      const blankBoth = !st.arrival_time && !st.departure_time;
      const m = msg(
        'error',
        blankBoth
          ? `${label} served stop of trip "${st.trip_id}" has no time. A trip's first and last stops must be timed — enter a time, or mark this stop skipped if the trip doesn't serve it.`
          : `${label} served stop of trip "${st.trip_id}" is missing arrival_time or departure_time — both are required on trip endpoints.`,
        'trip',
        st.trip_id,
      );
      // One-click fix is offered ONLY for the one-present variant: there's a
      // value to mirror into the blank field (set both equal). The both-blank
      // (interpolated) endpoint has no value to copy, so it stays a manual fix.
      if (!blankBoth) m.fix = { id: 'fill-trip-edge-times' };
      messages.push(m);
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

  // Parent station integrity. The required parent type depends on the child's
  // location_type per the GTFS spec:
  //   - boarding areas (4) must be parented by a platform/stop (location_type 0)
  //   - stops/platforms (0), entrances/exits (2) and generic nodes (3) must be
  //     parented by a station (location_type 1)
  const stationIds = new Set(state.stops.filter((s) => s.location_type === 1).map((s) => s.stop_id));
  const platformIds = new Set(state.stops.filter((s) => (s.location_type ?? 0) === 0).map((s) => s.stop_id));
  for (const s of state.stops) {
    if (!s.parent_station) continue;
    if (!stopIdSet.has(s.parent_station)) {
      messages.push(msg(
        'error',
        `Stop "${s.stop_name || s.stop_id}" references non-existent parent_station "${s.parent_station}".`,
        'stop', s.stop_id,
      ));
    } else if ((s.location_type ?? 0) === 4) {
      if (!platformIds.has(s.parent_station)) {
        messages.push(msg(
          'error',
          `Boarding area "${s.stop_name || s.stop_id}" parent_station "${s.parent_station}" is not a Platform (location_type=0).`,
          'stop', s.stop_id,
        ));
      }
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

  // Distance monotonicity (MobilityData decreasing_shape_distance /
  // decreasing_or_equal_stop_time_distance). The all-zero case above is a
  // different, benign situation the exporter repairs; here a REAL distance runs
  // backwards, which breaks stop-placement in consumers. Errors, per MobilityData.
  for (const f of findDecreasingShapeDistances(state.shapes)) {
    messages.push(msg(
      'error',
      `Shape "${f.shape_id}" has a shape_dist_traveled that decreases at point ${f.atSequence} (${f.thisDist} after ${f.prevDist}). shape_dist_traveled must increase along a shape, or apps can't place stops on it.`,
      'shape',
      f.shape_id,
    ));
  }
  for (const f of findDecreasingStopTimeDistances(state.trips, state.stopTimes)) {
    messages.push(msg(
      'error',
      `Trip "${f.trip_id}" has a shape_dist_traveled that does not increase at stop ${f.atSequence} — ${f.thisDist} is not greater than ${f.prevDist} at the previous stop. Stop distances must strictly increase along a trip.`,
      'trip',
      f.trip_id,
    ));
  }

  // Implausible travel speed (MobilityData fast_travel_between_consecutive_stops
  // / fast_travel_between_far_stops). The speed ceiling is per route_type (a
  // train may outrun a bus); minute-resolution times get a tolerance buffer so
  // rounded schedules don't false-positive. Warnings; no auto-fix (whether the
  // coordinates or the times are wrong is a judgement call).
  for (const f of findFastTravel(state.trips, state.stopTimes, state.stops, state.routes)) {
    const speed = Math.round(f.speedKph);
    const km = f.distanceKm.toFixed(1);
    messages.push(msg(
      'warning',
      f.kind === 'consecutive'
        ? `Trip "${f.trip_id}" travels implausibly fast between stops "${f.fromStopName}" and "${f.toStopName}" — ${speed} km/h over ${km} km, past the ${f.maxSpeedKph} km/h ceiling for this mode. Check the stop coordinates and the times.`
        : `Trip "${f.trip_id}" averages an implausible ${speed} km/h across ${km} km from "${f.fromStopName}" to "${f.toStopName}", past the ${f.maxSpeedKph} km/h ceiling for this mode. Check the stop coordinates and the times.`,
      'trip', f.trip_id,
    ));
  }

  // Stop too far from its shape (MobilityData stop_too_far_from_shape). The stop
  // projects more than 100 m from its trip's route alignment. Warning; entity is
  // the stop so the panel deep-links to it.
  for (const f of findStopsTooFarFromShape(state.trips, state.stopTimes, state.stops, state.shapes)) {
    messages.push(msg(
      'warning',
      `Stop "${f.stopName}" is ${Math.round(f.distanceMeters)} m from shape "${f.shape_id}" on route "${f.route_id}" — past the 100 m the alignment should stay within. Move the stop onto the route, or fix the shape.`,
      'stop', f.stop_id,
    ));
  }

  // Feed-expiry heads-up (MobilityData feed_expiration_date7_days / _30_days).
  // Complements the per-service "expired" warning above with a PRE-expiry nudge —
  // the silent failure #50 calls out for rural feeds. Dismissible per feed.
  {
    const now = new Date();
    const todayInt = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    const expiry = checkFeedExpiry(
      state.feedInfo?.feed_end_date,
      state.calendars.map((c) => c.end_date).filter((d): d is string => !!d),
      todayInt,
    );
    if (expiry) {
      const pretty = prettyGtfs(expiry.effectiveEndDate);
      const when = expiry.daysRemaining < 0
        ? `expired ${-expiry.daysRemaining} day${expiry.daysRemaining === -1 ? '' : 's'} ago`
        : expiry.daysRemaining === 0
          ? 'expires today'
          : `expires in ${expiry.daysRemaining} day${expiry.daysRemaining === 1 ? '' : 's'}`;
      const src = expiry.source === 'feed_info'
        ? `feed_info end date ${pretty}`
        : `latest service ends ${pretty}`;
      messages.push(msg(
        'warning',
        `This feed ${when} (${src}). Trip planners drop the feed once it lapses — extend the ${expiry.source === 'feed_info' ? 'feed_info end date and the calendars' : 'calendars'} before publishing.`,
        undefined, undefined,
        VALIDATION_CODES.feedExpirySoon,
      ));
    }
  }

  // Route-naming polish (MobilityData route_long_name_contains_short_name /
  // same_name_and_description_for_route / duplicate_route_name). Warnings.
  for (const f of findRouteLongNameContainsShort(state.routes)) {
    messages.push(msg(
      'warning',
      `Route "${f.longName}" restates its own short name "${f.shortName}" at the start of route_long_name — the long name should describe the route (e.g. its endpoints), not repeat the number.`,
      'route', f.route_id,
    ));
  }
  // same_name_and_description_for_route carries a one-click fix: clearing a
  // route_desc that only echoes the name is unambiguous and loses no information.
  for (const f of findRouteSameNameAndDesc(state.routes)) {
    const m = msg(
      'warning',
      `Route "${f.name}" has a route_desc identical to its ${f.which} name — a description that just repeats the name adds nothing. Clear it, or write a real description.`,
      'route', f.route_id,
    );
    m.fix = { id: 'clear-route-desc' };
    messages.push(m);
  }
  for (const f of findDuplicateRouteNames(state.routes)) {
    const ids = f.route_ids.join('", "');
    const label = f.shortName || f.longName || f.route_ids[0];
    messages.push(msg(
      'warning',
      `Routes "${ids}" share the same name ("${label}"), agency, and type — routes of one agency and mode should have a unique route_short_name / route_long_name combination.`,
      'route', f.route_ids[0],
    ));
  }

  // No route geometry at all — one feed-level nudge, not one per route/trip.
  // feedNeedsShapes is true when at least one trip has 2+ located stops but no
  // resolvable shape (see services/shapesFromStops.ts for the exact rule).
  // The fix is INTERACTIVE (opens ShapesFromStopsDialog rather than a
  // one-click apply — see services/validationFixes.ts), because generating
  // geometry is async, calls out to Mapbox, and needs a mode choice.
  if (feedNeedsShapes(state.trips, state.stopTimes, state.stops, state.shapes)) {
    const m = msg(
      'warning',
      'This feed has no route geometry (shapes.txt), so trip planners will draw straight '
      + 'lines between stops instead of following the streets. Open the Fix recipe to '
      + 'generate shapes automatically.',
      undefined,
      undefined,
      VALIDATION_CODES.noShapeGeometry,
    );
    m.fix = { id: 'generate-shapes-from-stops' };
    messages.push(m);
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

  // Unused stops. A stop belonging to a flex zone's stop group IS used — it is
  // served via location_group_stops.txt, not stop_times.txt — so it must not be
  // reported as an orphan (and must never be offered the delete-unused fix).
  const flexGroupStopIds = new Set<string>();
  for (const z of state.flexZones) {
    for (const sid of z.stopIds ?? []) flexGroupStopIds.add(sid);
  }
  if (state.stopTimes.length > 0) {
    for (const s of state.stops) {
      if (!usedStopIds.has(s.stop_id) && !flexGroupStopIds.has(s.stop_id)) {
        const m = msg('warning', `Stop "${s.stop_name || s.stop_id}" is not used by any trip`, 'stop', s.stop_id);
        m.fix = { id: 'delete-unused-stop' };
        messages.push(m);
      }
    }
  }

  // ── GTFS-Flex (gtfs.org/community/extensions/flex) ─────────────────────────
  // One consolidated pass over the zones: service-area shape, geography-id
  // namespace, GeoJSON geometry, pickup/drop-off window, service pattern, and
  // the booking_rules.txt conditional requirements. Deliberately UNGATED by the
  // `demandResponse` feature flag — a zone that exists must be validated even if
  // the user later switched the feature off, or its problems would go silent.
  if (state.flexZones.length > 0) {
    const flexMsg = (
      severity: 'error' | 'warning', text: string, zone: FlexZone, code: string,
    ) => messages.push(msg(severity, text, 'flex_zone', zone.id, code));
    const zoneLabel = (z: FlexZone) => z.name || z.id;
    // A booking-rule field counts as "set" only when it carries a real value —
    // an empty string from a CSV import is the same as absent.
    const isSet = (v: unknown) => v !== undefined && v !== null && v !== '';
    const andList = (fields: string[]) =>
      fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`;

    const timeOk = (s?: string) => !s || /^\d{1,2}:\d{2}:\d{2}$/.test(s);
    // Every service_id a zone may legitimately name, from either calendar file.
    const flexServiceIds = new Set(serviceIdSet);
    for (const d of state.calendarDates) flexServiceIds.add(d.service_id);
    // ...but only calendar.txt yields an exportable trip: materializeFlex falls
    // back to calendars[0] and SKIPS the zone when there is no calendar row at
    // all, so a dates-only feed silently drops every flex trip.
    const zoneHasExportableService = (z: FlexZone) =>
      (!!z.serviceId && serviceIdSet.has(z.serviceId)) || state.calendars.length > 0;

    // GTFS-Flex shares ONE id namespace across stops.stop_id, the
    // locations.geojson feature ids, and location_groups.location_group_id. Map
    // every id a zone contributes back to its owners so a collision names both.
    const geographyOwners = new Map<string, { label: string; zone?: FlexZone }[]>();
    const claim = (id: string, label: string, zone?: FlexZone) => {
      const list = geographyOwners.get(id) ?? [];
      list.push({ label, zone });
      geographyOwners.set(id, list);
    };
    for (const s of state.stops) claim(s.stop_id, `stop "${s.stop_name || s.stop_id}"`);

    // The window checks apply to the primary window AND to each additional
    // window (each materializes its own trip + stop_times rows).
    const checkWindow = (zone: FlexZone, start: string, end: string, where: string) => {
      if (!timeOk(start)) {
        flexMsg('error', `Flex zone "${zoneLabel(zone)}"${where} start_pickup_drop_off_window "${start}" must be HH:MM:SS.`, zone, VALIDATION_CODES.flexMalformedWindow);
      }
      if (!timeOk(end)) {
        flexMsg('error', `Flex zone "${zoneLabel(zone)}"${where} end_pickup_drop_off_window "${end}" must be HH:MM:SS.`, zone, VALIDATION_CODES.flexMalformedWindow);
      }
      if (timeOk(start) && timeOk(end) && gtfsTimeToSeconds(end) <= gtfsTimeToSeconds(start)) {
        flexMsg('error', `Flex zone "${zoneLabel(zone)}"${where} pickup/drop-off window ends (${end}) at or before it starts (${start}) — riders would have no time to book.`, zone, VALIDATION_CODES.flexInvalidWindow);
      }
    };

    for (const zone of state.flexZones) {
      const label = zoneLabel(zone);
      const shape = flexZoneShape(zone);
      const hasWindow = !!(zone.pickupWindowStart && zone.pickupWindowEnd);
      const hasStops = (zone.stopIds?.length ?? 0) > 0;

      // ── Service area ─────────────────────────────────────────────────────
      if (shape === 'empty') {
        flexMsg('warning', `Flex zone "${label}" has no service area — add a polygon or a stop group, or remove the zone.`, zone, VALIDATION_CODES.flexNoServiceArea);
      }
      if (flexZoneHasGroup(zone)) {
        if (!hasStops) {
          flexMsg('warning', `Flex zone "${label}" has a stop group with no stops. Add stops to the group${flexZoneHasPolygons(zone) ? ' or remove the group to keep this a polygon-only zone' : ''}.`, zone, VALIDATION_CODES.flexEmptyStopGroup);
        }
        const seen = new Set<string>();
        for (const sid of zone.stopIds ?? []) {
          if (seen.has(sid)) {
            flexMsg('warning', `Flex zone "${label}" lists stop "${sid}" in its group more than once.`, zone, VALIDATION_CODES.flexDuplicateGroupStop);
            continue;
          }
          seen.add(sid);
          if (!stopIdSet.has(sid)) {
            flexMsg('error', `Flex zone "${label}" references stop "${sid}" in its group, but no such stop exists.`, zone, VALIDATION_CODES.flexUnknownGroupStop);
          }
        }
      }

      // ── Geometry (locations.geojson) ─────────────────────────────────────
      // Our drawing tools only ever produce Polygons, but an imported feed can
      // carry any geometry type or a degenerate ring straight into the store.
      for (const feature of zone.geojson?.features ?? []) {
        const geom = feature.geometry;
        if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
          flexMsg('error', `Flex zone "${label}" has a ${geom?.type || 'missing'} feature in locations.geojson — a flex location must be a Polygon or MultiPolygon.`, zone, VALIDATION_CODES.flexUnsupportedGeometry);
          continue;
        }
        const rings = geom.type === 'Polygon'
          ? [geom.coordinates]
          : geom.coordinates;
        const bad = rings.some((polygon) =>
          !Array.isArray(polygon) || polygon.length === 0 || polygon.some((ring) => {
            if (!Array.isArray(ring) || ring.length < 4) return true;
            const first = ring[0];
            const last = ring[ring.length - 1];
            return !Array.isArray(first) || !Array.isArray(last)
              || first[0] !== last[0] || first[1] !== last[1];
          }),
        );
        if (bad) {
          flexMsg('error', `Flex zone "${label}" has an invalid polygon in locations.geojson — every ring needs at least 4 positions and must close (first position = last).`, zone, VALIDATION_CODES.flexInvalidGeometry);
        }
      }

      // The geography ids this zone contributes, matching what the exporter
      // writes: the zone id for its polygon location, `${id}-group` for its
      // (non-empty) stop group.
      if (flexZoneHasPolygons(zone)) claim(zone.id, `flex zone "${label}"`, zone);
      if (flexZoneHasGroup(zone) && hasStops) claim(`${zone.id}-group`, `flex zone "${label}" stop group`, zone);

      // ── Pickup/drop-off window ───────────────────────────────────────────
      if (!hasWindow) {
        flexMsg('warning', `Flex zone "${label}" has no pickup/drop-off window set, so it won't be exported as a flex trip. Set a start + end time in the zone's Details.`, zone, VALIDATION_CODES.flexNoPickupWindow);
      } else {
        checkWindow(zone, zone.pickupWindowStart!, zone.pickupWindowEnd!, '');
      }
      (zone.additionalWindows ?? []).forEach((w, i) => {
        if (!w.pickupWindowStart || !w.pickupWindowEnd) return;
        checkWindow(zone, w.pickupWindowStart, w.pickupWindowEnd, ` additional window ${i + 1}`);
      });

      // ── Service pattern ──────────────────────────────────────────────────
      if (hasWindow) {
        if (zone.serviceId && !flexServiceIds.has(zone.serviceId)) {
          flexMsg('error', `Flex zone "${label}" references service_id "${zone.serviceId}", which no longer exists.`, zone, VALIDATION_CODES.flexUnknownServicePattern);
        } else if (!zoneHasExportableService(zone)) {
          flexMsg('error', `Flex zone "${label}" has no service pattern in calendar.txt, so it can't be exported as a flex trip. Pick a calendar in the zone's Details.`, zone, VALIDATION_CODES.flexNoServicePattern);
        }
      }

      // ── booking_rules.txt ────────────────────────────────────────────────
      const rule = zone.bookingRule;
      // pickup_type / drop_off_type 2 = "phone the agency", which the spec ties
      // to a booking rule. These are the values the exporter actually writes
      // (it clamps the window-forbidden 0/3 back to 2), so check the clamped
      // value, not the raw one.
      const pickupType = zone.pickupType === 1 || zone.pickupType === 2 ? zone.pickupType : 2;
      const dropOffType = zone.dropOffType === 1 || zone.dropOffType === 2 || zone.dropOffType === 3
        ? zone.dropOffType : 2;
      if (!rule && (pickupType === 2 || dropOffType === 2)) {
        flexMsg('warning', `Flex zone "${label}" has pickup_type/drop_off_type 2 ("phone the agency") but no booking rule — riders won't know how to request service. Add one in the zone's Details.`, zone, VALIDATION_CODES.flexMissingBookingRule);
      }

      if (rule) {
        const bt = rule.bookingType;
        const durationMin = isSet(rule.priorNoticeDurationMin);
        const durationMax = isSet(rule.priorNoticeDurationMax);
        const lastDay = isSet(rule.priorNoticeLastDay);
        const lastTime = isSet(rule.priorNoticeLastTime);
        const startDay = isSet(rule.priorNoticeStartDay);
        const startTime = isSet(rule.priorNoticeStartTime);
        const bookingServiceId = isSet(rule.priorNoticeServiceId);
        const forbidden = (pairs: [string, boolean][]) =>
          pairs.filter(([, set]) => set).map(([field]) => field);

        if (bt !== 0 && bt !== 1 && bt !== 2) {
          flexMsg('error', `Flex zone "${label}" booking rule has booking_type "${bt}" — must be 0 (real time), 1 (same day) or 2 (prior day).`, zone, VALIDATION_CODES.flexInvalidBookingType);
        } else if (bt === 0) {
          // Real-time booking takes no prior notice: every prior_notice_* field
          // is forbidden.
          const bad = forbidden([
            ['prior_notice_duration_min', durationMin],
            ['prior_notice_duration_max', durationMax],
            ['prior_notice_last_day', lastDay],
            ['prior_notice_last_time', lastTime],
            ['prior_notice_start_day', startDay],
            ['prior_notice_start_time', startTime],
            ['prior_notice_service_id', bookingServiceId],
          ]);
          if (bad.length > 0) {
            flexMsg('error', `Flex zone "${label}" books in real time (booking_type=0), so ${andList(bad)} must be empty — real-time booking takes no prior notice.`, zone, VALIDATION_CODES.flexForbiddenRealTimeBookingField);
          }
        } else if (bt === 1) {
          // Same-day booking: duration_min required; the prior-DAY fields are
          // forbidden; start_day is optional but conflicts with duration_max.
          if (!durationMin) {
            flexMsg('error', `Flex zone "${label}" books same day (booking_type=1) but sets no prior_notice_duration_min — the spec requires it (minutes of advance notice).`, zone, VALIDATION_CODES.flexMissingPriorNoticeDurationMin);
          }
          const bad = forbidden([
            ['prior_notice_last_day', lastDay],
            ['prior_notice_last_time', lastTime],
            ['prior_notice_service_id', bookingServiceId],
          ]);
          if (bad.length > 0) {
            flexMsg('error', `Flex zone "${label}" books same day (booking_type=1), so ${andList(bad)} must be empty — ${bad.length === 1 ? 'that field is' : 'those fields are'} only for prior-day booking (booking_type=2).`, zone, VALIDATION_CODES.flexForbiddenSameDayBookingField);
          }
          if (startDay && durationMax) {
            flexMsg('error', `Flex zone "${label}" booking rule sets both prior_notice_start_day and prior_notice_duration_max — on same-day booking they are mutually exclusive.`, zone, VALIDATION_CODES.flexForbiddenPriorNoticeStartDay);
          }
          if (startDay && !startTime) {
            flexMsg('error', `Flex zone "${label}" booking rule sets prior_notice_start_day but no prior_notice_start_time — the time is required whenever the day is set.`, zone, VALIDATION_CODES.flexMissingPriorNoticeStartTime);
          }
        } else {
          // Prior-day booking: last_day AND last_time are each required — the
          // canonical validator flags them independently, so a rule missing both
          // gets both notices (don't chain them). The duration fields are
          // forbidden; start_time and start_day imply each other.
          if (!lastDay) {
            flexMsg('error', `Flex zone "${label}" books a prior day (booking_type=2) but sets no prior_notice_last_day — the spec requires it (how many days ahead booking closes).`, zone, VALIDATION_CODES.flexMissingPriorNoticeLastDay);
          }
          if (!lastTime) {
            flexMsg('error', `Flex zone "${label}" books a prior day (booking_type=2) but sets no prior_notice_last_time — the spec requires the time of day booking closes.`, zone, VALIDATION_CODES.flexMissingPriorNoticeLastTime);
          }
          const bad = forbidden([
            ['prior_notice_duration_min', durationMin],
            ['prior_notice_duration_max', durationMax],
          ]);
          if (bad.length > 0) {
            flexMsg('error', `Flex zone "${label}" books a prior day (booking_type=2), so ${andList(bad)} must be empty — ${bad.length === 1 ? 'that field is' : 'those fields are'} only for same-day booking (booking_type=1).`, zone, VALIDATION_CODES.flexForbiddenPriorDayBookingField);
          }
          if (startTime && !startDay) {
            flexMsg('error', `Flex zone "${label}" booking rule sets prior_notice_start_time but no prior_notice_start_day — the time is forbidden without the day.`, zone, VALIDATION_CODES.flexForbiddenPriorNoticeStartTime);
          }
          if (startDay && !startTime) {
            flexMsg('error', `Flex zone "${label}" booking rule sets prior_notice_start_day but no prior_notice_start_time — the time is required whenever the day is set.`, zone, VALIDATION_CODES.flexMissingPriorNoticeStartTime);
          }
          if (lastDay && startDay && Number(rule.priorNoticeLastDay) > Number(rule.priorNoticeStartDay)) {
            flexMsg('error', `Flex zone "${label}" booking closes ${rule.priorNoticeLastDay} days ahead but only opens ${rule.priorNoticeStartDay} days ahead — prior_notice_last_day must not be greater than prior_notice_start_day.`, zone, VALIDATION_CODES.flexPriorNoticeLastDayAfterStartDay);
          }
        }

        if (durationMin && durationMax
          && Number(rule.priorNoticeDurationMax) < Number(rule.priorNoticeDurationMin)) {
          flexMsg('error', `Flex zone "${label}" booking rule has prior_notice_duration_max (${rule.priorNoticeDurationMax}) below prior_notice_duration_min (${rule.priorNoticeDurationMin}).`, zone, VALIDATION_CODES.flexInvalidPriorNoticeDurationMin);
        }
        if (bookingServiceId && !flexServiceIds.has(String(rule.priorNoticeServiceId))) {
          flexMsg('error', `Flex zone "${label}" booking rule references prior_notice_service_id "${rule.priorNoticeServiceId}", which no longer exists.`, zone, VALIDATION_CODES.flexUnknownPriorNoticeService);
        }
      }
    }

    // ── Shared geography-id namespace ──────────────────────────────────────
    for (const [id, owners] of geographyOwners) {
      if (owners.length < 2) continue;
      const zone = owners.find((o) => o.zone)?.zone;
      if (!zone) continue;
      messages.push(msg(
        'error',
        `Geography id "${id}" is used by ${andList(owners.map((o) => o.label))} — stops.txt, locations.geojson and location_groups.txt share ONE id namespace, so each id must be unique across all three.`,
        'flex_zone', zone.id,
        VALIDATION_CODES.flexDuplicateGeographyId,
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
      if (!serviceRunsOnDate(c, h.gtfsDate)) continue;
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
        VALIDATION_CODES.holidayExceptions,
      ));
    }
  }

  // ── Redundant / off-service-day calendar_dates exceptions — dismissible ──
  // An exception is redundant when it duplicates what the weekly calendar
  // already does, so it changes nothing:
  //   • exception_type 2 ("no service") on a date the pattern doesn't serve
  //     (off weekday, or outside the active range) — removes nothing. This is
  //     exactly the phantom row a Sat/Sun holiday creates on a Mon–Fri service.
  //   • exception_type 1 ("added service") on a date the pattern already serves
  //     (running weekday inside the range) — adds nothing.
  // A service defined ONLY via calendar_dates (no calendar.txt row) is skipped:
  // there every row is load-bearing, so nothing is redundant. Consolidated to
  // one warning per service to avoid flooding the panel; dismissible per feed.
  const calendarById = new Map(state.calendars.map((c) => [c.service_id, c]));
  const redundantByService = new Map<string, string[]>();
  for (const cd of state.calendarDates) {
    const cal = calendarById.get(cd.service_id);
    if (!cal || !cd.date || cd.date.length !== 8) continue;
    if (cal.start_date.length !== 8 || cal.end_date.length !== 8) continue;
    const inRange = cd.date >= cal.start_date && cd.date <= cal.end_date;
    // Whether the plain weekly calendar already provides service on this date.
    const scheduled = inRange && serviceRunsOnDate(cal, cd.date);
    const redundant = cd.exception_type === 2 ? !scheduled : scheduled;
    if (!redundant) continue;
    const list = redundantByService.get(cd.service_id) ?? [];
    list.push(cd.date);
    redundantByService.set(cd.service_id, list);
  }
  for (const [serviceId, dates] of redundantByService) {
    const cal = calendarById.get(serviceId);
    const label = cal?._description || serviceId;
    const sorted = [...dates].sort();
    const preview = sorted.slice(0, 5).map(prettyGtfs).join(', ');
    const more = sorted.length > 5 ? `, +${sorted.length - 5} more` : '';
    const n = dates.length;
    messages.push(msg(
      'warning',
      `Service "${label}" has ${n} calendar_dates exception${n !== 1 ? 's' : ''} that match the regular weekly schedule and have no effect (${preview}${more}). Remove the redundant row${n !== 1 ? 's' : ''} to keep calendar_dates clean.`,
      'calendar', serviceId,
      VALIDATION_CODES.redundantException,
    ));
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

  // ── GTFS-Fares v2: the rest of the pricing chain (#32) ─────────────────────
  // Each file's editor enforces these at author time; we re-check here so an
  // imported feed (or a cascade we missed) still surfaces issues. Required
  // fields, id uniqueness, and foreign-key existence across networks, rider
  // categories, fare media/products, timeframes, and leg/transfer rules.
  const flagDuplicateIds = (
    items: { id?: string }[], file: string, field: string, entityType: string,
  ): Set<string> => {
    const counts = new Map<string, number>();
    for (const it of items) {
      if (!it.id) {
        messages.push(msg('error', `A row in ${file} is missing ${field}.`, entityType));
        continue;
      }
      counts.set(it.id, (counts.get(it.id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      if (n > 1) {
        messages.push(msg(
          'error',
          `${field} "${id}" is defined ${n} times in ${file} -- it must be unique.`,
          entityType, id,
        ));
      }
    }
    return new Set(counts.keys());
  };

  // networks.txt -- network_id unique.
  const networkIdSet = flagDuplicateIds(
    state.fareNetworks.map((n) => ({ id: n.network_id })),
    'networks.txt', 'network_id', 'network',
  );
  // route_networks.txt -- references must resolve; one route per network is the spec.
  const reportedRouteNetOrphan = new Set<string>();
  const reportedRouteNetMissingRoute = new Set<string>();
  const routeNetworkByRoute = new Map<string, string>();
  for (const rn of state.routeNetworks) {
    if (rn.network_id && !networkIdSet.has(rn.network_id) && !reportedRouteNetOrphan.has(rn.network_id)) {
      reportedRouteNetOrphan.add(rn.network_id);
      messages.push(msg('error', `route_networks references non-existent network "${rn.network_id}".`, 'route_network', rn.network_id));
    }
    if (rn.route_id && !routeIdSet.has(rn.route_id) && !reportedRouteNetMissingRoute.has(rn.route_id)) {
      reportedRouteNetMissingRoute.add(rn.route_id);
      messages.push(msg('error', `route_networks references non-existent route "${rn.route_id}".`, 'route_network', rn.route_id));
    }
    if (rn.route_id) {
      const prev = routeNetworkByRoute.get(rn.route_id);
      if (prev !== undefined && prev !== rn.network_id) {
        messages.push(msg('warning', `Route "${rn.route_id}" is assigned to more than one network -- most consumers expect one network per route.`, 'route_network', rn.route_id));
      } else {
        routeNetworkByRoute.set(rn.route_id, rn.network_id);
      }
    }
  }

  // rider_categories.txt -- id unique, name required, at most one default.
  const riderIdSet = flagDuplicateIds(
    state.riderCategories.map((c) => ({ id: c.rider_category_id })),
    'rider_categories.txt', 'rider_category_id', 'rider_category',
  );
  let defaultRiderCount = 0;
  for (const c of state.riderCategories) {
    if (c.rider_category_id && !c.rider_category_name) {
      messages.push(msg('error', `Rider category "${c.rider_category_id}" is missing rider_category_name.`, 'rider_category', c.rider_category_id));
    }
    if (c.is_default_fare_category === 1) defaultRiderCount++;
  }
  if (defaultRiderCount > 1) {
    messages.push(msg('warning', `${defaultRiderCount} rider categories are marked is_default_fare_category -- only one should be the default.`, 'rider_category'));
  }

  // fare_media.txt -- id unique, fare_media_type required (0-4).
  const mediaIdSet = flagDuplicateIds(
    state.fareMedia.map((m) => ({ id: m.fare_media_id })),
    'fare_media.txt', 'fare_media_id', 'fare_media',
  );
  for (const m of state.fareMedia) {
    if (m.fare_media_id && (m.fare_media_type == null || Number.isNaN(Number(m.fare_media_type)))) {
      messages.push(msg('error', `Fare medium "${m.fare_media_id}" is missing fare_media_type.`, 'fare_media', m.fare_media_id));
    }
  }

  // fare_products.txt -- id unique, amount + currency required, FK refs resolve.
  const productIdSet = flagDuplicateIds(
    state.fareProducts.map((p) => ({ id: p.fare_product_id })),
    'fare_products.txt', 'fare_product_id', 'fare_product',
  );
  for (const p of state.fareProducts) {
    if (!p.fare_product_id) continue;
    if (p.amount === '' || p.amount == null) {
      messages.push(msg('error', `Fare product "${p.fare_product_id}" is missing an amount.`, 'fare_product', p.fare_product_id));
    }
    if (!p.currency) {
      messages.push(msg('error', `Fare product "${p.fare_product_id}" is missing a currency.`, 'fare_product', p.fare_product_id));
    }
    if (p.rider_category_id && !riderIdSet.has(p.rider_category_id)) {
      messages.push(msg('error', `Fare product "${p.fare_product_id}" references non-existent rider category "${p.rider_category_id}".`, 'fare_product', p.fare_product_id));
    }
    if (p.fare_media_id && !mediaIdSet.has(p.fare_media_id)) {
      messages.push(msg('error', `Fare product "${p.fare_product_id}" references non-existent fare medium "${p.fare_media_id}".`, 'fare_product', p.fare_product_id));
    }
  }

  // timeframes.txt -- service_id required + must resolve; collect group ids.
  const calendarDateServiceIds = new Set(state.calendarDates.map((d) => d.service_id));
  const timeframeGroupIdSet = new Set<string>();
  const reportedTimeframeMissingService = new Set<string>();
  for (const tf of state.timeframes) {
    if (tf.timeframe_group_id) timeframeGroupIdSet.add(tf.timeframe_group_id);
    if (!tf.service_id) {
      messages.push(msg('error', `A timeframe in group "${tf.timeframe_group_id || '(unnamed)'}" is missing service_id.`, 'timeframe', tf.timeframe_group_id));
    } else if (!serviceIdSet.has(tf.service_id) && !calendarDateServiceIds.has(tf.service_id) && !reportedTimeframeMissingService.has(tf.service_id)) {
      reportedTimeframeMissingService.add(tf.service_id);
      messages.push(msg('error', `Timeframe references non-existent service "${tf.service_id}".`, 'timeframe', tf.timeframe_group_id));
    }
  }

  // fare_leg_rules.txt -- fare_product_id required + resolves; optional FKs resolve.
  const legGroupIdSet = new Set<string>();
  state.fareLegRules.forEach((r, i) => {
    if (r.leg_group_id) legGroupIdSet.add(r.leg_group_id);
    const ref = r.leg_group_id || `#${i + 1}`;
    if (!r.fare_product_id) {
      messages.push(msg('error', `Leg rule ${ref} is missing fare_product_id (required).`, 'fare_leg_rule', r.leg_group_id));
    } else if (!productIdSet.has(r.fare_product_id)) {
      messages.push(msg('error', `Leg rule ${ref} references non-existent fare product "${r.fare_product_id}".`, 'fare_leg_rule', r.leg_group_id));
    }
    if (r.network_id && !networkIdSet.has(r.network_id)) {
      messages.push(msg('error', `Leg rule ${ref} references non-existent network "${r.network_id}".`, 'fare_leg_rule', r.leg_group_id));
    }
    if (r.from_area_id && !areaIdSet.has(r.from_area_id)) {
      messages.push(msg('error', `Leg rule ${ref} references non-existent from_area "${r.from_area_id}".`, 'fare_leg_rule', r.leg_group_id));
    }
    if (r.to_area_id && !areaIdSet.has(r.to_area_id)) {
      messages.push(msg('error', `Leg rule ${ref} references non-existent to_area "${r.to_area_id}".`, 'fare_leg_rule', r.leg_group_id));
    }
    if (r.from_timeframe_group_id && !timeframeGroupIdSet.has(r.from_timeframe_group_id)) {
      messages.push(msg('error', `Leg rule ${ref} references non-existent from_timeframe "${r.from_timeframe_group_id}".`, 'fare_leg_rule', r.leg_group_id));
    }
    if (r.to_timeframe_group_id && !timeframeGroupIdSet.has(r.to_timeframe_group_id)) {
      messages.push(msg('error', `Leg rule ${ref} references non-existent to_timeframe "${r.to_timeframe_group_id}".`, 'fare_leg_rule', r.leg_group_id));
    }
  });

  // fare_transfer_rules.txt -- type required; product required for types 1/2
  // and must resolve; leg-group refs resolve.
  state.fareTransferRules.forEach((r, i) => {
    const ref = `#${i + 1}`;
    if (r.fare_transfer_type == null || Number.isNaN(Number(r.fare_transfer_type))) {
      messages.push(msg('error', `Transfer rule ${ref} is missing fare_transfer_type (required).`, 'fare_transfer_rule'));
    }
    if ((r.fare_transfer_type === 1 || r.fare_transfer_type === 2) && !r.fare_product_id) {
      messages.push(msg('error', `Transfer rule ${ref} has fare_transfer_type ${r.fare_transfer_type} but no fare_product_id.`, 'fare_transfer_rule'));
    }
    if (r.fare_product_id && !productIdSet.has(r.fare_product_id)) {
      messages.push(msg('error', `Transfer rule ${ref} references non-existent fare product "${r.fare_product_id}".`, 'fare_transfer_rule'));
    }
    if (r.from_leg_group_id && !legGroupIdSet.has(r.from_leg_group_id)) {
      messages.push(msg('error', `Transfer rule ${ref} references non-existent from_leg_group "${r.from_leg_group_id}".`, 'fare_transfer_rule'));
    }
    if (r.to_leg_group_id && !legGroupIdSet.has(r.to_leg_group_id)) {
      messages.push(msg('error', `Transfer rule ${ref} references non-existent to_leg_group "${r.to_leg_group_id}".`, 'fare_transfer_rule'));
    }
  });

  // Block feasibility (B3): a vehicle can't run two trips in the same
  // (block_id, service_id) at once. Promoted from BlocksPanel's sweep so the
  // blocking Gantt and the pre-publish validator share one definition.
  for (const o of findBlockOverlaps(state.trips, state.stopTimes)) {
    messages.push(msg(
      'warning',
      `Block ${o.blockId} has two trips overlapping at ${formatTimeShort(secondsToGtfsTime(o.atSec))} on service "${o.serviceId}" — one vehicle can't run both.`,
      'trip',
      o.tripB,
    ));
  }

  return messages;
}
