// US federal-holiday date math, shared by the calendar editor's "bulk-add
// holiday exceptions" feature and the #17 validation nudge. All public helpers
// speak GTFS YYYYMMDD date strings. Date components are read in LOCAL time
// throughout (new Date(y, m, d) + getDate()/getDay()), so there's no UTC drift.

/**
 * Date for the Nth occurrence of a given weekday in a month.
 * @param year   Full year
 * @param month  0-based month
 * @param weekday 0=Sunday … 6=Saturday
 * @param n      Which occurrence (1=first, 2=second, …)
 */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const dayOfWeek = first.getDay();
  const diff = (weekday - dayOfWeek + 7) % 7;
  const date = 1 + diff + (n - 1) * 7;
  return new Date(year, month, date);
}

/** Last Monday of the given (0-based) month. */
export function lastMondayOfMonth(year: number, month: number): Date {
  const lastDay = new Date(year, month + 1, 0);
  const dayOfWeek = lastDay.getDay();
  const diff = (dayOfWeek - 1 + 7) % 7;
  return new Date(year, month, lastDay.getDate() - diff);
}

/** JS Date → GTFS YYYYMMDD (local components). */
export function dateToGtfs(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export interface USHoliday {
  name: string;
  getDate: (year: number) => Date;
}

/**
 * Major US federal holidays. Fixed-date and nth-weekday rules. Juneteenth
 * became a federal holiday in 2021. Columbus Day is also observed as
 * Indigenous Peoples' Day. This list drives both the calendar editor's
 * bulk-add UI and the #17 missing-exception validation nudge.
 */
export const US_HOLIDAYS: USHoliday[] = [
  { name: "New Year's Day", getDate: (y) => new Date(y, 0, 1) },
  { name: 'MLK Day', getDate: (y) => nthWeekdayOfMonth(y, 0, 1, 3) },        // 3rd Monday of January
  { name: "Presidents' Day", getDate: (y) => nthWeekdayOfMonth(y, 1, 1, 3) }, // 3rd Monday of February
  { name: 'Memorial Day', getDate: (y) => lastMondayOfMonth(y, 4) },          // last Monday of May
  { name: 'Juneteenth', getDate: (y) => new Date(y, 5, 19) },                 // June 19
  { name: 'Independence Day', getDate: (y) => new Date(y, 6, 4) },            // July 4
  { name: 'Labor Day', getDate: (y) => nthWeekdayOfMonth(y, 8, 1, 1) },       // 1st Monday of September
  { name: 'Columbus Day', getDate: (y) => nthWeekdayOfMonth(y, 9, 1, 2) },    // 2nd Monday of October
  { name: 'Veterans Day', getDate: (y) => new Date(y, 10, 11) },              // November 11
  { name: 'Thanksgiving', getDate: (y) => nthWeekdayOfMonth(y, 10, 4, 4) },   // 4th Thursday of November
  { name: 'Christmas Day', getDate: (y) => new Date(y, 11, 25) },             // December 25
];

export interface USHolidayDate {
  name: string;
  gtfsDate: string;   // YYYYMMDD
  dayOfWeek: number;  // 0=Sunday … 6=Saturday
}

/** Every US holiday in a single calendar year, as GTFS dates. */
export function getUSHolidaysForYear(year: number): USHolidayDate[] {
  return US_HOLIDAYS.map((h) => {
    const d = h.getDate(year);
    return { name: h.name, gtfsDate: dateToGtfs(d), dayOfWeek: d.getDay() };
  });
}

/**
 * Every US holiday whose date falls within [startDate, endDate] inclusive
 * (GTFS YYYYMMDD strings), spanning every year the range touches. Handles
 * multi-year ranges and leap years (date math is real-calendar based).
 */
export function getUSHolidaysInRange(startDate: string, endDate: string): USHolidayDate[] {
  const startYear = parseInt(startDate.slice(0, 4), 10);
  const endYear = parseInt(endDate.slice(0, 4), 10);
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) return [];
  const out: USHolidayDate[] = [];
  for (let y = startYear; y <= endYear; y++) {
    for (const h of getUSHolidaysForYear(y)) {
      if (h.gtfsDate >= startDate && h.gtfsDate <= endDate) out.push(h);
    }
  }
  return out;
}
