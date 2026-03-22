import { useState, useMemo } from 'react';
import type { Calendar, CalendarDate } from '../../types/gtfs';

interface CalendarPreviewProps {
  calendar: Calendar;
  calendarDates: CalendarDate[];
  onRemoveException: (date: string) => void;
}

function gtfsDateToDate(d: string): Date {
  return new Date(
    parseInt(d.slice(0, 4)),
    parseInt(d.slice(4, 6)) - 1,
    parseInt(d.slice(6, 8))
  );
}

function dateToGtfs(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

const DAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarPreview({ calendar, calendarDates, onRemoveException }: CalendarPreviewProps) {
  const startDate = gtfsDateToDate(calendar.start_date);
  const [viewYear, setViewYear] = useState(startDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(startDate.getMonth());
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const exceptionMap = useMemo(() => {
    const map = new Map<string, CalendarDate>();
    for (const cd of calendarDates) {
      map.set(cd.date, cd);
    }
    return map;
  }, [calendarDates]);

  const serviceStart = gtfsDateToDate(calendar.start_date);
  const serviceEnd = gtfsDateToDate(calendar.end_date);

  const dayServiceFlags = [
    calendar.monday,
    calendar.tuesday,
    calendar.wednesday,
    calendar.thursday,
    calendar.friday,
    calendar.saturday,
    calendar.sunday,
  ];

  // Build the grid for the month
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDayOfWeek = (() => {
    const d = new Date(viewYear, viewMonth, 1).getDay();
    // Convert Sunday=0 to Monday-based: Mon=0, Tue=1, ..., Sun=6
    return d === 0 ? 6 : d - 1;
  })();

  const cells: Array<{ day: number | null; gtfsDate: string }> = [];
  for (let i = 0; i < firstDayOfWeek; i++) {
    cells.push({ day: null, gtfsDate: '' });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(viewYear, viewMonth, d);
    cells.push({ day: d, gtfsDate: dateToGtfs(date) });
  }

  function getDayColor(day: number, gtfsDate: string): string {
    const date = new Date(viewYear, viewMonth, day);

    // Outside service range
    if (date < serviceStart || date > serviceEnd) {
      return 'bg-sand/50 text-warm-gray/50';
    }

    // Check exceptions first
    const exception = exceptionMap.get(gtfsDate);
    if (exception) {
      if (exception.exception_type === 2) {
        return 'bg-gold-light text-brown border-2 border-gold';
      }
      // exception_type 1 = service added
      return 'bg-teal-light text-teal border-2 border-teal/30';
    }

    // Regular service based on day of week
    const jsDay = date.getDay();
    const mondayBased = jsDay === 0 ? 6 : jsDay - 1;
    const hasService = dayServiceFlags[mondayBased];

    if (hasService) {
      // Weekday vs weekend coloring
      if (mondayBased >= 5) {
        return 'bg-teal-light text-teal';
      }
      return 'bg-coral-light text-coral';
    }

    return 'bg-sand/40 text-warm-gray';
  }

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const navigateMonth = (delta: number) => {
    let newMonth = viewMonth + delta;
    let newYear = viewYear;
    if (newMonth < 0) {
      newMonth = 11;
      newYear -= 1;
    } else if (newMonth > 11) {
      newMonth = 0;
      newYear += 1;
    }
    setViewMonth(newMonth);
    setViewYear(newYear);
    setConfirmRemove(null);
  };

  return (
    <div className="mt-4 p-3 bg-cream rounded-lg border-2 border-sand">
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => navigateMonth(-1)}
          className="w-7 h-7 flex items-center justify-center rounded-full bg-sand hover:bg-coral-light hover:text-coral text-warm-gray transition-colors text-sm font-bold"
        >
          &lsaquo;
        </button>
        <span className="font-heading font-bold text-sm text-dark-brown">
          {monthNames[viewMonth]} {viewYear}
        </span>
        <button
          onClick={() => navigateMonth(1)}
          className="w-7 h-7 flex items-center justify-center rounded-full bg-sand hover:bg-coral-light hover:text-coral text-warm-gray transition-colors text-sm font-bold"
        >
          &rsaquo;
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DAY_HEADERS.map((d) => (
          <div key={d} className="text-center text-[9px] font-semibold text-warm-gray uppercase">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (cell.day === null) {
            return <div key={`empty-${i}`} className="w-full aspect-square" />;
          }

          const isException = exceptionMap.has(cell.gtfsDate);
          const colorClass = getDayColor(cell.day, cell.gtfsDate);

          return (
            <button
              key={cell.gtfsDate}
              onClick={() => {
                if (isException) {
                  setConfirmRemove(confirmRemove === cell.gtfsDate ? null : cell.gtfsDate);
                }
              }}
              className={`w-full aspect-square rounded-md text-[10px] font-bold flex items-center justify-center transition-colors
                ${colorClass}
                ${isException ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
              title={isException ? 'Click to remove exception' : undefined}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      {/* Confirm remove exception */}
      {confirmRemove && (
        <div className="mt-2 p-2 bg-gold-light rounded-lg border border-gold flex items-center justify-between">
          <span className="text-xs text-brown">
            Remove exception on{' '}
            <strong>
              {confirmRemove.slice(0, 4)}-{confirmRemove.slice(4, 6)}-{confirmRemove.slice(6, 8)}
            </strong>
            ?
          </span>
          <div className="flex gap-1.5">
            <button
              onClick={() => setConfirmRemove(null)}
              className="px-2 py-0.5 text-[10px] font-semibold text-warm-gray bg-sand rounded hover:bg-warm-gray hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                onRemoveException(confirmRemove);
                setConfirmRemove(null);
              }}
              className="px-2 py-0.5 text-[10px] font-semibold text-white bg-coral rounded hover:bg-[#d4603a] transition-colors"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="mt-3 pt-2 border-t border-sand flex flex-wrap gap-x-3 gap-y-1">
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-coral-light border border-coral/30" />
          <span className="text-[9px] text-warm-gray">Weekday service</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-teal-light border border-teal/30" />
          <span className="text-[9px] text-warm-gray">Weekend service</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-gold-light border border-gold" />
          <span className="text-[9px] text-warm-gray">Exception date</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-sand/40 border border-sand" />
          <span className="text-[9px] text-warm-gray">No service</span>
        </div>
      </div>
    </div>
  );
}
