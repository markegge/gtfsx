// Data-quality checks ported to parity with the canonical MobilityData
// gtfs-validator (issue #50). These are the geometry/arithmetic-heavy checks
// that would bloat runValidation, so they live here as PURE finder functions
// (no store import — they take plain arrays, like services/stopAnalysis.ts) and
// runValidation wraps their structured results in ValidationMessages. Unit-
// tested directly in __tests__/validationQuality.test.ts.
//
// Every threshold below is the canonical MobilityData value, cited to the
// validator class it comes from — NOT invented, and NOT the (looser, per-mode)
// numbers the ttezer/gtfs-analyzer reference tool uses. Kept in ONE config
// object (the one-place pattern that reference tool got right) so a future tweak
// touches a single line. Class names are MobilityData/gtfs-validator paths under
// main/src/main/java/org/mobilitydata/gtfsvalidator/.
import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { point, lineString } from '@turf/helpers';
import { gtfsTimeToSeconds } from '../utils/time';
import type { Route, Shape, Stop, StopTime, Trip } from '../types/gtfs';

// ─── Thresholds (canonical MobilityData values) ────────────────────────────
export const QUALITY_THRESHOLDS = {
  // util/shape/StopToShapeMatcherSettings: DEFAULT_MAX_DISTANCE_FROM_STOP_TO_SHAPE_IN_METERS.
  stopTooFarFromShapeMeters: 100,
  // validator/StopTimeTravelSpeedValidator: MAX_DISTANCE_OVER_MAX_SPEED_IN_KMS.
  fastTravelFarWindowKm: 10,
  // validator/FeedExpirationDateValidator: FeedExpirationDate7DaysNotice / 30DaysNotice.
  feedExpiryWarnDaysNear: 7,
  feedExpiryWarnDaysFar: 30,
} as const;

const NUM_SECONDS_PER_MINUTE = 60;
const NUM_SECONDS_PER_HOUR = 3600;

type LngLat = [number, number];

/**
 * Per-route_type max speed (km/h) — verbatim from
 * StopTimeTravelSpeedValidator.getMaxVehicleSpeedKph. Trains are allowed to move
 * faster than buses; unknown/extended types get a high 200 km/h ceiling so we
 * only flag the physically impossible.
 */
export function maxVehicleSpeedKph(routeType: number): number {
  switch (routeType) {
    case 0: return 100;   // Tram / streetcar / light rail
    case 2: return 500;   // Rail (maglev can hit ~500)
    case 1:               // Subway / metro
    case 12:              // Monorail
    case 3:               // Bus
    case 11: return 150;  // Trolleybus
    case 4: return 80;    // Ferry
    case 5: return 30;    // Cable tram
    case 6:               // Aerial lift
    case 7: return 50;    // Funicular
    default: return 200;  // unknown / extended (e.g. 715 flex, 100-series)
  }
}

// StopTimeTravelSpeedValidator.getTimeBetweenStops: the elapsed seconds from the
// earlier stop's departure to the later stop's arrival, with two guards that
// suppress false positives — a minute-resolution buffer (most schedules only
// carry HH:MM, up to 30s of error each side) and a floor that avoids travel-
// back-in-time / divide-by-zero.
function timeBetweenStopsSec(laterArrivalSec: number, earlierDepartureSec: number): number {
  let t = laterArrivalSec - earlierDepartureSec;
  if (t <= 0) return NUM_SECONDS_PER_MINUTE;
  if (laterArrivalSec % NUM_SECONDS_PER_MINUTE === 0 && earlierDepartureSec % NUM_SECONDS_PER_MINUTE === 0) {
    t += NUM_SECONDS_PER_MINUTE;
  }
  return t;
}

function speedKph(distanceKm: number, laterArrivalSec: number, earlierDepartureSec: number): number {
  return (distanceKm * NUM_SECONDS_PER_HOUR) / timeBetweenStopsSec(laterArrivalSec, earlierDepartureSec);
}

/** A stop's coordinate, falling back to its parent_station's like MobilityData's
 *  StopUtil.getStopOrParentLatLng. null when neither has real coordinates. */
function makeStopLatLngResolver(stops: Stop[]): (stopId: string) => LngLat | null {
  const byId = new Map(stops.map((s) => [s.stop_id, s]));
  const resolve = (stopId: string, depth = 0): LngLat | null => {
    const s = byId.get(stopId);
    if (!s || depth > 8) return null;
    if (s.stop_lat && s.stop_lon) return [s.stop_lon, s.stop_lat];
    if (s.parent_station) return resolve(s.parent_station, depth + 1);
    return null;
  };
  return (stopId: string) => resolve(stopId);
}

