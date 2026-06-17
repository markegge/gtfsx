import type { AppStore } from '../store';
import type { Frequency, StopTime } from '../types/gtfs';
import { gtfsTimeToSeconds } from '../utils/time';

export interface RouteSpans {
  weeklyRevHours: number;
  weeklyTotalHoursBase: number; // revenue hours (no deadhead applied yet)
  tripsPerWeek: number;
  peakVehicles: number;
  /** Per-service-id breakdown needed for annual cost calculation */
  _serviceBreakdown: {
    serviceId: string;
    revHours: number;
    daysPerWeek: number;
    serviceDaysPerYear: number;
    peak: number;
  }[];
}

export interface RouteStats {
  revenueHoursWeekly: number;
  totalHoursWeekly: number; // revenue hours * deadhead factor
  tripsPerWeek: number;
  peakVehicles: number;
  weeklyCost: number;
  annualCost: number;
}

export interface SystemStats {
  totalRevenueHoursWeekly: number;
  totalHoursWeekly: number;
  totalTripsPerWeek: number;
  /** Sum of each route's individual peak. OVER-counts the real fleet need
   *  because routes peak at different times of day — kept for the CSV/context
   *  only; use `systemPeakVehicles` for "vehicles required for peak service". */
  totalPeakVehicles: number;
  /** TRUE whole-system peak: max vehicles simultaneously in service at the
   *  single busiest instant across the entire system (≤ totalPeakVehicles). */
  systemPeakVehicles: number;
  totalWeeklyCost: number;
  totalAnnualCost: number;
}

/** Count service days per year from calendar entries and calendar_dates exceptions. */
function countServiceDaysPerYear(
  serviceIds: string[],
  state: Pick<AppStore, 'calendars' | 'calendarDates'>
): number {
  if (serviceIds.length === 0) return 365;

  const relevantCalendars = state.calendars.filter((c) =>
    serviceIds.includes(c.service_id)
  );

  if (relevantCalendars.length === 0) return 365;

  let bestDaysPerYear = 0;

  for (const cal of relevantCalendars) {
    const start = parseYYYYMMDD(cal.start_date);
    const end = parseYYYYMMDD(cal.end_date);
    if (!start || !end) continue;

    const dayFlags = [
      cal.sunday,
      cal.monday,
      cal.tuesday,
      cal.wednesday,
      cal.thursday,
      cal.friday,
      cal.saturday,
    ];

    // Count active days per week from the pattern
    const activeDaysPerWeek = dayFlags.reduce<number>((sum, v) => sum + Number(v), 0);
    if (activeDaysPerWeek === 0) continue;

    // Calculate span in days, capped to avoid iterating huge ranges
    const spanMs = end.getTime() - start.getTime();
    const spanDays = Math.max(1, Math.round(spanMs / 86400000) + 1);

    // For spans over 2 years, use weekly rate × 52 instead of iterating
    let serviceDays: number;
    if (spanDays > 730) {
      serviceDays = activeDaysPerWeek * 52;
    } else {
      // Count actual service days in the range
      serviceDays = 0;
      const cursor = new Date(start);
      while (cursor <= end) {
        if (dayFlags[cursor.getDay()]) serviceDays++;
        cursor.setDate(cursor.getDate() + 1);
      }

      // Apply calendar_dates exceptions
      const exceptions = state.calendarDates.filter(
        (cd) => cd.service_id === cal.service_id
      );
      for (const ex of exceptions) {
        const exDate = parseYYYYMMDD(ex.date);
        if (!exDate || exDate < start || exDate > end) continue;
        if (ex.exception_type === 1) {
          if (!dayFlags[exDate.getDay()]) serviceDays++;
        } else if (ex.exception_type === 2) {
          if (dayFlags[exDate.getDay()]) serviceDays--;
        }
      }

      // Normalize to a full year if the range is shorter or longer than 1 year
      const spanYears = spanDays / 365.25;
      if (spanYears > 0) {
        serviceDays = Math.round(serviceDays / spanYears);
      }
    }

    if (serviceDays > bestDaysPerYear) bestDaysPerYear = serviceDays;
  }

  return bestDaysPerYear || 365;
}

