import type { AppStore } from '../store';
import { gtfsTimeToSeconds } from '../utils/time';

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
  totalPeakVehicles: number;
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
 *  Considers both arrival_time and departure_time (first stop may have only departure). */
function getTripSpan(
  tripId: string,
  stopTimes: AppStore['stopTimes']
): { start: number; end: number } | null {
  const times = stopTimes
    .filter((st) => st.trip_id === tripId && (st.arrival_time || st.departure_time))
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

export function calculateRouteStats(
  routeId: string,
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'>,
  defaultCostPerHour = 0,
  deadheadFactor = 1.2,
): RouteStats {
  const route = state.routes.find((r) => r.route_id === routeId);
  const routeTrips = state.trips.filter((t) => t.route_id === routeId);
  const costPerHour = route?._cost_per_revenue_hour ?? defaultCostPerHour;

  // Group trips by service_id — trips on different service patterns don't run on the same day
  const tripsByService = new Map<string, typeof routeTrips>();
  for (const trip of routeTrips) {
    const group = tripsByService.get(trip.service_id) || [];
    group.push(trip);
    tripsByService.set(trip.service_id, group);
  }

  // Calculate stats per service pattern, then sum to weekly totals
  let weeklyRevHours = 0;
  let weeklyTotalHours = 0;
  let weeklyTrips = 0;
  let maxPeakVehicles = 0;
  let weeklyCost = 0;
  let annualCost = 0;

  for (const [serviceId, serviceTrips] of tripsByService) {
    const spans: { start: number; end: number }[] = [];
    let revSeconds = 0;

    for (const trip of serviceTrips) {
      const span = getTripSpan(trip.trip_id, state.stopTimes);
      if (span) {
        spans.push(span);
        revSeconds += span.end - span.start;
      }
    }

    const revHours = revSeconds / 3600;
    const totalHours = revHours * deadheadFactor;
    const peak = computePeakVehicles(spans);
    const dailyCostForPattern = totalHours * costPerHour;

    // Count how many days per week this pattern operates
    const cal = state.calendars.find((c) => c.service_id === serviceId);
    const daysPerWeek = cal
      ? Number(cal.monday) + Number(cal.tuesday) + Number(cal.wednesday) + Number(cal.thursday) + Number(cal.friday) + Number(cal.saturday) + Number(cal.sunday)
      : 7;

    weeklyRevHours += revHours * daysPerWeek;
    weeklyTotalHours += totalHours * daysPerWeek;
    weeklyTrips += serviceTrips.length * daysPerWeek;
    if (peak > maxPeakVehicles) maxPeakVehicles = peak;
    weeklyCost += dailyCostForPattern * daysPerWeek;

    const serviceDaysPerYear = countServiceDaysPerYear([serviceId], state);
    annualCost += dailyCostForPattern * serviceDaysPerYear;
  }

  return {
    revenueHoursWeekly: weeklyRevHours,
    totalHoursWeekly: weeklyTotalHours,
    tripsPerWeek: weeklyTrips,
    peakVehicles: maxPeakVehicles,
    weeklyCost,
    annualCost,
  };
}

export function calculateSystemStats(
  state: Pick<AppStore, 'routes' | 'trips' | 'stopTimes' | 'calendars' | 'calendarDates'>,
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

  return {
    totalRevenueHoursWeekly,
    totalHoursWeekly,
    totalTripsPerWeek,
    totalPeakVehicles,
    totalWeeklyCost,
    totalAnnualCost,
  };
}