const hasTime = (v: string | undefined): v is string => !!v && v.trim() !== '';

function groupStopTimesByTrip(stopTimes: StopTime[]): Map<string, StopTime[]> {
  const byTrip = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    const list = byTrip.get(st.trip_id) ?? [];
    list.push(st);
    byTrip.set(st.trip_id, list);
  }
  for (const [id, rows] of byTrip) {
    byTrip.set(id, [...rows].sort((a, b) => a.stop_sequence - b.stop_sequence));
  }
  return byTrip;
}

// ─── Implausible travel speed (fast_travel_between_consecutive_stops /
// fast_travel_between_far_stops) ───────────────────────────────────────────
export interface FastTravelFinding {
  kind: 'consecutive' | 'far';
  trip_id: string;
  fromStopId: string;
  toStopId: string;
  fromStopName: string;
  toStopName: string;
  speedKph: number;
  distanceKm: number;
  maxSpeedKph: number;
}

export function findFastTravel(
  trips: Trip[],
  stopTimes: StopTime[],
  stops: Stop[],
  routes: Route[],
): FastTravelFinding[] {
  const latLng = makeStopLatLngResolver(stops);
  const stopName = new Map(stops.map((s) => [s.stop_id, s.stop_name || s.stop_id]));
  const routeTypeById = new Map(routes.map((r) => [r.route_id, r.route_type]));
  const byTrip = groupStopTimesByTrip(stopTimes);
  const out: FastTravelFinding[] = [];

  const distKm = (aId: string, bId: string): number | null => {
    const a = latLng(aId);
    const b = latLng(bId);
    if (!a || !b) return null;
    return distance(a, b, { units: 'kilometers' });
  };
  const name = (id: string) => stopName.get(id) ?? id;

  for (const trip of trips) {
    const rows = byTrip.get(trip.trip_id);
    if (!rows || rows.length < 2) continue;
    const routeType = routeTypeById.get(trip.route_id);
    if (routeType === undefined) continue; // broken route ref, reported elsewhere
    const maxSpeed = maxVehicleSpeedKph(routeType);

    // Consecutive stops (validateConsecutiveStops): `start` only advances when a
    // distance was computable, so a coordinate-less middle stop is stepped over
    // rather than breaking the chain — verbatim to MobilityData.
    let start = rows[0];
    for (let i = 0; i < rows.length - 1; i++) {
      const end = rows[i + 1];
      const d = distKm(start.stop_id, end.stop_id);
      if (d === null) continue;
      if (!hasTime(start.departure_time) || !hasTime(end.arrival_time)) continue;
      const spd = speedKph(d, gtfsTimeToSeconds(end.arrival_time), gtfsTimeToSeconds(start.departure_time));
      if (spd > maxSpeed) {
        out.push({
          kind: 'consecutive', trip_id: trip.trip_id,
          fromStopId: start.stop_id, toStopId: end.stop_id,
          fromStopName: name(start.stop_id), toStopName: name(end.stop_id),
          speedKph: spd, distanceKm: d, maxSpeedKph: maxSpeed,
        });
      }
      start = end;
    }

    // Far stops (validateFarStops): per-segment distances (0 when a stop lacks
    // coordinates, carrying the reference point forward), then for each end stop
    // walk backward accumulating distance until a span >10 km is still over the
    // speed limit. At most ONE far notice per trip (the outer `farDone` break).
    const distancesKm: number[] = new Array(rows.length - 1).fill(0);
    let curr: LngLat | null = latLng(rows[0].stop_id);
    for (let i = 0; i < distancesKm.length; i++) {
      const next = latLng(rows[i + 1].stop_id);
      if (next && curr) { distancesKm[i] = distance(curr, next, { units: 'kilometers' }); curr = next; }
      else if (next) { curr = next; } // first resolvable point becomes the reference
    }
    let farDone = false;
    for (let endIdx = 0; endIdx < rows.length && !farDone; endIdx++) {
      const endRow = rows[endIdx];
      if (!hasTime(endRow.arrival_time)) continue;
      let distanceToEnd = 0;
      for (let startIdx = endIdx - 1; startIdx >= 0; startIdx--) {
        distanceToEnd += distancesKm[startIdx];
        const startRow = rows[startIdx];
        if (!hasTime(startRow.departure_time)) continue;
        const spd = speedKph(distanceToEnd, gtfsTimeToSeconds(endRow.arrival_time), gtfsTimeToSeconds(startRow.departure_time));
        if (spd <= maxSpeed) continue;
        if (distanceToEnd > QUALITY_THRESHOLDS.fastTravelFarWindowKm) {
          out.push({
            kind: 'far', trip_id: trip.trip_id,
            fromStopId: startRow.stop_id, toStopId: endRow.stop_id,
            fromStopName: name(startRow.stop_id), toStopName: name(endRow.stop_id),
            speedKph: spd, distanceKm: distanceToEnd, maxSpeedKph: maxSpeed,
          });
          farDone = true;
          break;
        }
      }
    }
  }
  return out;
}

