import distance from '@turf/distance';
import { point } from '@turf/helpers';
import type {
  Stop, Route, RouteStop, Trip, StopTime, Calendar, CalendarDate, Frequency,
} from '../types/gtfs';
import { gtfsTimeToSeconds } from '../utils/time';
import { directionName } from '../utils/constants';

/**
 * Stop-level diagnostics computed entirely from the parsed feed in memory —
 * no Census / network dependency (that lives in coverageAnalysis.ts). All
 * functions are pure and synchronous; the UI runs them in a useMemo. Inputs
 * are taken as a structural slice of the store so unit tests can pass a plain
 * object literal (AppStore satisfies this structurally).
 *
 * Distance note: inter-stop spacing is great-circle (Haversine) between stop
 * coordinates, NOT shape_dist_traveled. GTFS leaves shape_dist_traveled's unit
 * undefined (feet / meters / miles / "stations" all occur in the wild), so on
 * an arbitrary uploaded feed it can't be trusted to be in any known unit.
 * Haversine is always in feet here, at the cost of slightly underestimating
 * spacing around curves. We surface this caveat in the UI.
 */
export interface FeedSlice {
  stops: Stop[];
  routes: Route[];
  routeStops: RouteStop[];
  trips: Trip[];
  stopTimes: StopTime[];
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  /** frequencies.txt (optional) — used by network-walkshed Auto mode to expand
   *  frequency-based trips into per-stop departures for headway estimation. */
  frequencies?: Frequency[];
}

const FT_PER_MILE = 5280;

const WEEKDAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
] as const;
type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_LABEL: Record<Weekday, string> = {
  sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday',
};

/* ───────────────────────── shared helpers ───────────────────────── */

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolated percentile of an already-unsorted array. */
function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

function spacingFt(a: Stop, b: Stop): number {
  return distance(
    point([a.stop_lon, a.stop_lat]),
    point([b.stop_lon, b.stop_lat]),
    { units: 'miles' },
  ) * FT_PER_MILE;
}

/** stop_times grouped by trip, each sorted ascending by stop_sequence. */
function stopTimesByTripSorted(stopTimes: StopTime[]): Map<string, StopTime[]> {
  const byTrip = new Map<string, StopTime[]>();
  for (const st of stopTimes) {
    let arr = byTrip.get(st.trip_id);
    if (!arr) { arr = []; byTrip.set(st.trip_id, arr); }
    arr.push(st);
  }
  for (const arr of byTrip.values()) arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  return byTrip;
}

export interface DominantPattern {
  routeId: string;
  directionId: 0 | 1;
  /** Ordered stop_ids of the route's longest trip in this direction. */
  stopIds: string[];
}

/**
 * Per (route, direction), the stop sequence of the trip with the most stops —
 * the handoff's "dominant trip pattern" proxy. Used by spacing + balancing so
 * both read one canonical stop ordering per direction.
 */
export function dominantPatterns(feed: FeedSlice): DominantPattern[] {
  const byTrip = stopTimesByTripSorted(feed.stopTimes);
  // key `${routeId}__${dir}` → best { count, stopIds }
  const best = new Map<string, { count: number; pattern: DominantPattern }>();
  for (const trip of feed.trips) {
    const sts = byTrip.get(trip.trip_id);
    if (!sts || sts.length < 2) continue;
    const key = `${trip.route_id}__${trip.direction_id}`;
    const prev = best.get(key);
    if (!prev || sts.length > prev.count) {
      best.set(key, {
        count: sts.length,
        pattern: {
          routeId: trip.route_id,
          directionId: trip.direction_id,
          stopIds: sts.map((s) => s.stop_id),
        },
      });
    }
  }
  return [...best.values()].map((b) => b.pattern);
}

/* ───────────────────── representative service day ───────────────────── */

export interface RepresentativeDay {
  weekday: Weekday | null;
  label: string;
  /** service_ids active on the representative day. */
  serviceIds: Set<string>;
}

/**
 * The weekday with the most scheduled trips, and the set of service_ids active
 * on it. Falls back to "all services" when the feed has no calendar.txt (e.g.
 * calendar_dates-only feeds), so service-intensity still produces output.
 * calendar_dates exceptions are not generalizable to a weekday, so they're
 * intentionally ignored for the representative-day pick.
 */
