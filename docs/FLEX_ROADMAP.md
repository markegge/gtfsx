# GTFS-Flex: Implementation Roadmap

Source of truth for what's done, what's open, and what we've decided not to
pursue. Keep it current when a gap ships. Spec references assume the
2024-merged GTFS-Flex language in the [GTFS Schedule reference](https://gtfs.org/documentation/schedule/reference/#gtfs-flex).

## Legend

- ✅ **Shipped** — done and round-trips cleanly
- 🟡 **Partial** — modelled but with known gaps
- 🔲 **Open** — not yet implemented
- 🚫 **Deferred** — considered and deliberately skipped

## Coverage snapshot

### Fully covered

- ✅ locations.geojson — Polygon geometry + multi-polygon zones
- ✅ locations.geojson — feature id + properties (stop_id / stop_name / location_type) on export, accepts both `feature.id` and `properties.stop_id` on import
- ✅ booking_rules.txt — booking_rule_id, booking_type (0/1/2)
- ✅ booking_rules.txt — prior_notice_duration_min/max, prior_notice_last_day/time, prior_notice_start_day/time
- ✅ booking_rules.txt — message, pickup_message, drop_off_message, phone_number, info_url, booking_url
- ✅ stop_times.txt — location_id, pickup_booking_rule_id, drop_off_booking_rule_id, start/end_pickup_drop_off_window
- ✅ Zone ↔ route ↔ service_id linkage preserved on round-trip
- ✅ Map popup on flex zone click with Edit Route / Edit Service Details
- ✅ Zone fill/outline colour tracks linked route colour

### Open items, ranked by user-facing impact

#### 1. 🔲 location_groups.txt + location_group_stops.txt

**Spec:** defines named groups of existing stops; `stop_times.location_group_id` references a group.
**Why it matters:** deviated-fixed-route and microtransit operators (Trillium's typical customer) often group discrete stops instead of drawing polygons. Brown County MN's flex feed uses these.
**Current behaviour on import:** both files are ignored; group semantics are lost.
**Scope:** new store slice, sidebar panel to author groups + assign stops, import/export of both files, update the flex export so zones can also be group-based.
**Effort:** 2–3 days.

#### 2. 🔲 continuous_pickup / continuous_drop_off

**Spec:** fields on stop_times.txt (0 = continuous, 1 = none, 2 = phone, 3 = coordinate) enabling flag-stop service along fixed-route trips.
**Why it matters:** common on deviated-fixed-route services (Brown County uses it on every trip). Stripping the field on re-import silently converts flag-stop service into fixed-stop service.
**Current behaviour:** fields are not read on import, not writable in the UI, not emitted on export.
**Scope:** extend StopTime type, stop-times UI, CSV round-trip.
**Effort:** 1–2 days.

#### 3. ✅ Validation + pre-export check for incomplete flex zones

**Spec:** a zone without a pickup window can't participate in stop_times, so it silently produces no trip.
**Why it matters:** today a zone without a window is quietly dropped at export — users can't figure out why their zone "didn't export."
**Shipped** as:
- `src/services/validation.ts` — warns on zones missing a pickup window; errors on malformed HH:MM:SS, on end-before-start, on referencing a missing service_id, and on needing a calendar when none exists; warns on zones with no booking rule.
- `src/components/import-export/ExportDialog.tsx` — file summary now shows only exportable flex zones in the "trips" / "stop_times" counts, and surfaces an amber panel listing zones that will be skipped for missing windows.

#### 4. 🟡 Per-trip service windows

**Spec:** `start_pickup_drop_off_window` / `end_pickup_drop_off_window` are on each stop_times row, so one zone can carry multiple trips with different windows (e.g. morning + evening shuttles).
**Current behaviour:** windows live on the zone, so a zone has a single window. Workaround: create two zones with identical geometry.
**Scope:** refactor `materializeFlex` to allow multiple window entries per zone, UI to author them.
**Effort:** 3–4 days.

#### 5. 🔲 mean_duration_factor, mean_duration_offset, safe_duration_factor, safe_duration_offset

**Spec:** optional fields on stop_times.txt for trip-planner travel-time estimation on flex legs.
**Why it matters:** consumer apps (Transit, Google Maps) need these to surface ETA ranges. Brown County ships them; we drop them on re-export.
**Scope:** extend FlexZone or StopTime model with these four fields, UI in the zone Details panel, export/import.
**Effort:** ~1 day.

#### 6. 🟡 calendar_dates-based per-zone exceptions

**Spec:** a zone's service_id can reference `calendar_dates.txt` exceptions for holidays or one-off variations.
**Current behaviour:** zones link to one `calendar.txt` pattern; no per-zone surface for exceptions. Exceptions defined in the Calendars tab apply globally.
**Scope:** UI to pick/attach calendar_dates exceptions per zone; ensure the exception service_id round-trips.
**Effort:** 1–2 days.

#### 7. 🔲 Synthesized flex route: configurable route_type

**Spec:** route_type can be 3 (Bus), 715 (Demand and Response Bus Service), or 1551 (Shared Taxi Service) among others.
**Current behaviour:** auto-created flex routes always get route_type = 3. Fine for most cases but loses intent for taxi-style services.
**Scope:** dropdown on the Route editor already supports all standard types; extend ROUTE_TYPES constant to include 715 and 1551.
**Effort:** < 1 hour.

## Spec-compliance risks to revisit

- Validator-visible risk: zones with orphan locations.geojson features after zone deletion (cleanup sweep on export).
- Validator-visible risk: `start_pickup_drop_off_window > end_pickup_drop_off_window`, or non-HH:MM:SS strings, pass through the UI today.
- Pure-flex feeds with no calendar.txt entry cannot materialize trips at all — currently these zones are skipped silently.

## Deferred / not doing

- 🚫 `booking_rules.prior_notice_service_id` — "conditionally forbidden" per spec; intentionally not surfaced in the UI.