function parseYYYYMMDD(s: string): Date | null {
  if (!s || s.length !== 8) return null;
  const y = parseInt(s.slice(0, 4), 10);
  const m = parseInt(s.slice(4, 6), 10) - 1;
  const d = parseInt(s.slice(6, 8), 10);
  return new Date(y, m, d);
}

/** Get the first and last stop time seconds for a trip by stop_sequence order.
 *  Uses the first and last non-blank times in sequence order for a robust span.
 *  Considers both arrival_time and departure_time (first stop may have only departure).
 *  Accepts either a pre-filtered array (from byTrip index) or falls back to filtering. */
function getTripSpan(
  tripId: string,
  stopTimesOrIndex: StopTime[] | Map<string, StopTime[]>
): { start: number; end: number } | null {
  const raw = Array.isArray(stopTimesOrIndex)
    ? stopTimesOrIndex.filter((st) => st.trip_id === tripId)
    : (stopTimesOrIndex.get(tripId) || []);
  const times = raw
    .filter((st) => st.arrival_time || st.departure_time)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
  if (times.length < 2) return null;

  const first = times[0];
  const last = times[times.length - 1];
  const start = gtfsTimeToSeconds(first.departure_time || first.arrival_time);
  const end = gtfsTimeToSeconds(last.arrival_time || last.departure_time);

  if (end <= start) return null;
  return { start, end };
}

/** Estimate peak overlapping vehicles using a sweep-line algorithm. */
function computePeakVehicles(spans: { start: number; end: number }[]): number {
  if (spans.length === 0) return 0;

  const events: { time: number; delta: number }[] = [];
  for (const span of spans) {
    events.push({ time: span.start, delta: 1 });
    events.push({ time: span.end, delta: -1 });
  }

  // Sort by time; on tie, ends (-1) before starts (+1) so we don't over-count
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const ev of events) {
    current += ev.delta;
    if (current > peak) peak = current;
  }

  return peak;
}

/** The in-service spans a single trip contributes to the concurrency sweep.
 *
 *  Normally one span = [first departure, last arrival]. But if the trip has
 *  frequencies.txt entries it is a headway-based pattern standing in for many
 *  vehicles rather than a single run: during each [start_time, end_time) window
 *  the number of vehicles simultaneously in service is ≈
 *  ceil(tripDuration / headway_secs), so we emit that many overlapping copies of
 *  the window (the reference run's explicit stop_times are ignored, per the GTFS
 *  spec). Invalid windows (non-positive headway or empty range) are skipped, and
 *  if every window is invalid we fall back to the single reference span so the
 *  trip still counts as one vehicle. */
function tripConcurrencySpans(
  span: { start: number; end: number },
  freqs: Frequency[] | undefined,
): { start: number; end: number }[] {
  if (!freqs || freqs.length === 0) return [span];

  const duration = span.end - span.start;
  const out: { start: number; end: number }[] = [];
  for (const f of freqs) {
    const winStart = gtfsTimeToSeconds(f.start_time);
    const winEnd = gtfsTimeToSeconds(f.end_time);
    if (winEnd <= winStart || f.headway_secs <= 0 || duration <= 0) continue;
    const concurrent = Math.max(1, Math.ceil(duration / f.headway_secs));
    for (let i = 0; i < concurrent; i++) out.push({ start: winStart, end: winEnd });
  }

  return out.length > 0 ? out : [span];
}

