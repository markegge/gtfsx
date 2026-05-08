import type { Calendar, CalendarDate } from './types';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
type DayKey = (typeof DAY_KEYS)[number];

export interface ServiceProfile {
  // Stable id derived from the day flags + service_id list, used as the
  // value for the radio/tab selector in the rendered HTML.
  id: string;
  // Human label: "Weekday", "Saturday", "Sunday", "Daily", or
  // "Weekday + Saturday", etc.
  label: string;
  // The actual GTFS service_ids that share this day pattern.
  serviceIds: string[];
}

/**
 * Compute "today" as a YYYYMMDD string in the agency's timezone (or UTC
 * fallback). Used for default-tab logic.
 */
export function todayInTimezone(timezone: string | undefined, now = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(now).replace(/-/g, '');
  } catch {
    return now.toISOString().slice(0, 10).replace(/-/g, '');
  }
}

/**
 * Day-of-week index in the agency's timezone. 0 = Sunday … 6 = Saturday.
 */
export function dayOfWeekInTimezone(timezone: string | undefined, now = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
    });
    const parts = fmt.format(now);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[parts] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

/**
 * service_ids active on a specific YYYYMMDD date, applying calendar
 * weekly flags + calendar_dates exceptions.
 */
export function activeServicesOn(
  date: string,
  dayOfWeek: number,
  calendars: Calendar[],
  calendarDates: CalendarDate[],
): Set<string> {
  const active = new Set<string>();
  const dayKey: DayKey = DAY_KEYS[dayOfWeek];

  for (const cal of calendars) {
    if (!cal) continue;
    if (cal.start_date && date < cal.start_date) continue;
    if (cal.end_date && date > cal.end_date) continue;
    if (cal[dayKey] === 1) {
      active.add(cal.service_id);
    }
  }

  for (const ex of calendarDates) {
    if (ex.date !== date) continue;
    if (ex.exception_type === 1) active.add(ex.service_id);
    else if (ex.exception_type === 2) active.delete(ex.service_id);
  }

  return active;
}

/**
 * Group calendar entries into named profiles ("Weekday" / "Saturday" / …).
 * Profiles split on **both** day pattern AND date range — so a feed with
 * a summer Weekday service and a winter Weekday service produces two
 * separate tabs. When a day pattern shows up in more than one profile
 * the label gets a date-range suffix so the rider can tell them apart.
 */
export function buildServiceProfiles(calendars: Calendar[]): ServiceProfile[] {
  const groups = new Map<string, {
    flags: number[];
    serviceIds: string[];
    startDate: string;
    endDate: string;
  }>();
  for (const cal of calendars) {
    const flags: number[] = DAY_KEYS.map((k) => cal[k]);
    const key = `${flags.join('')}|${cal.start_date}|${cal.end_date}`;
    let group = groups.get(key);
    if (!group) {
      group = { flags, serviceIds: [], startDate: cal.start_date, endDate: cal.end_date };
      groups.set(key, group);
    }
    group.serviceIds.push(cal.service_id);
  }

  const baseProfiles = Array.from(groups.entries()).map(([key, g]) => ({
    id: `svc-${hashKey(key)}`,
    flags: g.flags,
    serviceIds: g.serviceIds,
    startDate: g.startDate,
    endDate: g.endDate,
    baseLabel: labelForFlags(g.flags),
  }));

  // Count base-labels — only suffix dates onto labels that collide.
  const labelCounts = new Map<string, number>();
  for (const p of baseProfiles) {
    labelCounts.set(p.baseLabel, (labelCounts.get(p.baseLabel) ?? 0) + 1);
  }

  const profiles: ServiceProfile[] = baseProfiles.map((p) => ({
    id: p.id,
    label:
      (labelCounts.get(p.baseLabel) ?? 0) > 1
        ? `${p.baseLabel} (${formatYmdShort(p.startDate)}–${formatYmdShort(p.endDate)})`
        : p.baseLabel,
    serviceIds: p.serviceIds,
  }));

  // Order: Weekday → Saturday → Sunday → Daily → other (alphabetical).
  const order = (label: string) => {
    if (label.startsWith('Weekday')) return 0;
    if (label.startsWith('Saturday')) return 1;
    if (label.startsWith('Sunday')) return 2;
    if (label.startsWith('Daily')) return 3;
    return 4;
  };
  profiles.sort((a, b) => {
    const da = order(a.label);
    const db = order(b.label);
    if (da !== db) return da - db;
    return a.label.localeCompare(b.label);
  });
  return profiles;
}

function formatYmdShort(ymd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [, , mo, d] = m;
  const date = new Date(Date.UTC(2000, parseInt(mo, 10) - 1, parseInt(d, 10)));
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(date);
}

function hashKey(s: string): string {
  // Tiny stable hash so the URL-friendly id stays short. Collisions
  // unlikely at the size of any realistic feed.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function labelForFlags(flags: number[]): string {
  // flags are [sun, mon, tue, wed, thu, fri, sat]
  const [sun, mon, tue, wed, thu, fri, sat] = flags;
  const weekdays = mon === 1 && tue === 1 && wed === 1 && thu === 1 && fri === 1;
  if (weekdays && sat === 1 && sun === 1) return 'Daily';
  if (weekdays && sat === 0 && sun === 0) return 'Weekday';
  if (sat === 1 && sun === 0 && mon === 0 && tue === 0 && wed === 0 && thu === 0 && fri === 0) {
    return 'Saturday';
  }
  if (sun === 1 && sat === 0 && mon === 0 && tue === 0 && wed === 0 && thu === 0 && fri === 0) {
    return 'Sunday';
  }
  // Compose a custom label from active day abbreviations.
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const active = names.filter((_, i) => flags[i] === 1);
  return active.length ? active.join(' ') : 'No service';
}

/**
 * Given a set of active service_ids for "today", pick the matching
 * profile (the one whose serviceIds intersect today's most heavily).
 * Falls back to the first profile when there's no match.
 */
export function pickDefaultProfile(
  profiles: ServiceProfile[],
  activeToday: Set<string>,
): ServiceProfile | null {
  if (profiles.length === 0) return null;
  let best: ServiceProfile | null = null;
  let bestCount = -1;
  for (const p of profiles) {
    let count = 0;
    for (const id of p.serviceIds) {
      if (activeToday.has(id)) count++;
    }
    if (count > bestCount) {
      best = p;
      bestCount = count;
    }
  }
  return best ?? profiles[0];
}