// ─── Stop too far from its shape (stop_too_far_from_shape) ──────────────────
// MobilityData's ShapeToStopMatchingValidator runs two passes: a geometry
// (great-circle) match and, only when BOTH the stop_times and the shape carry
// shape_dist_traveled, a user-distance match. We port the geometry pass (the one
// that always applies): a stop projected onto its trip's shape must lie within
// 100 m of it. The user-distance variant stays deferred (rarely reachable —
// editor feeds don't populate stop_times.shape_dist_traveled), and the 4× large-
// station relaxation is skipped (our audience is small rural feeds with no
// multi-platform mega-stations, so flat 100 m is if anything slightly stricter).
export interface StopFarFromShapeFinding {
  shape_id: string;
  stop_id: string;
  stopName: string;
  route_id: string;
  distanceMeters: number;
}

export function findStopsTooFarFromShape(
  trips: Trip[],
  stopTimes: StopTime[],
  stops: Stop[],
  shapes: Shape[],
): StopFarFromShapeFinding[] {
  const latLng = makeStopLatLngResolver(stops);
  const stopName = new Map(stops.map((s) => [s.stop_id, s.stop_name || s.stop_id]));
  const byTrip = groupStopTimesByTrip(stopTimes);
  // Shape geometry (ordered), plus a lazily-built turf LineString cache.
  const shapeCoords = new Map<string, LngLat[]>();
  for (const shape of shapes) {
    if (shape.points.length < 2) continue;
    const coords = [...shape.points]
      .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
      .map((p) => [p.shape_pt_lon, p.shape_pt_lat] as LngLat);
    shapeCoords.set(shape.shape_id, coords);
  }
  const lineCache = new Map<string, ReturnType<typeof lineString>>();
  const lineFor = (shapeId: string) => {
    let l = lineCache.get(shapeId);
    if (!l) { l = lineString(shapeCoords.get(shapeId)!); lineCache.set(shapeId, l); }
    return l;
  };

  const out: StopFarFromShapeFinding[] = [];
  // De-dup by (shape_id, stop_id): the same stop on the same shape recurs across
  // every trip that uses that shape — checking it once is enough (MobilityData
  // reports per trip, but our grouped panel collapses those anyway).
  const seen = new Set<string>();
  for (const trip of trips) {
    if (!trip.shape_id || !shapeCoords.has(trip.shape_id)) continue;
    const rows = byTrip.get(trip.trip_id);
    if (!rows) continue;
    for (const st of rows) {
      const key = `${trip.shape_id} ${st.stop_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = latLng(st.stop_id);
      if (!c) continue;
      const npl = nearestPointOnLine(lineFor(trip.shape_id), point(c), { units: 'meters' });
      const d = npl.properties.dist ?? 0;
      if (d > QUALITY_THRESHOLDS.stopTooFarFromShapeMeters) {
        out.push({
          shape_id: trip.shape_id, stop_id: st.stop_id,
          stopName: stopName.get(st.stop_id) ?? st.stop_id,
          route_id: trip.route_id, distanceMeters: d,
        });
      }
    }
  }
  return out;
}

// ─── Distance monotonicity ─────────────────────────────────────────────────
// MobilityData `decreasing_shape_distance` (ERROR): along a shape, ordered by
// shape_pt_sequence, shape_dist_traveled must not go BACKWARDS (strict `prev >
// curr`). Equal distances are a different, separately-severitied case
// (equal_shape_distance_*), not this one, and the all-zero case is owned by the
// existing warning in validation.ts (the importer refills those from geometry),
// so both are excluded here.
export interface DecreasingShapeDistFinding {
  shape_id: string;
  atSequence: number;
  prevDist: number;
  thisDist: number;
}

export function findDecreasingShapeDistances(shapes: Shape[]): DecreasingShapeDistFinding[] {
  const out: DecreasingShapeDistFinding[] = [];
  for (const shape of shapes) {
    if (shape.points.length < 2) continue;
    if (!shape.points.some((p) => p.shape_dist_traveled !== 0)) continue;
    const ordered = [...shape.points].sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1].shape_dist_traveled;
      const cur = ordered[i].shape_dist_traveled;
      if (cur < prev) {
        out.push({ shape_id: shape.shape_id, atSequence: ordered[i].shape_pt_sequence, prevDist: prev, thisDist: cur });
        break; // one finding per shape is enough to surface the defect
      }
    }
  }
  return out;
}

// MobilityData `decreasing_or_equal_stop_time_distance` (ERROR): within a trip,
// ordered by stop_sequence, a stop_time's shape_dist_traveled must be STRICTLY
// greater than the previous row's (`prev >= curr` is flagged — equal counts).
// Only rows that actually carry a distance are compared; the importer leaves
// shape_dist_traveled undefined when the source omitted it.
export interface DecreasingStopTimeDistFinding {
  trip_id: string;
  atSequence: number;
  prevDist: number;
  thisDist: number;
  equal: boolean;
}

export function findDecreasingStopTimeDistances(
  trips: Trip[],
  stopTimes: StopTime[],
): DecreasingStopTimeDistFinding[] {
  const byTrip = groupStopTimesByTrip(stopTimes);
  const out: DecreasingStopTimeDistFinding[] = [];
  const tripOrder = trips.map((t) => t.trip_id).filter((id) => byTrip.has(id));
  for (const id of byTrip.keys()) if (!tripOrder.includes(id)) tripOrder.push(id);

  for (const tripId of tripOrder) {
    const rows = byTrip.get(tripId)!;
    let prev: StopTime | undefined;
    for (const st of rows) {
      if (st.shape_dist_traveled === undefined) continue;
      if (prev?.shape_dist_traveled !== undefined && st.shape_dist_traveled <= prev.shape_dist_traveled) {
        out.push({
          trip_id: tripId, atSequence: st.stop_sequence,
          prevDist: prev.shape_dist_traveled, thisDist: st.shape_dist_traveled,
          equal: st.shape_dist_traveled === prev.shape_dist_traveled,
        });
        break; // one finding per trip
      }
      prev = st;
    }
  }
  return out;
}

// ─── Feed-expiry heads-up (feed_expiration_date7_days / _30_days) ──────────
// MobilityData reads feed_info.feed_end_date and warns when it is < today+7 days
// (near) or < today+30 days (far). We mirror that exactly when feed_info carries
// an end date. When it doesn't — common for rural National-RTAP feeds, the exact
// silent-expiry case #50 calls out — we fall back to the service window (the
// latest calendar end_date) so the nudge still fires, but ONLY pre-expiry there
// (an already-past window is already covered per-service by the "expired"
// warning, so we don't double-nag). This fallback fires where MobilityData is
// silent, which never breaks parity (parity only fails on notices WE miss).
export type FeedExpirySource = 'feed_info' | 'service_window';
export interface FeedExpiryFinding {
  tier: 7 | 30;
  effectiveEndDate: string; // YYYYMMDD
  daysRemaining: number;    // negative once past (feed_info path only)
  source: FeedExpirySource;
}

/** Whole days from `fromYYYYMMDD` to `toYYYYMMDD` (positive = future). Both are
 *  8-char GTFS dates; computed in UTC so no timezone can shift the boundary. */
function daysBetween(fromYYYYMMDD: number, toYYYYMMDD: number): number {
  const d = (n: number) => Date.UTC(Math.floor(n / 10000), (Math.floor(n / 100) % 100) - 1, n % 100);
  return Math.round((d(toYYYYMMDD) - d(fromYYYYMMDD)) / 86_400_000);
}

export function checkFeedExpiry(
  feedEndDate: string | undefined,
  calendarEndDates: string[],
  todayYYYYMMDD: number,
): FeedExpiryFinding | null {
  const near = QUALITY_THRESHOLDS.feedExpiryWarnDaysNear;
  const far = QUALITY_THRESHOLDS.feedExpiryWarnDaysFar;

  if (feedEndDate && feedEndDate.length === 8 && Number.isFinite(Number(feedEndDate))) {
    // feed_info path — verbatim MobilityData (fires even if already past).
    const days = daysBetween(todayYYYYMMDD, Number(feedEndDate));
    if (days < near) return { tier: 7, effectiveEndDate: feedEndDate, daysRemaining: days, source: 'feed_info' };
    if (days < far) return { tier: 30, effectiveEndDate: feedEndDate, daysRemaining: days, source: 'feed_info' };
    return null;
  }

  // Service-window fallback (extension): latest calendar end_date, pre-expiry only.
  const valid = calendarEndDates.filter((d) => d.length === 8 && Number.isFinite(Number(d)));
  if (valid.length === 0) return null;
  const latest = valid.reduce((a, b) => (Number(b) > Number(a) ? b : a));
  const days = daysBetween(todayYYYYMMDD, Number(latest));
  if (days < 0) return null; // already expired → owned by the per-service check
  if (days < near) return { tier: 7, effectiveEndDate: latest, daysRemaining: days, source: 'service_window' };
  if (days < far) return { tier: 30, effectiveEndDate: latest, daysRemaining: days, source: 'service_window' };
  return null;
}

// ─── Route-naming polish ───────────────────────────────────────────────────
const blank = (v: string | undefined): boolean => !v || v.trim() === '';

// MobilityData `route_long_name_contains_short_name` (WARNING),
// RouteNameValidator: the long name STARTS WITH the short name (case-insensitive)
// and what follows is either nothing or a separator (space / dash / paren). The
// separator guard is what stops "10" inside "100 Express" from tripping it.
const SEPARATOR_AFTER_SHORT = /^\s?[\s\-()]/;

export interface RouteLongContainsShortFinding { route_id: string; shortName: string; longName: string; }

export function findRouteLongNameContainsShort(routes: Route[]): RouteLongContainsShortFinding[] {
  const out: RouteLongContainsShortFinding[] = [];
  for (const r of routes) {
    if (blank(r.route_short_name) || blank(r.route_long_name)) continue;
    const shortName = r.route_short_name;
    const longName = r.route_long_name;
    if (!longName.toLowerCase().startsWith(shortName.toLowerCase())) continue;
    const remainder = longName.substring(shortName.length);
    if (remainder === '' || SEPARATOR_AFTER_SHORT.test(remainder)) {
      out.push({ route_id: r.route_id, shortName, longName });
    }
  }
  return out;
}

// MobilityData `same_name_and_description_for_route` (WARNING): route_desc equals
// (case-insensitive) the route's short OR long name — a description that just
// repeats the name carries no information.
export interface RouteSameNameDescFinding { route_id: string; which: 'short' | 'long'; name: string; }

export function findRouteSameNameAndDesc(routes: Route[]): RouteSameNameDescFinding[] {
  const out: RouteSameNameDescFinding[] = [];
  for (const r of routes) {
    if (blank(r.route_desc)) continue;
    const desc = r.route_desc!.trim();
    if (!blank(r.route_short_name) && desc.toLowerCase() === r.route_short_name.trim().toLowerCase()) {
      out.push({ route_id: r.route_id, which: 'short', name: r.route_short_name });
    } else if (!blank(r.route_long_name) && desc.toLowerCase() === r.route_long_name.trim().toLowerCase()) {
      out.push({ route_id: r.route_id, which: 'long', name: r.route_long_name });
    }
  }
  return out;
}

// MobilityData `duplicate_route_name` (WARNING), DuplicateRouteNameValidator:
// routes are duplicates when route_long_name + route_short_name + route_type +
// agency_id all match. Any of the four differing (including a blank vs set
// agency_id) makes them distinct.
export interface DuplicateRouteNameFinding {
  route_ids: string[];
  shortName: string;
  longName: string;
}

export function findDuplicateRouteNames(routes: Route[]): DuplicateRouteNameFinding[] {
  const groups = new Map<string, Route[]>();
  for (const r of routes) {
    const key = `${r.route_long_name ?? ''} ${r.route_short_name ?? ''} ${r.route_type} ${r.agency_id ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: DuplicateRouteNameFinding[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    out.push({
      route_ids: list.map((r) => r.route_id),
      shortName: list[0].route_short_name ?? '',
      longName: list[0].route_long_name ?? '',
    });
  }
  return out;
}