/** TRUE whole-system peak: the maximum number of vehicles simultaneously in
 *  service at the single busiest instant across the ENTIRE system.
 *
 *  Gathers every trip across every route, groups them by service_id, and runs
 *  the concurrency sweep over ALL of that service_id's trips system-wide; the
 *  answer is the MAX over service_ids. This is the "vehicles required for peak
 *  service" number, and it is ≤ the sum of per-route peaks (routes peak at
 *  different times of day, so their peaks never all stack at one instant).
 *
 *  Design notes (matches calculateRouteSpans' existing approach):
 *   - Grouping by service_id mirrors the per-route logic and keeps day-types
 *     separate (one service_id ≈ one day type). This can slightly UNDER-count
 *     when a single calendar DATE is served by multiple overlapping service_ids
 *     whose peaks would actually stack on that date — acceptable for v1.
 *   - block_id is intentionally NOT special-cased: a block's trips are
 *     sequential and never overlap, so the per-trip sweep already yields the
 *     correct instantaneous peak (block_id affects total fleet/deadhead, not the
 *     instantaneous in-service count).
 *   - frequencies.txt IS honored via tripConcurrencySpans (a headway-based trip
 *     contributes ceil(tripDuration / headway) concurrent vehicles per window). */
export function calculateSystemPeakVehicles(
  state: Pick<AppStore, 'trips'> & {
    stopTimes: StopTime[];
    stopTimesByTrip?: Map<string, StopTime[]>;
    frequencies?: Frequency[];
  },
): number {
  const lookup = state.stopTimesByTrip || state.stopTimes;

  // Index frequencies by trip_id for O(1) lookup per trip.
  const freqByTrip = new Map<string, Frequency[]>();
  for (const f of state.frequencies || []) {
    const group = freqByTrip.get(f.trip_id) || [];
    group.push(f);
    freqByTrip.set(f.trip_id, group);
  }

  // Group every trip (all routes) by service_id, accumulating its concurrency
  // spans into that service_id's bucket.
  const spansByService = new Map<string, { start: number; end: number }[]>();
  for (const trip of state.trips) {
    const span = getTripSpan(trip.trip_id, lookup);
    if (!span) continue;
    const group = spansByService.get(trip.service_id) || [];
    for (const s of tripConcurrencySpans(span, freqByTrip.get(trip.trip_id))) {
      group.push(s);
    }
    spansByService.set(trip.service_id, group);
  }

  let systemPeak = 0;
  for (const spans of spansByService.values()) {
    const peak = computePeakVehicles(spans);
    if (peak > systemPeak) systemPeak = peak;
  }
  return systemPeak;
}

/** Phase 2: Compute route spans (expensive, depends on trips + stopTimes).
 *  Accepts an optional byTrip index for O(1) lookups instead of O(n) scans. */
export function calculateRouteSpans(
  routeId: string,
  state: Pick<AppStore, 'routes' | 'trips' | 'calendars' | 'calendarDates'> & {
    stopTimes: StopTime[];
    stopTimesByTrip?: Map<string, StopTime[]>;
  },
): RouteSpans {
  const routeTrips = state.trips.filter((t) => t.route_id === routeId);
  const lookup = state.stopTimesByTrip || state.stopTimes;

  // Group trips by service_id
  const tripsByService = new Map<string, typeof routeTrips>();
  for (const trip of routeTrips) {
    const group = tripsByService.get(trip.service_id) || [];
    group.push(trip);
    tripsByService.set(trip.service_id, group);
  }

  let weeklyRevHours = 0;
  let weeklyTrips = 0;
  let maxPeakVehicles = 0;
  const serviceBreakdown: RouteSpans['_serviceBreakdown'] = [];

  for (const [serviceId, serviceTrips] of tripsByService) {
    const spans: { start: number; end: number }[] = [];
    let revSeconds = 0;

    for (const trip of serviceTrips) {
      const span = getTripSpan(trip.trip_id, lookup);
      if (span) {
        spans.push(span);
        revSeconds += span.end - span.start;
      }
    }

    const revHours = revSeconds / 3600;
    const peak = computePeakVehicles(spans);

    const cal = state.calendars.find((c) => c.service_id === serviceId);
    const daysPerWeek = cal
      ? Number(cal.monday) + Number(cal.tuesday) + Number(cal.wednesday) + Number(cal.thursday) + Number(cal.friday) + Number(cal.saturday) + Number(cal.sunday)
      : 7;

    weeklyRevHours += revHours * daysPerWeek;
    weeklyTrips += serviceTrips.length * daysPerWeek;
    if (peak > maxPeakVehicles) maxPeakVehicles = peak;

    const serviceDaysPerYear = countServiceDaysPerYear([serviceId], state);
    serviceBreakdown.push({ serviceId, revHours, daysPerWeek, serviceDaysPerYear, peak });
  }

  return {
    weeklyRevHours,
    weeklyTotalHoursBase: weeklyRevHours, // same as rev hours before deadhead
    tripsPerWeek: weeklyTrips,
    peakVehicles: maxPeakVehicles,
    _serviceBreakdown: serviceBreakdown,
  };
}