export function representativeDay(feed: FeedSlice): RepresentativeDay {
  const calById = new Map(feed.calendars.map((c) => [c.service_id, c]));
  if (feed.calendars.length === 0) {
    return {
      weekday: null,
      label: 'All services',
      serviceIds: new Set(feed.trips.map((t) => t.service_id)),
    };
  }
  const tripsPerWeekday: Record<Weekday, number> = {
    sunday: 0, monday: 0, tuesday: 0, wednesday: 0, thursday: 0, friday: 0, saturday: 0,
  };
  for (const trip of feed.trips) {
    const cal = calById.get(trip.service_id);
    if (!cal) continue;
    for (const w of WEEKDAYS) if (cal[w] === 1) tripsPerWeekday[w] += 1;
  }
  let bestDay: Weekday = 'monday';
  let bestCount = -1;
  for (const w of WEEKDAYS) {
    if (tripsPerWeekday[w] > bestCount) { bestCount = tripsPerWeekday[w]; bestDay = w; }
  }
  const serviceIds = new Set(
    feed.calendars.filter((c) => c[bestDay] === 1).map((c) => c.service_id),
  );
  return { weekday: bestDay, label: WEEKDAY_LABEL[bestDay], serviceIds };
}

/* ─────────────────── Feature 1 — stop spacing ─────────────────── */

export interface SpacingBenchmarks {
  tooCloseFt: number;
  urbanMinFt: number;
  urbanMaxFt: number;
  suburbanMinFt: number;
  suburbanMaxFt: number;
  hardMaxFt: number;
}

// APTA / TransitWiki defaults (configurable in the UI).
export const DEFAULT_SPACING_BENCHMARKS: SpacingBenchmarks = {
  tooCloseFt: 600,
  urbanMinFt: 750,
  urbanMaxFt: 1000,
  suburbanMinFt: 1000,
  suburbanMaxFt: 1320,
  hardMaxFt: 2640,
};

export interface SpacingBin { lo: number; hi: number; count: number; }

export interface RouteSpacing {
  routeId: string;
  routeName: string;
  routeColor: string;
  medianFt: number;
  pairCount: number;
  /** Every consecutive-pair spacing on this route, for a sparkline. */
  spacingsFt: number[];
}

export interface SpacingResult {
  pairCount: number;
  meanFt: number | null;
  medianFt: number | null;
  p10Ft: number | null;
  p90Ft: number | null;
  minFt: number | null;
  maxFt: number | null;
  histogram: SpacingBin[];
  tooCloseCount: number;
  aboveMaxCount: number;
  /** count within [urbanMinFt, suburbanMaxFt] target band. */
  inTargetCount: number;
  perRoute: RouteSpacing[];
}

/** 100-ft bins to 3,000 ft, then 500-ft bins up to the max observed spacing. */
function buildSpacingHistogram(spacings: number[]): SpacingBin[] {
  const bins: SpacingBin[] = [];
  for (let lo = 0; lo < 3000; lo += 100) bins.push({ lo, hi: lo + 100, count: 0 });
  const max = spacings.length ? Math.max(...spacings) : 0;
  for (let lo = 3000; lo < Math.max(3000, max); lo += 500) bins.push({ lo, hi: lo + 500, count: 0 });
  for (const v of spacings) {
    // last bin catches anything at/over its lo (open-ended top)
    let placed = false;
    for (const b of bins) {
      if (v >= b.lo && v < b.hi) { b.count += 1; placed = true; break; }
    }
    if (!placed && bins.length) bins[bins.length - 1].count += 1;
  }
  return bins;
}

