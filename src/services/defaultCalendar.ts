import { format } from 'date-fns';
import { useStore } from '../store';

const DEFAULT_SERVICE_ID = 'default';

/**
 * Return the service_id of the first existing calendar, or — if the project
 * has none — materialize a sensible default and return its id.
 *
 * The default is 7-day service for two years from today, with
 * _description "Default Calendar" and service_id "default". Idempotent:
 * subsequent calls return the existing first calendar without re-creating.
 *
 * Use this from any code path that needs to stamp a trip with a service_id
 * on a project that may not have any calendars yet (draw_route's
 * finishDrawing, the timetable's manual Add Trip, etc.). Without it,
 * fallbacks scatter through the codebase (hardcoded "service-1", empty
 * strings) and produce broken trips that don't reconcile to any actual
 * calendar.
 */
export function ensureDefaultCalendar(): string {
  const state = useStore.getState();
  if (state.calendars.length > 0) {
    return state.calendars[0].service_id;
  }
  const now = new Date();
  const end = new Date(now.getFullYear() + 2, now.getMonth(), now.getDate());
  state.addCalendar({
    service_id: DEFAULT_SERVICE_ID,
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 1, sunday: 1,
    start_date: format(now, 'yyyyMMdd'),
    end_date: format(end, 'yyyyMMdd'),
    _description: 'Default Calendar',
  });
  return DEFAULT_SERVICE_ID;
}
