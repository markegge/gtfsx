import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { DayToggle } from '../ui/DayToggle';
import { FormField } from '../ui/FormField';
import { CalendarPreview } from './CalendarPreview';
import { generateId } from '../../services/idGenerator';
import type { Calendar } from '../../types/gtfs';
import { format } from 'date-fns';
import { US_HOLIDAYS, getEligibleHolidayExceptions } from '../../utils/holidays';

function formatGtfsDate(d: string): string {
  if (!d || d.length !== 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}

function toGtfsDate(d: string): string {
  return d.replace(/-/g, '');
}

function isWeekdayService(cal: Calendar): boolean {
  return (
    cal.monday === 1 ||
    cal.tuesday === 1 ||
    cal.wednesday === 1 ||
    cal.thursday === 1 ||
    cal.friday === 1
  );
}

export function CalendarEditor() {
  const {
    calendars, addCalendar, updateCalendar,
    calendarDates, addCalendarDate, removeCalendarDate, clearCalendarDates,
    editingCalendarServiceId, setEditingCalendarServiceId,
    trips, routes, selectRoute, setBottomPanelOpen, setBottomPanelTab,
    setTimetableServiceId,
    calendarDetailTab,
    selectedHolidayNames, setSelectedHolidayNames,
  } = useStore();
  const selectedHolidaySet = useMemo(() => new Set(selectedHolidayNames), [selectedHolidayNames]);
  // Inline two-step confirm for the destructive "Delete all exceptions" action,
  // mirroring the timetable's Remove-All-Trips confirm prompt. Tracking the
  // service the prompt belongs to lets us reset it during render when the user
  // switches calendars, so a pending "Delete all?" never carries over.
  const [confirmClearExceptions, setConfirmClearExceptions] = useState(false);
  const [confirmForServiceId, setConfirmForServiceId] = useState<string | null>(null);
  if (confirmClearExceptions && confirmForServiceId !== editingCalendarServiceId) {
    setConfirmClearExceptions(false);
    setConfirmForServiceId(null);
  }

  // If the editingCalendarServiceId points at a calendar that no longer
  // exists (deleted from elsewhere), drop the stale reference so we fall
  // back to the list view rather than rendering an empty detail.
  useEffect(() => {
    if (
      editingCalendarServiceId &&
      !calendars.some((c) => c.service_id === editingCalendarServiceId)
    ) {
      setEditingCalendarServiceId(null);
    }
  }, [editingCalendarServiceId, calendars, setEditingCalendarServiceId]);

  const selected = useMemo(
    () => editingCalendarServiceId
      ? calendars.find((c) => c.service_id === editingCalendarServiceId) ?? null
      : null,
    [editingCalendarServiceId, calendars],
  );
  const selectedDates = useMemo(
    () => editingCalendarServiceId
      ? calendarDates.filter((cd) => cd.service_id === editingCalendarServiceId)
      : [],
    [editingCalendarServiceId, calendarDates],
  );

  const existingDateSet = useMemo(() => {
    return new Set(selectedDates.map((cd) => cd.date));
  }, [selectedDates]);

  const handleAdd = () => {
    const id = generateId('service');
    addCalendar({
      service_id: id,
      monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
      saturday: 0, sunday: 0,
      start_date: format(new Date(), 'yyyyMMdd'),
      end_date: '20991231',
      _description: 'Weekdays',
    });
    // Drop straight into the detail view for the newly created pattern,
    // same flow as RouteList's handleAdd → setEditingRouteId.
    setEditingCalendarServiceId(id);
  };

  if (calendars.length === 0) {
    return (
      <EmptyState
        icon="📅"
        title="No service patterns"
        description="Define when your transit service operates."
        actionLabel="Add service pattern"
        onAction={handleAdd}
      />
    );
  }

  // Holidays eligible to bulk-add: checked by the user, inside this calendar's
  // date range, AND on a weekday this pattern actually runs. That last filter
  // (via getEligibleHolidayExceptions → serviceRunsOnDate) is the fix for the
  // phantom-exception bug — without it a Mon–Fri service would get a "no
  // service" exception on a Saturday/Sunday holiday, a spurious calendar_dates
  // row that trips validation. Plain const (no useMemo) — this lives after a
  // conditional early return above, and the underlying lists are tiny. Every
  // derived count/label below reads `eligibleHolidays`, so the DOW filter flows
  // through to the "(N)" total and the disabled/"all added" button states.
  const eligibleHolidays = selected
    ? getEligibleHolidayExceptions(selected, selectedHolidaySet)
    : [];

  const handleAddUSHolidays = () => {
    if (!selected) return;
    for (const holiday of eligibleHolidays) {
      if (!existingDateSet.has(holiday.gtfsDate)) {
        addCalendarDate({
          service_id: selected.service_id,
          date: holiday.gtfsDate,
          exception_type: 2,
        });
      }
    }
  };

  const eligibleAlreadyAdded = eligibleHolidays.filter((h) => existingDateSet.has(h.gtfsDate)).length;
  const eligibleToAdd = eligibleHolidays.length - eligibleAlreadyAdded;
  const allEligibleAdded = eligibleHolidays.length > 0 && eligibleToAdd === 0;

  // Holiday warning nudge
  const showHolidayWarning = selected && isWeekdayService(selected) && selectedDates.length === 0;

  // List view — shown when no service pattern is selected. Clicking a card
  // navigates into the detail view via the store (mirrors Routes), so the
  // header gets a Calendars › <name> breadcrumb instead of a stacked
  // list+form layout.
  if (!selected) {
    return (
      <div>
        <div className="flex flex-col gap-2 mb-3">
          {calendars.map((cal) => (
            <button
              key={cal.service_id}
              onClick={() => setEditingCalendarServiceId(cal.service_id)}
              className="text-left p-3 rounded-lg transition-colors bg-cream hover:bg-sand"
            >
              <div className="flex justify-between items-center mb-1">
                <span className="font-heading font-bold text-sm text-dark-brown">
                  {cal._description || cal.service_id}
                </span>
                <span className="text-[11px] text-teal font-semibold">Active</span>
              </div>
              <div className="flex gap-1">
                {['M','T','W','Th','F','Sa','Su'].map((d, i) => {
                  const days = [cal.monday, cal.tuesday, cal.wednesday, cal.thursday, cal.friday, cal.saturday, cal.sunday];
                  return (
                    <span key={d} className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center
                      ${days[i] ? 'bg-coral text-white' : 'bg-sand text-warm-gray'}`}>
                      {d}
                    </span>
                  );
                })}
              </div>
              <div className="mt-1.5 text-[11px] text-warm-gray tabular-nums">
                {formatGtfsDate(cal.start_date)} → {formatGtfsDate(cal.end_date)}
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={handleAdd}
          className="w-full flex items-center gap-1.5 px-3 py-2 border-2 border-dashed border-sand rounded-lg text-sm font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors"
        >
          + Add service pattern
        </button>
      </div>
    );
  }

  // Routes tab — list every route that has at least one trip on this service
  // pattern, with a quick jump to its timetable. Cheap: one pass over trips.
  if (selected && calendarDetailTab === 'routes') {
    const counts = new Map<string, number>();
    for (const t of trips) {
      if (t.service_id === selected.service_id) {
        counts.set(t.route_id, (counts.get(t.route_id) ?? 0) + 1);
      }
    }
    const routesForService = routes
      .filter((r) => counts.has(r.route_id))
      .sort((a, b) => (a.route_short_name || a.route_long_name || a.route_id)
        .localeCompare(b.route_short_name || b.route_long_name || b.route_id));
    return (
      <div>
        <p className="text-[11px] text-warm-gray uppercase tracking-wide font-semibold mb-2">
          Routes on this service ({routesForService.length})
        </p>
        {routesForService.length === 0 ? (
          <p className="text-xs text-warm-gray">
            No trips are assigned to this service pattern yet.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {routesForService.map((r) => {
              const n = counts.get(r.route_id) ?? 0;
              const name = r.route_short_name || r.route_long_name || 'Untitled Route';
              return (
                <div
                  key={r.route_id}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-cream transition-colors"
                >
                  <span
                    className="w-3 h-3 rounded shrink-0"
                    style={{ backgroundColor: `#${r.route_color}` }}
                    aria-hidden
                  />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="font-semibold text-sm text-dark-brown truncate">{name}</span>
                    <span className="text-[11px] text-warm-gray">{n} trip{n === 1 ? '' : 's'}</span>
                  </div>
                  <button
                    onClick={() => {
                      selectRoute(r.route_id);
                      // Sync the timetable's calendar dropdown to the calendar
                      // the user is viewing — otherwise it lands on whatever
                      // service was last selected (usually the first one),
                      // hiding the trips the user expects to see.
                      setTimetableServiceId(selected.service_id);
                      setBottomPanelOpen(true);
                      setBottomPanelTab('timetable');
                    }}
                    className="px-2.5 h-7 rounded-md border border-sand bg-white text-[12px] font-heading font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors"
                  >
                    View timetable
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Exceptions tab — service-date overrides (holidays / one-off additions).
  // Lives in its own subpanel so Details stays a compact form of operating
  // days, dates, and description. Holiday picker is a checkbox grid backed
  // by session-persisted state so the user doesn't re-check the same boxes
  // every time they jump between calendars in a session.
  if (selected && calendarDetailTab === 'exceptions') {
    const toggleHoliday = (name: string) => {
      const next = selectedHolidaySet.has(name)
        ? selectedHolidayNames.filter((n) => n !== name)
        : [...selectedHolidayNames, name];
      setSelectedHolidayNames(next);
    };
    return (
      <div className="flex flex-col gap-4">
        {/* Holiday warning nudge — same trigger as before, just relocated. */}
        {showHolidayWarning && (
          <div className="p-2.5 bg-gold-light rounded-lg border border-gold flex items-start gap-2">
            <span className="text-base leading-none mt-0.5">&#9888;</span>
            <p className="text-xs text-brown leading-snug">
              Consider adding holiday exceptions — transit typically doesn't run on major holidays.
            </p>
          </div>
        )}

        {/* Existing exception list */}
        <div>
          <div className="flex items-center justify-between mb-2 min-h-[20px]">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Service exceptions
            </label>
            {selectedDates.length > 0 && (
              confirmClearExceptions ? (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-warm-gray">Delete all {selectedDates.length}?</span>
                  <button
                    onClick={() => {
                      clearCalendarDates(selected.service_id);
                      setConfirmClearExceptions(false);
                    }}
                    className="font-bold text-red-600 hover:text-red-700 transition-colors"
                  >
                    Yes
                  </button>
                  <span className="text-warm-gray/50">·</span>
                  <button
                    onClick={() => setConfirmClearExceptions(false)}
                    className="font-semibold text-warm-gray hover:text-coral transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setConfirmForServiceId(selected.service_id);
                    setConfirmClearExceptions(true);
                  }}
                  title="Remove every exception for this service pattern"
                  className="text-[11px] font-semibold text-warm-gray hover:text-red-500 transition-colors"
                >
                  Delete all
                </button>
              )
            )}
          </div>
          {selectedDates.length === 0 ? (
            <p className="text-xs text-warm-gray italic">No exceptions set.</p>
          ) : (
            selectedDates.map((cd) => (
              <div key={cd.date} className="flex items-center gap-2 mb-1.5">
                <span className="text-sm flex-1">{formatGtfsDate(cd.date)}</span>
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded
                  ${cd.exception_type === 2 ? 'bg-red-100 text-red-700' : 'bg-teal-light text-teal'}`}>
                  {cd.exception_type === 2 ? 'No Service' : 'Added'}
                </span>
                <button
                  onClick={() => removeCalendarDate(selected.service_id, cd.date)}
                  className="text-warm-gray hover:text-red-500 text-sm"
                >
                  ×
                </button>
              </div>
            ))
          )}
          <div className="flex gap-2 mt-2">
            <input
              type="date"
              id="exception-date"
              className="flex-1 px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
            <button
              onClick={() => {
                const input = document.getElementById('exception-date') as HTMLInputElement;
                if (input.value) {
                  addCalendarDate({
                    service_id: selected.service_id,
                    date: toGtfsDate(input.value),
                    exception_type: 2,
                  });
                  input.value = '';
                }
              }}
              className="px-3 py-1.5 bg-sand rounded-lg text-xs font-semibold text-brown hover:bg-coral-light hover:text-coral transition-colors"
            >
              Add
            </button>
          </div>
        </div>

        {/* US holiday picker — checkbox per holiday, with Select all/none. */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Add US holidays
            </label>
            <div className="flex gap-2 text-[11px]">
              <button
                onClick={() => setSelectedHolidayNames(US_HOLIDAYS.map((h) => h.name))}
                className="font-semibold text-warm-gray hover:text-coral transition-colors"
              >
                Select all
              </button>
              <span className="text-warm-gray/50">·</span>
              <button
                onClick={() => setSelectedHolidayNames([])}
                className="font-semibold text-warm-gray hover:text-coral transition-colors"
              >
                None
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mb-3">
            {US_HOLIDAYS.map((h) => (
              <label
                key={h.name}
                className="flex items-center gap-2 text-xs text-dark-brown cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={selectedHolidaySet.has(h.name)}
                  onChange={() => toggleHoliday(h.name)}
                  className="accent-coral"
                />
                {h.name}
              </label>
            ))}
          </div>
          <button
            onClick={handleAddUSHolidays}
            disabled={allEligibleAdded || eligibleHolidays.length === 0}
            className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-colors
              ${allEligibleAdded || eligibleHolidays.length === 0
                ? 'bg-sand/60 text-warm-gray/60 cursor-not-allowed'
                : 'bg-gold-light text-brown border border-gold hover:bg-gold hover:text-dark-brown'
              }`}
          >
            {eligibleHolidays.length === 0
              ? 'No selected holidays fall on a service day in this range'
              : allEligibleAdded
                ? `All selected holidays added (${eligibleHolidays.length})`
                : `Add selected holidays (${eligibleToAdd} to add${eligibleAlreadyAdded > 0 ? `, ${eligibleAlreadyAdded} already added` : ''})`}
          </button>
        </div>
      </div>
    );
  }

  // Detail view — the existing edit form for the selected pattern.
  return (
    <div>
      {selected && (
        <div>
          <FormField
            label="Description"
            value={selected._description || ''}
            onChange={(v) => updateCalendar(selected.service_id, { _description: v })}
            placeholder="e.g., Weekdays"
          />

          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
            Operating Days
          </label>
          <DayToggle
            values={{
              monday: selected.monday,
              tuesday: selected.tuesday,
              wednesday: selected.wednesday,
              thursday: selected.thursday,
              friday: selected.friday,
              saturday: selected.saturday,
              sunday: selected.sunday,
            }}
            onChange={(day, value) => updateCalendar(selected.service_id, { [day]: value } as Partial<typeof selected>)}
          />

          <div className="grid grid-cols-2 gap-3 mt-3">
            <div>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">Start Date</label>
              <input
                type="date"
                value={formatGtfsDate(selected.start_date)}
                onChange={(e) => updateCalendar(selected.service_id, { start_date: toGtfsDate(e.target.value) })}
                className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">End Date</label>
              <input
                type="date"
                value={formatGtfsDate(selected.end_date)}
                onChange={(e) => updateCalendar(selected.service_id, { end_date: toGtfsDate(e.target.value) })}
                className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
              />
            </div>
          </div>

          {/* Exceptions UI (holiday warning + list + US-holiday picker) was
              relocated to its own Calendars > Exceptions subpanel so this
              tab stays a focused operating-days/date-range form. */}

          {/* Calendar Preview */}
          <CalendarPreview
            calendar={selected}
            calendarDates={selectedDates}
            onRemoveException={(date) => removeCalendarDate(selected.service_id, date)}
          />
        </div>
      )}
    </div>
  );
}
