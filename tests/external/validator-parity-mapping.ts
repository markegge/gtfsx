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
  | 'duplicate_area_id'
  // Distance / geometry quality (#50 — ported to MobilityData parity)
  | 'shape_dist_decreasing'
  | 'stop_time_dist_not_increasing'
  | 'fast_travel_consecutive'
  | 'fast_travel_far'
  | 'stop_too_far_from_shape'
  // Feed-expiry heads-up (#50)
  | 'feed_expiry_soon'
  // Route-naming polish (#50)
  | 'route_long_name_contains_short_name'
  | 'route_same_name_and_desc'
  | 'duplicate_route_name'
  // GTFS-Flex — zone geography (locations.geojson / location_groups.txt)
  | 'flex_duplicate_geography_id'
  | 'flex_unsupported_geometry'
  | 'flex_invalid_geometry'
  | 'flex_group_unknown_stop'
  | 'flex_group_duplicate_stop'
  | 'flex_empty_stop_group'
  | 'flex_no_service_area'
  // GTFS-Flex — pickup/drop-off window + service
  | 'flex_invalid_window'
  | 'flex_malformed_window'
  | 'flex_no_window'
  | 'flex_unknown_service'
  | 'flex_no_service_pattern'
  // GTFS-Flex — booking_rules.txt
  | 'flex_missing_booking_rule'
  | 'flex_invalid_booking_type'
  | 'flex_missing_prior_notice_duration_min'
  | 'flex_invalid_prior_notice_duration_min'
  | 'flex_missing_prior_notice_last_day'
  | 'flex_missing_prior_notice_last_time'
  | 'flex_missing_prior_notice_start_time'
  | 'flex_forbidden_real_time_booking_field'
  | 'flex_forbidden_same_day_booking_field'
  | 'flex_forbidden_prior_day_booking_field'
  | 'flex_forbidden_prior_notice_start_day'
  | 'flex_forbidden_prior_notice_start_time'
  | 'flex_prior_notice_last_day_after_start_day';

interface OurNoticeRule {
  id: OurNoticeId;
  /** Match against the message text (case-insensitive). */
  test: RegExp;
}