/** Phase 2: Apply cost parameters to pre-computed spans (cheap multiplication). */
export function applyRouteCosts(
  spans: RouteSpans,
  costPerHour: number,
  deadheadFactor: number,
): RouteStats {
  const weeklyTotalHours = spans.weeklyRevHours * deadheadFactor;
  let weeklyCost = 0;
  let annualCost = 0;

  for (const svc of spans._serviceBreakdown) {
    const totalHoursForSvc = svc.revHours * deadheadFactor;
    const dailyCost = totalHoursForSvc * costPerHour;
    weeklyCost += dailyCost * svc.daysPerWeek;
    annualCost += dailyCost * svc.serviceDaysPerYear;
  }

  return {
    revenueHoursWeekly: spans.weeklyRevHours,
    totalHoursWeekly: weeklyTotalHours,
    tripsPerWeek: spans.tripsPerWeek,
    peakVehicles: spans.peakVehicles,
    weeklyCost,
    annualCost,
  };
}

/** Combined convenience function (backward-compatible). */
export function calculateRouteStats(
  routeId: string,
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'> & {
    stopTimesByTrip?: Map<string, StopTime[]>;
  },
  defaultCostPerHour = 0,
  deadheadFactor = 1.2,
): RouteStats {
  const route = state.routes.find((r) => r.route_id === routeId);
  const costPerHour = route?._cost_per_revenue_hour ?? defaultCostPerHour;
  const spans = calculateRouteSpans(routeId, state);
  return applyRouteCosts(spans, costPerHour, deadheadFactor);
}

export function calculateSystemStats(
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'> & {
    stopTimesByTrip?: Map<string, StopTime[]>;
    frequencies?: Frequency[];
  },
  defaultCostPerHour = 0,
  deadheadFactor = 1.2,
): SystemStats {
  let totalRevenueHoursWeekly = 0;
  let totalHoursWeekly = 0;
  let totalTripsPerWeek = 0;
  let totalPeakVehicles = 0;
  let totalWeeklyCost = 0;
  let totalAnnualCost = 0;

  for (const route of state.routes) {
    const stats = calculateRouteStats(route.route_id, state, defaultCostPerHour, deadheadFactor);
    totalRevenueHoursWeekly += stats.revenueHoursWeekly;
    totalHoursWeekly += stats.totalHoursWeekly;
    totalTripsPerWeek += stats.tripsPerWeek;
    totalPeakVehicles += stats.peakVehicles;
    totalWeeklyCost += stats.weeklyCost;
    totalAnnualCost += stats.annualCost;
  }

  // The real fleet need: max simultaneous vehicles across the whole system,
  // NOT the sum of per-route peaks above (which over-counts).
  const systemPeakVehicles = calculateSystemPeakVehicles(state);

  return {
    totalRevenueHoursWeekly,
    totalHoursWeekly,
    totalTripsPerWeek,
    totalPeakVehicles,
    systemPeakVehicles,
    totalWeeklyCost,
    totalAnnualCost,
  };
}
