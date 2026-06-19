/**
 * E1 — Feed-state diff.
 *
 * The pure comparison engine under A2 (scenario / variant comparison): given two
 * feed states, produce a structured changeset (added / removed / changed counts
 * per entity type) plus headline KPI deltas (Δ revenue-hours, peak vehicles,
 * trips, weekly/annual cost) and a per-route changeset for the "what does this
 * service change cost vs. baseline?" view.
 *
 * Pure: no store, no network. Both sides are plain feed-state objects (the
 * buildSnapshot() shape), so the same function compares a variant to baseline,
 * a snapshot to working state, etc.
 */
import type { Route, Trip, StopTime, Stop, Calendar, CalendarDate, Frequency, RouteStop } from '../types/gtfs';
import { calculateSystemStats, calculateRouteStats, type SystemStats } from './costEstimation';

/** The slices of a feed that matter for planning comparison. */
export interface FeedState {
  routes: Route[];
  routeStops: RouteStop[];
  trips: Trip[];
  stopTimes: StopTime[];
  stops: Stop[];
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  frequencies: Frequency[];
}

export interface DiffOptions {
  /** $/revenue-hour used for the cost deltas. Mirrors the Costs panel default. */
  costPerHour?: number;
  deadheadFactor?: number;
}

export interface EntityChange {
  added: number;
  removed: number;
  changed: number;
  addedIds: string[];
  removedIds: string[];
}

export interface RouteChange {
  routeId: string;
  label: string;
  kind: 'added' | 'removed' | 'changed';
  tripsPerWeekDelta: number;
  revHoursWeeklyDelta: number;
  peakVehiclesDelta: number;
  weeklyCostDelta: number;
  annualCostDelta: number;
}

export interface KpiDelta {
  revenueHoursWeekly: number;
  systemPeakVehicles: number;
  tripsPerWeek: number;
  weeklyCost: number;
  annualCost: number;
}

export interface FeedDiff {
  /** System stats for each side + their delta (b − a). */
  kpi: { a: SystemStats; b: SystemStats; delta: KpiDelta };
  routes: EntityChange;
  stops: EntityChange;
  calendars: EntityChange;
  frequencies: EntityChange;
  /** Distinct (route, direction, shape) patterns. */
  patterns: EntityChange;
  trips: { a: number; b: number; delta: number };
  /** Per-route changeset, sorted by magnitude of impact (largest first). */
  routeChanges: RouteChange[];
  /** True when the two states are identical across every tracked entity. */
  identical: boolean;
}

const emptyChange = (): EntityChange => ({ added: 0, removed: 0, changed: 0, addedIds: [], removedIds: [] });

function diffById<T>(
  a: T[],
  b: T[],
  id: (t: T) => string,
  equal: (x: T, y: T) => boolean,
): EntityChange {
  const out = emptyChange();
  const aMap = new Map(a.map((x) => [id(x), x]));
  const bMap = new Map(b.map((x) => [id(x), x]));
  for (const [k, bv] of bMap) {
    const av = aMap.get(k);
    if (!av) { out.added++; out.addedIds.push(k); }
    else if (!equal(av, bv)) out.changed++;
  }
  for (const [k] of aMap) {
    if (!bMap.has(k)) { out.removed++; out.removedIds.push(k); }
  }
  return out;
}

const routeEqual = (x: Route, y: Route) =>
  x.route_short_name === y.route_short_name &&
  x.route_long_name === y.route_long_name &&
  x.route_type === y.route_type &&
  x.route_color === y.route_color &&
  x._cost_per_revenue_hour === y._cost_per_revenue_hour;

const stopEqual = (x: Stop, y: Stop) =>
  x.stop_name === y.stop_name && x.stop_lat === y.stop_lat && x.stop_lon === y.stop_lon;

const calEqual = (x: Calendar, y: Calendar) =>
  x.monday === y.monday && x.tuesday === y.tuesday && x.wednesday === y.wednesday &&
  x.thursday === y.thursday && x.friday === y.friday && x.saturday === y.saturday &&
  x.sunday === y.sunday && x.start_date === y.start_date && x.end_date === y.end_date;

const freqEqual = (x: Frequency, y: Frequency) =>
  x.start_time === y.start_time && x.end_time === y.end_time && x.headway_secs === y.headway_secs;

const patternSig = (rs: RouteStop) => `${rs.route_id}|${rs.direction_id}|${rs.shape_id ?? ''}`;

function routeLabel(routes: Route[], routeId: string): string {
  const r = routes.find((x) => x.route_id === routeId);
  return r?.route_short_name || r?.route_long_name || routeId;
}