export function computeStopSpacing(
  feed: FeedSlice,
  benchmarks: SpacingBenchmarks = DEFAULT_SPACING_BENCHMARKS,
): SpacingResult {
  const stopById = new Map(feed.stops.map((s) => [s.stop_id, s]));
  const routeById = new Map(feed.routes.map((r) => [r.route_id, r]));
  const patterns = dominantPatterns(feed);

  const allSpacings: number[] = [];
  // routeId → spacings collected across both directions' dominant patterns
  const byRoute = new Map<string, number[]>();

  for (const pat of patterns) {
    let arr = byRoute.get(pat.routeId);
    if (!arr) { arr = []; byRoute.set(pat.routeId, arr); }
    for (let i = 0; i < pat.stopIds.length - 1; i++) {
      const a = stopById.get(pat.stopIds[i]);
      const b = stopById.get(pat.stopIds[i + 1]);
      if (!a || !b) continue;
      const d = spacingFt(a, b);
      arr.push(d);
      allSpacings.push(d);
    }
  }

  const perRoute: RouteSpacing[] = [...byRoute.entries()]
    .map(([routeId, spacingsFt]) => {
      const r = routeById.get(routeId);
      return {
        routeId,
        routeName: r?.route_short_name || r?.route_long_name || routeId,
        routeColor: r?.route_color || '888888',
        medianFt: median(spacingsFt) ?? 0,
        pairCount: spacingsFt.length,
        spacingsFt,
      };
    })
    .filter((r) => r.pairCount > 0)
    .sort((a, b) => a.medianFt - b.medianFt);

  return {
    pairCount: allSpacings.length,
    meanFt: allSpacings.length ? allSpacings.reduce((a, b) => a + b, 0) / allSpacings.length : null,
    medianFt: median(allSpacings),
    p10Ft: percentile(allSpacings, 10),
    p90Ft: percentile(allSpacings, 90),
    minFt: allSpacings.length ? Math.min(...allSpacings) : null,
    maxFt: allSpacings.length ? Math.max(...allSpacings) : null,
    histogram: buildSpacingHistogram(allSpacings),
    tooCloseCount: allSpacings.filter((d) => d < benchmarks.tooCloseFt).length,
    aboveMaxCount: allSpacings.filter((d) => d > benchmarks.hardMaxFt).length,
    inTargetCount: allSpacings.filter((d) => d >= benchmarks.urbanMinFt && d <= benchmarks.suburbanMaxFt).length,
    perRoute,
  };
}

/* ─────────────────── Feature 2 — stop balancing ─────────────────── */

export interface BalancingOptions {
  thresholdFt: number;
  /** seconds saved per removed stop (decel + dwell + accel). */
  dwellSeconds: number;
  serviceIds: Set<string>;
}

export interface BalancingCandidate {
  routeId: string;
  routeName: string;
  routeColor: string;
  directionId: 0 | 1;
  directionLabel: string;
  stopAId: string;
  stopAName: string;
  stopBId: string;
  stopBName: string;
  spacingFt: number;
  tripsPerDay: number;
  /** dwellSeconds × tripsPerDay — order-of-magnitude daily time saving. */
  savingsSecPerDay: number;
  /** the lower-service stop a planner would consider removing. */
  removalStopId: string;
  removalStopName: string;
  /** set when one stop in the pair has materially more service than the other. */
  note: string | null;
}

export interface BalancingResult {
  candidates: BalancingCandidate[];
  totalSavingsSecPerDay: number;
  removalStopIds: string[];
}

