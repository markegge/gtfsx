import type { StateCreator } from 'zustand';
import type { Calendar, CalendarDate } from '../types/gtfs';

export interface CalendarSlice {
  calendars: Calendar[];
  calendarDates: CalendarDate[];
  addCalendar: (calendar: Calendar) => void;
  updateCalendar: (service_id: string, updates: Partial<Calendar>) => void;
  removeCalendar: (service_id: string) => void;
  /** Clone a calendar (and its exception dates) under a new unique service_id.
   * Returns the new service_id, or null if the source doesn't exist. */
  duplicateCalendar: (service_id: string) => string | null;
  setCalendars: (calendars: Calendar[]) => void;
  addCalendarDate: (cd: CalendarDate) => void;
  removeCalendarDate: (service_id: string, date: string) => void;
  /** Remove every calendar_dates exception for a single service_id. */
  clearCalendarDates: (service_id: string) => void;
  setCalendarDates: (dates: CalendarDate[]) => void;
}

export const createCalendarSlice: StateCreator<CalendarSlice, [['zustand/immer', never]], [], CalendarSlice> = (set, get) => ({
  calendars: [],
  calendarDates: [],
  addCalendar: (calendar) => set((state) => { state.calendars.push(calendar); }),
  updateCalendar: (service_id, updates) => set((state) => {
    const idx = state.calendars.findIndex((c) => c.service_id === service_id);
    if (idx !== -1) Object.assign(state.calendars[idx], updates);
  }),
  removeCalendar: (service_id) => set((state) => {
    state.calendars = state.calendars.filter((c) => c.service_id !== service_id);
    state.calendarDates = state.calendarDates.filter((cd) => cd.service_id !== service_id);
  }),
  duplicateCalendar: (service_id) => {
    const s0 = get();
    const orig = s0.calendars.find((c) => c.service_id === service_id);
    if (!orig) return null;
    const existing = new Set(s0.calendars.map((c) => c.service_id));
    let newId = `${service_id}_copy`;
    let n = 2;
    while (existing.has(newId)) newId = `${service_id}_copy${n++}`;
    const dateCopies = s0.calendarDates
      .filter((cd) => cd.service_id === service_id)
      .map((cd) => ({ ...cd, service_id: newId }));
    set((state) => {
      state.calendars.push({
        ...orig,
        service_id: newId,
        _description: orig._description ? `${orig._description} (copy)` : orig._description,
      });
      state.calendarDates.push(...dateCopies);
    });
    return newId;
  },
  setCalendars: (calendars) => set((state) => { state.calendars = calendars; }),
  addCalendarDate: (cd) => set((state) => { state.calendarDates.push(cd); }),
  removeCalendarDate: (service_id, date) => set((state) => {
    state.calendarDates = state.calendarDates.filter(
      (cd) => !(cd.service_id === service_id && cd.date === date)
    );
  }),
  clearCalendarDates: (service_id) => set((state) => {
    state.calendarDates = state.calendarDates.filter(
      (cd) => cd.service_id !== service_id
    );
  }),
  setCalendarDates: (dates) => set((state) => { state.calendarDates = dates; }),
});