/** Cost-engine view of a feed state (the Pick calculateSystemStats wants). */
function asStatsState(s: FeedState) {
  return {
    routes: s.routes,
    trips: s.trips,
    stopTimes: s.stopTimes,
    calendars: s.calendars,
    calendarDates: s.calendarDates,
    frequencies: s.frequencies,
  };
}

export function diffFeedState(a: FeedState, b: FeedState, opts: DiffOptions = {}): FeedDiff {
  const costPerHour = opts.costPerHour ?? 100;
  const deadheadFactor = opts.deadheadFactor ?? 1.1;

  const aStats = calculateSystemStats(asStatsState(a), costPerHour, deadheadFactor);
  const bStats = calculateSystemStats(asStatsState(b), costPerHour, deadheadFactor);

  const routes = diffById(a.routes, b.routes, (r) => r.route_id, routeEqual);
  const stops = diffById(a.stops, b.stops, (s) => s.stop_id, stopEqual);
  const calendars = diffById(a.calendars, b.calendars, (c) => c.service_id, calEqual);
  const frequencies = diffById(
    a.frequencies, b.frequencies,
    (f) => `${f.trip_id}|${f.start_time}`,
    freqEqual,
  );

  // Patterns: a distinct (route, direction, shape) signature, deduped per side.
  const aPatterns = [...new Set(a.routeStops.map(patternSig))].map((sig) => ({ sig }));
  const bPatterns = [...new Set(b.routeStops.map(patternSig))].map((sig) => ({ sig }));
  const patterns = diffById(aPatterns, bPatterns, (p) => p.sig, () => true);

  // Per-route changeset. Union of route ids; per-route stats on each side.
  const routeIds = new Set<string>([...a.routes, ...b.routes].map((r) => r.route_id));
  const aStateForRoute = asStatsState(a);
  const bStateForRoute = asStatsState(b);
  const routeChanges: RouteChange[] = [];
  for (const routeId of routeIds) {
    const inA = a.routes.some((r) => r.route_id === routeId);
    const inB = b.routes.some((r) => r.route_id === routeId);
    const sa = calculateRouteStats(routeId, aStateForRoute, costPerHour, deadheadFactor);
    const sb = calculateRouteStats(routeId, bStateForRoute, costPerHour, deadheadFactor);
    const change: RouteChange = {
      routeId,
      label: routeLabel(inB ? b.routes : a.routes, routeId),
      kind: !inA ? 'added' : !inB ? 'removed' : 'changed',
      tripsPerWeekDelta: sb.tripsPerWeek - sa.tripsPerWeek,
      revHoursWeeklyDelta: sb.revenueHoursWeekly - sa.revenueHoursWeekly,
      peakVehiclesDelta: sb.peakVehicles - sa.peakVehicles,
      weeklyCostDelta: sb.weeklyCost - sa.weeklyCost,
      annualCostDelta: sb.annualCost - sa.annualCost,
    };
    // Skip routes present in both with no measurable change.
    const unchanged = change.kind === 'changed'
      && change.tripsPerWeekDelta === 0
      && Math.abs(change.revHoursWeeklyDelta) < 1e-6
      && change.peakVehiclesDelta === 0
      && Math.abs(change.annualCostDelta) < 1e-6;
    if (!unchanged) routeChanges.push(change);
  }
  routeChanges.sort((x, y) =>
    Math.abs(y.annualCostDelta) - Math.abs(x.annualCostDelta) ||
    Math.abs(y.tripsPerWeekDelta) - Math.abs(x.tripsPerWeekDelta),
  );

  const tripsDiff = { a: a.trips.length, b: b.trips.length, delta: b.trips.length - a.trips.length };

  const identical =
    routes.added + routes.removed + routes.changed === 0 &&
    stops.added + stops.removed + stops.changed === 0 &&
    calendars.added + calendars.removed + calendars.changed === 0 &&
    frequencies.added + frequencies.removed + frequencies.changed === 0 &&
    patterns.added + patterns.removed === 0 &&
    tripsDiff.delta === 0 &&
    routeChanges.length === 0;

  return {
    kpi: {
      a: aStats,
      b: bStats,
      delta: {
        revenueHoursWeekly: bStats.totalRevenueHoursWeekly - aStats.totalRevenueHoursWeekly,
        systemPeakVehicles: bStats.systemPeakVehicles - aStats.systemPeakVehicles,
        tripsPerWeek: bStats.totalTripsPerWeek - aStats.totalTripsPerWeek,
        weeklyCost: bStats.totalWeeklyCost - aStats.totalWeeklyCost,
        annualCost: bStats.totalAnnualCost - aStats.totalAnnualCost,
      },
    },
    routes,
    stops,
    calendars,
    frequencies,
    patterns,
    trips: tripsDiff,
    routeChanges,
    identical,
  };
}