// Order matters only in that the FIRST matching rule wins per message. Keep the
// regexes specific enough that they don't cross-match.
const OUR_NOTICE_RULES: OurNoticeRule[] = [
  // ── GTFS-Flex ──────────────────────────────────────────────────────────
  // FIRST, deliberately: every flex message is prefixed "Flex zone …" or
  // "Geography id …", but some generic rules below would otherwise steal one
  // (e.g. frequency_bad_window's /ends .* at or before it starts/ also matches
  // our flex window message). Anchoring the flex rules ahead of them keeps both
  // vocabularies intact.
  { id: 'flex_duplicate_geography_id', test: /^geography id .* share ONE id namespace/is },
  { id: 'flex_unsupported_geometry', test: /flex location must be a Polygon or MultiPolygon/i },
  { id: 'flex_invalid_geometry', test: /flex zone .* has an invalid polygon/i },
  { id: 'flex_group_unknown_stop', test: /flex zone .* in its group, but no such stop exists/i },
  { id: 'flex_group_duplicate_stop', test: /flex zone .* in its group more than once/i },
  { id: 'flex_empty_stop_group', test: /flex zone .* has a stop group with no stops/i },
  { id: 'flex_no_service_area', test: /flex zone .* has no service area/i },

  { id: 'flex_malformed_window', test: /flex zone .* pickup_drop_off_window .* must be HH:MM:SS/i },
  { id: 'flex_invalid_window', test: /flex zone .* pickup\/drop-off window ends .* at or before it starts/i },
  { id: 'flex_no_window', test: /flex zone .* has no pickup\/drop-off window set/i },
  { id: 'flex_unknown_service', test: /flex zone .* (references service_id|references prior_notice_service_id) .* which no longer exists/i },
  { id: 'flex_no_service_pattern', test: /flex zone .* has no service pattern in calendar\.txt/i },

  { id: 'flex_missing_booking_rule', test: /flex zone .* but no booking rule/i },
  { id: 'flex_invalid_booking_type', test: /flex zone .* booking rule has booking_type/i },
  { id: 'flex_missing_prior_notice_duration_min', test: /flex zone .* sets no prior_notice_duration_min/i },
  { id: 'flex_invalid_prior_notice_duration_min', test: /prior_notice_duration_max .* below prior_notice_duration_min/i },
  { id: 'flex_missing_prior_notice_last_day', test: /flex zone .* sets no prior_notice_last_day/i },
  { id: 'flex_missing_prior_notice_last_time', test: /sets no prior_notice_last_time/i },
  { id: 'flex_missing_prior_notice_start_time', test: /sets prior_notice_start_day but no prior_notice_start_time/i },
  { id: 'flex_forbidden_prior_notice_start_time', test: /sets prior_notice_start_time but no prior_notice_start_day/i },
  { id: 'flex_forbidden_prior_notice_start_day', test: /both prior_notice_start_day and prior_notice_duration_max/i },
  { id: 'flex_prior_notice_last_day_after_start_day', test: /prior_notice_last_day must not be greater than prior_notice_start_day/i },
  { id: 'flex_forbidden_real_time_booking_field', test: /books in real time \(booking_type=0\)/i },
  { id: 'flex_forbidden_same_day_booking_field', test: /books same day \(booking_type=1\), so /i },
  { id: 'flex_forbidden_prior_day_booking_field', test: /books a prior day \(booking_type=2\), so /i },

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

  // Distance / geometry quality (#50).
  { id: 'shape_dist_decreasing', test: /shape ".*" has a shape_dist_traveled that decreases/i },
  { id: 'stop_time_dist_not_increasing', test: /has a shape_dist_traveled that does not increase at stop/i },
  { id: 'fast_travel_consecutive', test: /travels implausibly fast between stops/i },
  { id: 'fast_travel_far', test: /averages an implausible .* km\/h across/i },
  { id: 'stop_too_far_from_shape', test: / m from shape ".*" on route/i },

  // Feed-expiry heads-up (#50). Both the 7-day and 30-day tiers classify here.
  { id: 'feed_expiry_soon', test: /this feed (expires|expired)/i },

  // Route-naming polish (#50).
  { id: 'route_long_name_contains_short_name', test: /restates its own short name .* at the start of route_long_name/i },
  { id: 'route_same_name_and_desc', test: /has a route_desc identical to its (short|long) name/i },
  { id: 'duplicate_route_name', test: /share the same name .* agency, and type/i },
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
    // Flex FKs land here too: a location_group_stops row pointing at a missing
    // stop, and a booking rule naming a prior_notice_service_id that isn't in
    // calendar.txt / calendar_dates.txt.
    'flex_group_unknown_stop',
    'flex_unknown_service',
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

  // ── GTFS-Flex (gtfs.org/community/extensions/flex) ─────────────────────
  // booking_rules.txt conditional requirements, keyed on booking_type:
  //   type 0 (real time) — every prior_notice_* field is Forbidden
  //   type 1 (same day)  — duration_min Required; last_day/last_time/service_id Forbidden
  //   type 2 (prior day) — last_day Required (+ last_time with it); duration_* Forbidden
  missing_prior_notice_duration_min: ['flex_missing_prior_notice_duration_min'],
  invalid_prior_notice_duration_min: ['flex_invalid_prior_notice_duration_min'],
  missing_prior_notice_last_day: ['flex_missing_prior_notice_last_day'],
  missing_prior_notice_last_time: ['flex_missing_prior_notice_last_time'],
  missing_prior_notice_start_time: ['flex_missing_prior_notice_start_time'],
  forbidden_prior_notice_start_day: ['flex_forbidden_prior_notice_start_day'],
  forbidden_prior_notice_start_time: ['flex_forbidden_prior_notice_start_time'],
  prior_notice_last_day_after_start_day: ['flex_prior_notice_last_day_after_start_day'],
  forbidden_real_time_booking_field_value: ['flex_forbidden_real_time_booking_field'],
  forbidden_same_day_booking_field_value: ['flex_forbidden_same_day_booking_field'],
  forbidden_prior_day_booking_field_value: ['flex_forbidden_prior_day_booking_field'],
  missing_pickup_drop_off_booking_rule_id: ['flex_missing_booking_rule'],
  // Zone geography. stops.stop_id / locations.geojson id / location_group_id
  // share one namespace, so a collision anywhere in it is one canonical notice.
  duplicate_geography_id: ['flex_duplicate_geography_id'],
  unsupported_geometry_type: ['flex_unsupported_geometry'],
  invalid_geometry: ['flex_invalid_geometry'],
  // The pickup/drop-off window on a flex stop_times row.
  invalid_pickup_drop_off_window: ['flex_invalid_window'],

  // ── Best-practice / advisory ───────────────────────────────────────────
  unused_stop: ['unused_stop'],
  route_with_no_trips: ['route_no_trips'],
  // We surface "trip has no stop times" rather than the spec's <2 phrasing.
  unusable_trip: ['trip_no_stop_times'],
  expired_calendar: ['expired_calendar'],

  // ── Distance / geometry quality (#50 — ported to parity) ───────────────
  // shape_dist_traveled must increase along a shape, and strictly increase
  // across a trip's stop_times. Previously we only warned on the all-zero case.
  decreasing_shape_distance: ['shape_dist_decreasing'],
  // Implausible travel speed between stops — per-route_type ceiling.
  fast_travel_between_consecutive_stops: ['fast_travel_consecutive'],
  fast_travel_between_far_stops: ['fast_travel_far'],
  // A stop projected >100 m off its trip's shape (geometry pass). The
  // _using_user_distance variant stays deferred (see TODO_MOBILITY_CODES).
  stop_too_far_from_shape: ['stop_too_far_from_shape'],
  // Feed-expiry heads-up: both tiers map to our single soft nudge.
  feed_expiration_date7_days: ['feed_expiry_soon'],
  feed_expiration_date30_days: ['feed_expiry_soon'],
  // Route-naming polish.
  duplicate_route_name: ['duplicate_route_name'],
  route_long_name_contains_short_name: ['route_long_name_contains_short_name'],
  same_name_and_description_for_route: ['route_same_name_and_desc'],

  // ── Known gaps (no equivalent yet) — also in TODO_MOBILITY_CODES ───────
  // All codes below were observed live on our own streamline feed (v8.0.1) and
  // are real rules we don't yet flag. Empty array = accepted gap; the parity
  // test records them in the baseline so they don't fail a periodic run until
  // we close them. `missing_required_field` / `missing_recommended_field` are
  // mapped above to our specific required-field checks, but on a given feed the
  // canonical validator may flag a *different* field than any of ours — in which
  // case it shows up as a per-feed gap and lives in the baseline.
  decreasing_or_equal_stop_time_distance: ['stop_time_dist_not_increasing'],
  equal_shape_distance_same_coordinates: [],
  leading_or_trailing_whitespaces: [],
  missing_feed_info_date: [],
  missing_recommended_field: [],
  route_color_contrast: [],
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
  // Shape / stop-time distance quality. The equal-distance and user-distance
  // stop-matching variants remain deferred (#50 ported the decreasing-distance,
  // fast-travel, and geometry stop_too_far_from_shape checks — see the mapping
  // table above). stop_too_far_from_shape_using_user_distance needs the user-
  // distance matcher and rarely applies (editor feeds don't set stop_times
  // shape_dist_traveled), so it's a documented deferral, not a gap we owe.
  'equal_shape_distance_diff_coordinates',
  'stop_too_far_from_shape_using_user_distance',
  // Feed service window — INFO counterpart to the expiry nudge, deferred.
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

  // ── GTFS-Flex notices our MODEL makes unreachable ──────────────────────
  // These describe malformed stop_times/locations rows that our data model
  // cannot represent, so there is nothing for us to validate — the exporter
  // can't emit them and the parser can't read them back into the store. Listed
  // here (rather than mapped to an empty array) so they read as "structurally
  // N/A", not "gap we owe":
  //   forbidden_geography_id — a stop_times row carrying stop_id AND
  //     location_id/location_group_id. materializeFlex writes exactly one
  //     reference per row, and gtfsParse routes a row to EITHER the fixed-route
  //     stopTimes slice OR the flex slice, never both.
  'forbidden_geography_id',
  //   forbidden_arrival_or_departure_time — a windowed flex row with
  //     arrival_time/departure_time. Our flex rows never carry times, and the
  //     parser doesn't retain them on a flex row.
  'forbidden_arrival_or_departure_time',
  //   missing_stop_times_record — travel within one location needs TWO
  //     stop_times rows. The exporter always duplicates the reference at
  //     stop_sequence 1 and 2, and a FlexZone has no way to express "one row".
  'missing_stop_times_record',
  //   location_without_stop_time / location_group_without_stop_time — an orphan
  //     location nothing references. The exporter writes locations.geojson and
  //     location_groups.txt ONLY from zones that materialized a trip.
  'location_without_stop_time',
  'location_group_without_stop_time',
  //   missing_prior_notice_duration_min / forbidden_* on an INVALID booking_type
  //     value: we flag the bad booking_type itself (flex_invalid_booking_type)
  //     and stop, rather than cascading every conditional rule off a value that
  //     has no defined semantics.
  //
  //   location_with_unexpected_stop_time — a stop_times row that references a
  //     location AND carries arrival/departure times. Same structural N/A as
  //     forbidden_arrival_or_departure_time above; observed on the bundled
  //     sample-gtfs-feed fixture, which does carry locations.geojson.
  'location_with_unexpected_stop_time',

  // ── Canonical rules we deliberately do NOT implement ───────────────────
  // unexpected_enum_value fires on our flex routes' `route_type: 715` (verified
  // against v8.0.1: fieldName "route_type", fieldValue 715). 715 = "Demand and
  // Response Bus Service" in the Google extended route types, which is the
  // correct value for a flex route; MobilityData v8's enum check only accepts
  // the base 0-12 set. This is THEIR gap, not ours — do not "fix" it by
  // downgrading 715 to 3.
  'unexpected_enum_value',
  // Feed-level metadata hygiene our exporter doesn't populate (feed_info.txt
  // contact fields, short-name length). Not flex-specific.
  'missing_feed_contact_email_and_url',
  'route_short_name_too_long',
];
