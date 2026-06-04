/**
 * Notice-code mapping table for the validator-parity test.
 *
 * The canonical MobilityData validator emits stable, machine-readable notice
 * `code`s (e.g. `foreign_key_violation`, `missing_calendar_and_calendar_date`).
 * Our in-app validator (`src/services/validation.ts`) instead emits free-text
 * human messages with a `severity` + optional `entity_type`. To compare the two
 * we:
 *   1. CLASSIFY each of our messages into a stable internal id (`classifyOurNotice`)
 *      using regexes over the message text — these ids are OUR notice vocabulary.
 *   2. MAP each MobilityData code to the set of our internal ids that cover it
 *      (`MOBILITY_TO_OURS`). One MobilityData code may map to several of our ids
 *      (we sometimes split a concept) and vice-versa.
 *
 * This table is the CORE deliverable. It is intentionally partial: it covers the
 * notices our editor can plausibly produce or should produce. Everything else is
 * listed under TODO_MOBILITY_CODES so the gaps are explicit, not silent.
 *
 * Adding coverage as we ship spec features (Fares v2, flex, …):
 *   - add a regex → id rule in OUR_NOTICE_RULES,
 *   - map the relevant MobilityData code(s) to that id in MOBILITY_TO_OURS,
 *   - remove the code from TODO_MOBILITY_CODES.
 */

export type OurNoticeId =
  // Primary-entity presence
  | 'missing_agency'
  | 'agency_missing_name'
  | 'agency_missing_timezone'
  | 'missing_calendar'
  // Foreign-key / reference integrity
  | 'trip_unknown_route'
  | 'trip_unknown_service'
  | 'stop_time_unknown_stop'
  | 'fare_rule_unknown_route'
  | 'transfer_unknown_stop'
  | 'pathway_unknown_stop'
  | 'stop_unknown_level'
  | 'frequency_unknown_trip'
  | 'stop_unknown_parent'
  | 'stop_area_unknown_area'
  | 'stop_area_unknown_stop'
  // Field-value / required-field
  | 'route_missing_name'
  | 'stop_missing_name'
  | 'stop_bad_coords'
  | 'calendar_missing_start_date'
  | 'calendar_missing_end_date'
  | 'parent_not_station'
  | 'endpoint_missing_time'
  | 'departure_before_arrival'
  | 'pathway_bad_mode'
  | 'pathway_bad_bidirectional'
  | 'frequency_bad_headway'
  | 'frequency_bad_window'
  // Best-practice / advisory
  | 'trip_no_stop_times'
  | 'route_no_trips'
  | 'unused_stop'
  | 'missing_wheelchair'
  | 'expired_calendar'
  | 'no_fares'
  | 'duplicate_area_id';

interface OurNoticeRule {
  id: OurNoticeId;
  /** Match against the message text (case-insensitive). */
  test: RegExp;
}

// Order matters only in that the FIRST matching rule wins per message. Keep the
// regexes specific enough that they don't cross-match.
const OUR_NOTICE_RULES: OurNoticeRule[] = [
  { id: 'missing_agency', test: /at least one agency is required/i },
  { id: 'agency_missing_name', test: /agency .* is missing a name/i },
  { id: 'agency_missing_timezone', test: /agency .* is missing a timezone/i },
  { id: 'missing_calendar', test: /at least one service pattern \(calendar\) is required/i },

  { id: 'trip_unknown_route', test: /trip .* references non-existent route/i },
  { id: 'trip_unknown_service', test: /trip .* references non-existent calendar/i },
  { id: 'stop_time_unknown_stop', test: /stop time references non-existent stop/i },
  { id: 'fare_rule_unknown_route', test: /fare rule .* references non-existent route/i },
  { id: 'transfer_unknown_stop', test: /transfer references non-existent (from|to)_stop_id/i },
  { id: 'pathway_unknown_stop', test: /pathway .* references non-existent (from|to)_stop_id/i },
  { id: 'stop_unknown_level', test: /references non-existent level_id/i },
  { id: 'frequency_unknown_trip', test: /frequency references non-existent trip/i },
  { id: 'stop_unknown_parent', test: /references non-existent parent_station/i },
  { id: 'stop_area_unknown_area', test: /stop_areas references non-existent area/i },
  { id: 'stop_area_unknown_stop', test: /stop_areas references non-existent stop/i },

  { id: 'route_missing_name', test: /needs either a short name or long name/i },
  { id: 'stop_missing_name', test: /stop .* is missing a name/i },
  { id: 'stop_bad_coords', test: /has invalid coordinates/i },
  { id: 'calendar_missing_start_date', test: /calendar .* is missing start_date/i },
  { id: 'calendar_missing_end_date', test: /calendar .* is missing end_date/i },
  { id: 'parent_not_station', test: /parent_station .* is not a Station/i },
  { id: 'endpoint_missing_time', test: /stop of trip .* is missing arrival_time or departure_time/i },
  { id: 'departure_before_arrival', test: /departure_time .* is before arrival_time/i },
  { id: 'pathway_bad_mode', test: /pathway_mode .* must be 1–7/i },
  { id: 'pathway_bad_bidirectional', test: /is_bidirectional .* must be 0 or 1/i },
  { id: 'frequency_bad_headway', test: /headway_secs .* must be a positive number/i },
  { id: 'frequency_bad_window', test: /(ends .* at or before it starts|overlapping frequency windows)/i },

  { id: 'trip_no_stop_times', test: /trip .* has no stop times/i },
  { id: 'route_no_trips', test: /(route .* has no trips|no routes defined)/i },
  { id: 'unused_stop', test: /is not used by any trip/i },
  { id: 'missing_wheelchair', test: /missing wheelchair_boarding/i },
  { id: 'expired_calendar', test: /is expired — end_date/i },
  { id: 'no_fares', test: /no fare information defined/i },
  { id: 'duplicate_area_id', test: /area_id must be unique/i },
];