/** trips/day per (route,direction) restricted to the active service day. */
function tripsPerDayByPattern(feed: FeedSlice, serviceIds: Set<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of feed.trips) {
    if (serviceIds.size && !serviceIds.has(t.service_id)) continue;
    const key = `${t.route_id}__${t.direction_id}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

/** stop_id → number of active-day trips that serve it (for keep/remove choice). */
function tripsServingStop(feed: FeedSlice, serviceIds: Set<string>): Map<string, number> {
  const activeTrip = new Set(
    feed.trips.filter((t) => !serviceIds.size || serviceIds.has(t.service_id)).map((t) => t.trip_id),
  );
  const m = new Map<string, number>();
  for (const st of feed.stopTimes) {
    if (!activeTrip.has(st.trip_id)) continue;
    m.set(st.stop_id, (m.get(st.stop_id) ?? 0) + 1);
  }
  return m;
}

export function computeBalancingCandidates(
  feed: FeedSlice,
  opts: BalancingOptions,
): BalancingResult {
  const stopById = new Map(feed.stops.map((s) => [s.stop_id, s]));
  const routeById = new Map(feed.routes.map((r) => [r.route_id, r]));
  const patterns = dominantPatterns(feed);
  const tripsPerPattern = tripsPerDayByPattern(feed, opts.serviceIds);
  const stopTrips = tripsServingStop(feed, opts.serviceIds);
  const routeCount = routeCountByStop(feed);

  const candidates: BalancingCandidate[] = [];

  for (const pat of patterns) {
    const route = routeById.get(pat.routeId);
    const tripsPerDay = tripsPerPattern.get(`${pat.routeId}__${pat.directionId}`) ?? 0;
    const n = pat.stopIds.length;
    // Pairs are (i, i+1) for i in [0, n-2]. Skip the first (i=0, touches the
    // origin terminal) and last (i=n-2, touches the destination terminal).
    for (let i = 1; i < n - 2; i++) {
      const a = stopById.get(pat.stopIds[i]);
      const b = stopById.get(pat.stopIds[i + 1]);
      if (!a || !b) continue;
      // Stations are not board points — skip.
      if (a.location_type === 1 || b.location_type === 1) continue;
      const d = spacingFt(a, b);
      if (d >= opts.thresholdFt) continue;

      const aTrips = stopTrips.get(a.stop_id) ?? 0;
      const bTrips = stopTrips.get(b.stop_id) ?? 0;
      // Removal candidate = lower-service stop; tiebreak on fewer routes.
      const aScore = [aTrips, routeCount.get(a.stop_id) ?? 0];
      const bScore = [bTrips, routeCount.get(b.stop_id) ?? 0];
      const removeA = aScore[0] < bScore[0] || (aScore[0] === bScore[0] && aScore[1] <= bScore[1]);
      const removal = removeA ? a : b;
      const hi = Math.max(aTrips, bTrips);
      const lo = Math.min(aTrips, bTrips);
      const note = hi >= 2 * Math.max(1, lo) && hi !== lo
        ? `${removeA ? b.stop_name || b.stop_id : a.stop_name || a.stop_id} carries materially more service — keep it.`
        : null;

      candidates.push({
        routeId: pat.routeId,
        routeName: route?.route_short_name || route?.route_long_name || pat.routeId,
        routeColor: route?.route_color || '888888',
        directionId: pat.directionId,
        directionLabel: directionName(route, pat.directionId),
        stopAId: a.stop_id,
        stopAName: a.stop_name || a.stop_id,
        stopBId: b.stop_id,
        stopBName: b.stop_name || b.stop_id,
        spacingFt: d,
        tripsPerDay,
        savingsSecPerDay: opts.dwellSeconds * tripsPerDay,
        removalStopId: removal.stop_id,
        removalStopName: removal.stop_name || removal.stop_id,
        note,
      });
    }
  }

  candidates.sort((a, b) => b.savingsSecPerDay - a.savingsSecPerDay || a.spacingFt - b.spacingFt);
  return {
    candidates,
    totalSavingsSecPerDay: candidates.reduce((a, c) => a + c.savingsSecPerDay, 0),
    removalStopIds: [...new Set(candidates.map((c) => c.removalStopId))],
  };
}

/* ─────────────────── Feature 3 — service intensity ─────────────────── */

export interface HeadwayBands {
  /** [startSec, endSec) windows treated as peak (gaps pooled across windows). */
  peak: Array<[number, number]>;
  offpeak: Array<[number, number]>;
}

export const DEFAULT_HEADWAY_BANDS: HeadwayBands = {
  peak: [[6 * 3600, 9 * 3600], [15 * 3600, 18 * 3600]],
  offpeak: [[10 * 3600, 14 * 3600]],
};

export interface StopIntensity {
  stopId: string;
  stopName: string;
  routeCount: number;
  tripsPerDay: number;
  firstDepartureSec: number | null;
  lastDepartureSec: number | null;
  spanHours: number | null;
  headwayPeakMin: number | null;
  headwayOffpeakMin: number | null;
}

function routeCountByStop(feed: FeedSlice): Map<string, number> {
  const byStop = new Map<string, Set<string>>();
  for (const rs of feed.routeStops) {
    let set = byStop.get(rs.stop_id);
    if (!set) { set = new Set(); byStop.set(rs.stop_id, set); }
    set.add(rs.route_id);
  }
  const out = new Map<string, number>();
  for (const [stopId, set] of byStop) out.set(stopId, set.size);
  return out;
}

/** Median inter-departure gap (minutes) within a set of time-of-day windows. */
function headwayWithinBands(departuresSec: number[], windows: Array<[number, number]>): number | null {
  const gaps: number[] = [];
  for (const [start, end] of windows) {
    const inWin = departuresSec.filter((s) => s >= start && s < end).sort((a, b) => a - b);
    for (let i = 1; i < inWin.length; i++) gaps.push(inWin[i] - inWin[i - 1]);
  }
  const m = median(gaps);
  return m == null ? null : m / 60;
}

export function computeServiceIntensity(
  feed: FeedSlice,
  opts?: { serviceIds?: Set<string>; bands?: HeadwayBands },
): StopIntensity[] {
  const serviceIds = opts?.serviceIds ?? representativeDay(feed).serviceIds;
  const bands = opts?.bands ?? DEFAULT_HEADWAY_BANDS;
  const activeTrip = new Set(
    feed.trips.filter((t) => !serviceIds.size || serviceIds.has(t.service_id)).map((t) => t.trip_id),
  );
  const routeCount = routeCountByStop(feed);
  const stopNameById = new Map(feed.stops.map((s) => [s.stop_id, s.stop_name || s.stop_id]));

  // stop_id → { trips:Set, departures:number[] }
  const agg = new Map<string, { trips: Set<string>; deps: number[] }>();
  for (const st of feed.stopTimes) {
    if (!activeTrip.has(st.trip_id)) continue;
    let a = agg.get(st.stop_id);
    if (!a) { a = { trips: new Set(), deps: [] }; agg.set(st.stop_id, a); }
    a.trips.add(st.trip_id);
    const t = st.departure_time || st.arrival_time;
    if (t) a.deps.push(gtfsTimeToSeconds(t));
  }

  const out: StopIntensity[] = [];
  for (const stop of feed.stops) {
    const a = agg.get(stop.stop_id);
    if (!a || a.trips.size === 0) continue;
    const deps = a.deps;
    const first = deps.length ? Math.min(...deps) : null;
    const last = deps.length ? Math.max(...deps) : null;
    out.push({
      stopId: stop.stop_id,
      stopName: stopNameById.get(stop.stop_id) ?? stop.stop_id,
      routeCount: routeCount.get(stop.stop_id) ?? 0,
      tripsPerDay: a.trips.size,
      firstDepartureSec: first,
      lastDepartureSec: last,
      spanHours: first != null && last != null ? (last - first) / 3600 : null,
      headwayPeakMin: headwayWithinBands(deps, bands.peak),
      headwayOffpeakMin: headwayWithinBands(deps, bands.offpeak),
    });
  }
  out.sort((a, b) => b.tripsPerDay - a.tripsPerDay);
  return out;
}

/* ─────────────────── Feature 4 — accessibility audit ─────────────────── */

export interface RouteAccessibility {
  routeId: string;
  routeName: string;
  routeColor: string;
  total: number;
  populated: number;
  gapCount: number;
  pctPopulated: number;
}

export interface AccessibilityResult {
  totalStops: number;
  populatedCount: number;
  gapCount: number;
  pctPopulated: number;
  perRoute: RouteAccessibility[];
  gapStopIds: string[];
}

/** wheelchair_boarding 1 (accessible) or 2 (not accessible) = populated;
 *  0 / null / undefined = "no information" per the GTFS spec = a gap. */
function wheelchairPopulated(stop: Stop): boolean {
  return stop.wheelchair_boarding === 1 || stop.wheelchair_boarding === 2;
}

export function computeAccessibilityAudit(feed: FeedSlice): AccessibilityResult {
  // Board points only — stations (1), entrances (2), nodes (3), boarding
  // areas (4) aren't where riders board, so they don't carry the metric.
  const boardable = feed.stops.filter((s) => (s.location_type ?? 0) === 0);
  const boardableIds = new Set(boardable.map((s) => s.stop_id));
  const stopById = new Map(boardable.map((s) => [s.stop_id, s]));

  const populatedCount = boardable.filter(wheelchairPopulated).length;
  const gapStopIds = boardable.filter((s) => !wheelchairPopulated(s)).map((s) => s.stop_id);

  // Per-route breakdown over the route's served (boardable) stops.
  const routeStopsMap = new Map<string, Set<string>>();
  for (const rs of feed.routeStops) {
    if (!boardableIds.has(rs.stop_id)) continue;
    let set = routeStopsMap.get(rs.route_id);
    if (!set) { set = new Set(); routeStopsMap.set(rs.route_id, set); }
    set.add(rs.stop_id);
  }
  const perRoute: RouteAccessibility[] = feed.routes.map((r) => {
    const stopIds = routeStopsMap.get(r.route_id) ?? new Set<string>();
    let populated = 0;
    for (const sid of stopIds) if (wheelchairPopulated(stopById.get(sid)!)) populated += 1;
    const total = stopIds.size;
    return {
      routeId: r.route_id,
      routeName: r.route_short_name || r.route_long_name || r.route_id,
      routeColor: r.route_color || '888888',
      total,
      populated,
      gapCount: total - populated,
      pctPopulated: total ? (populated / total) * 100 : 100,
    };
  }).filter((r) => r.total > 0)
    .sort((a, b) => a.pctPopulated - b.pctPopulated);

  return {
    totalStops: boardable.length,
    populatedCount,
    gapCount: gapStopIds.length,
    pctPopulated: boardable.length ? (populatedCount / boardable.length) * 100 : 0,
    perRoute,
    gapStopIds,
  };
}