/**
 * Classify one of our validator messages into a stable internal notice id, or
 * null if no rule matches (so unmapped messages surface as "(unclassified)").
 */
export function classifyOurNotice(message: string): OurNoticeId | null {
  for (const rule of OUR_NOTICE_RULES) {
    if (rule.test.test(message)) return rule.id;
  }
  return null;
}

/**
 * MobilityData notice code → the set of OUR notice ids that cover it.
 *
 * Codes are from gtfs-validator v8.x (https://gtfs-validator.mobilitydata.org/rules).
 * An empty array means "we have NO equivalent" — i.e. a known gap we accept
 * (these are listed again in TODO_MOBILITY_CODES for visibility). Mapped codes
 * with a non-empty array are ones we expect to catch when MobilityData does.
 */
export const MOBILITY_TO_OURS: Record<string, OurNoticeId[]> = {
  // ── Reference integrity ────────────────────────────────────────────────
  // foreign_key_violation is MobilityData's catch-all for dangling references;
  // we split it across many specific ids. We treat ANY of these as parity.
  foreign_key_violation: [
    'trip_unknown_route',
    'trip_unknown_service',
    'stop_time_unknown_stop',
    'fare_rule_unknown_route',
    'transfer_unknown_stop',
    'pathway_unknown_stop',
    'stop_unknown_level',
    'frequency_unknown_trip',
    'stop_area_unknown_area',
    'stop_area_unknown_stop',
  ],
  wrong_parent_location_type: ['parent_not_station'],

  // ── Required entities / files ──────────────────────────────────────────
  // Emitted when calendar.txt AND calendar_dates.txt are both absent (verified
  // code name on v8.0.1; note the trailing `_files`).
  missing_calendar_and_calendar_date_files: ['missing_calendar'],
  // MobilityData emits this when a referenced service_id is absent entirely.
  missing_trip_edge: ['endpoint_missing_time'],

  // ── Required / malformed fields ────────────────────────────────────────
  missing_required_field: [
    'agency_missing_name',
    'agency_missing_timezone',
    'route_missing_name',
    'stop_missing_name',
    'calendar_missing_start_date',
    'calendar_missing_end_date',
  ],
  route_short_and_long_name_missing: ['route_missing_name'],
  stop_without_location: ['stop_bad_coords'],
  stop_time_with_arrival_before_previous_departure_time: ['departure_before_arrival'],

  // ── Best-practice / advisory ───────────────────────────────────────────
  unused_stop: ['unused_stop'],
  route_with_no_trips: ['route_no_trips'],
  // We surface "trip has no stop times" rather than the spec's <2 phrasing.
  unusable_trip: ['trip_no_stop_times'],
  expired_calendar: ['expired_calendar'],

  // ── Known gaps (no equivalent yet) — also in TODO_MOBILITY_CODES ───────
  // All codes below were observed live on our own streamline feed (v8.0.1) and
  // are real rules we don't yet flag. Empty array = accepted gap; the parity
  // test records them in the baseline so they don't fail a periodic run until
  // we close them. `missing_required_field` / `missing_recommended_field` are
  // mapped above to our specific required-field checks, but on a given feed the
  // canonical validator may flag a *different* field than any of ours — in which
  // case it shows up as a per-feed gap and lives in the baseline.
  decreasing_or_equal_stop_time_distance: [],
  equal_shape_distance_same_coordinates: [],
  leading_or_trailing_whitespaces: [],
  missing_feed_info_date: [],
  missing_recommended_field: [],
  route_color_contrast: [],
  route_long_name_contains_short_name: [],
  same_name_and_description_for_route: [],
  stop_without_stop_time: [],
  trip_distance_exceeds_shape_distance_below_threshold: [],
};

/**
 * MobilityData codes we DON'T have a mapping entry for at all — kept explicit so
 * `npm run test:validator-parity` can print "these are canonical rules we have
 * deliberately deferred" (non-gating) versus a genuinely UNKNOWN code (which the
 * test flags as "triage me"). DISJOINT from MOBILITY_TO_OURS by design: a code
 * that has an entry there — even an empty-array "accepted gap" — must NOT appear
 * here. Grows/shrinks as we add coverage. NOT exhaustive — the canonical
 * validator has ~250 codes; this lists the common/high-value ones we have seen
 * on real feeds and deliberately deferred.
 */
export const TODO_MOBILITY_CODES: string[] = [
  // Shape / stop-time distance quality (we only warn on all-zero
  // shape_dist_traveled today; these need real geometry/distance checks).
  'equal_shape_distance_diff_coordinates',
  'decreasing_shape_distance',
  'stop_too_far_from_shape',
  'stop_too_far_from_shape_using_user_distance',
  // Speed/time plausibility between stops (we cap at 48:00 only).
  'fast_travel_between_consecutive_stops',
  'fast_travel_between_far_stops',
  // Naming / styling best practices.
  'duplicate_route_name',
  // Feed-info / metadata / expiration.
  'feed_expiration_date_seven_days',
  'feed_expiration_date_thirty_days',
  'service_extends_far_in_the_future', // INFO
  // Hygiene: unknown files/columns, non-printables, dup keys.
  'unknown_file',     // INFO
  'unknown_column',
  'duplicate_key',
  'non_ascii_or_non_printable_char',
  // Timepoints / ordering (scheduling polish).
  'missing_timepoint_value',
  'unsorted_stop_times',
  // Block overlaps (we warn already but with different sampling semantics —
  // mapping deferred until our block check is reconciled with theirs).
  'block_trips_with_overlapping_stop_times',
];
