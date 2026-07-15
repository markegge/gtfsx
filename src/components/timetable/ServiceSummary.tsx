import { useMemo, useState, useCallback, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStore } from '../../store';
import { gtfsTimeToSeconds } from '../../utils/time';
import { directionName } from '../../utils/constants';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { MareyChart } from './MareyChart';

type SummaryView = 'summary' | 'marey';

interface TripDot {
  routeName: string;
  routeColor: string;
  serviceLabel: string;
  direction: string;
  timeSeconds: number;
  timeLabel: string;
  tripId: string;
}

export function ServiceSummary() {
  // View toggle is local-only — no need to persist across panel re-opens.
  const [view, setView] = useState<SummaryView>('summary');

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* View toggle — segmented control matching the app's Tailwind styling */}
      <div className="flex items-center gap-1 px-3 pt-2 shrink-0">
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-cream border border-sand">
          {(['summary', 'marey'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`text-xs font-heading font-semibold px-3 py-1 rounded transition-colors
                ${view === v
                  ? 'bg-white text-coral shadow-sm'
                  : 'text-warm-gray hover:text-dark-brown'
                }`}
            >
              {v === 'summary' ? 'Summary' : 'Marey'}
            </button>
          ))}
        </div>
      </div>

      {view === 'summary' ? <SummaryView /> : <MareyChart />}
    </div>
  );
}

function SummaryView() {
  const {
    routes, trips, calendars, routeStops,
    hiddenRouteIds,
  } = useStore();
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();

  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  const hiddenSet = useMemo(() => new Set(hiddenRouteIds), [hiddenRouteIds]);

  const activeServiceId = useMemo(() => {
    if (selectedServiceId && calendars.some((c) => c.service_id === selectedServiceId)) return selectedServiceId;
    return calendars[0]?.service_id || null;
  }, [selectedServiceId, calendars]);

  // Visible routes
  const visibleRoutes = useMemo(
    () => routes.filter((r) => !hiddenSet.has(r.route_id)),
    [routes, hiddenSet],
  );

  // Local route order for drag-and-drop reordering
  const [routeOrder, setRouteOrder] = useState<string[]>([]);

  // Sync route order when visible routes change. setState-in-effect is
  // intentional here: routeOrder is user-mutable (drag reorder) but must
  // also stay in sync with the underlying visible-routes list when routes
  // are added/removed externally. Pure derivation via useMemo would lose
  // the user's drag order.
  useEffect(() => {
    setRouteOrder((prev) => {
      const visibleIds = new Set(visibleRoutes.map((r) => r.route_id));
      const kept = prev.filter((id) => visibleIds.has(id));
      const keptSet = new Set(kept);
      const added = visibleRoutes.filter((r) => !keptSet.has(r.route_id)).map((r) => r.route_id);
      return [...kept, ...added];
    });
  }, [visibleRoutes]);

  const orderedVisibleRoutes = useMemo(
    () => routeOrder.map((id) => visibleRoutes.find((r) => r.route_id === id)).filter(Boolean) as typeof visibleRoutes,
    [routeOrder, visibleRoutes],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setRouteOrder((prev) => {
      const oldIndex = prev.indexOf(String(active.id));
      const newIndex = prev.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(oldIndex, 1);
      next.splice(newIndex, 0, moved);
      return next;
    });
  }, []);

  // Build trip dots: outbound (direction 0) start times for each visible route, filtered by service
  const { routeRows, minHour, maxHour } = useMemo(() => {
    const rows: { routeId: string; routeName: string; routeColor: string; dots: TripDot[] }[] = [];
    let earliest = 24;
    let latest = 0;

    for (const route of orderedVisibleRoutes) {
      const routeTrips = trips.filter(
        (t) => t.route_id === route.route_id && t.direction_id === 0
          && (!activeServiceId || t.service_id === activeServiceId),
      );

      const dots: TripDot[] = [];
      for (const trip of routeTrips) {
        // Find first stop time (departure) for this trip using route stop order
        const orderedRS = routeStops
          .filter((rs) => rs.route_id === route.route_id && rs.direction_id === 0)
          .sort((a, b) => a.stop_sequence - b.stop_sequence);

        const tripSTs = stopTimesByTrip.get(trip.trip_id) || [];

        let firstTime = '';
        for (const rs of orderedRS) {
          const st = tripSTs.find((s) => s.stop_id === rs.stop_id);
          if (st && (st.departure_time || st.arrival_time)) {
            firstTime = st.departure_time || st.arrival_time;
            break;
          }
        }
        // Fallback: earliest stop_time by sequence
        if (!firstTime) {
          const sts = tripSTs
            .filter((s) => s.departure_time || s.arrival_time)
            .sort((a, b) => a.stop_sequence - b.stop_sequence);
          if (sts.length > 0) firstTime = sts[0].departure_time || sts[0].arrival_time;
        }
        if (!firstTime) continue;

        const seconds = gtfsTimeToSeconds(firstTime);
        const hour = seconds / 3600;
        if (hour < earliest) earliest = hour;
        if (hour > latest) latest = hour;

        const cal = calendars.find((c) => c.service_id === trip.service_id);
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);

        dots.push({
          routeName: route.route_short_name || route.route_long_name || route.route_id,
          routeColor: route.route_color,
          serviceLabel: cal?._description || trip.service_id,
          direction: directionName(route, 0),
          timeSeconds: seconds,
          timeLabel: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          tripId: trip.trip_id,
        });
      }

      dots.sort((a, b) => a.timeSeconds - b.timeSeconds);
      rows.push({
        routeId: route.route_id,
        routeName: route.route_short_name || route.route_long_name || route.route_id,
        routeColor: route.route_color,
        dots,
      });
    }

    return {
      routeRows: rows,
      minHour: Math.floor(earliest),
      maxHour: Math.ceil(latest) + 1,
    };
  }, [orderedVisibleRoutes, trips, stopTimesByTrip, calendars, routeStops, activeServiceId]);

  const hours = useMemo(() => {
    const h: number[] = [];
    for (let i = minHour; i <= maxHour; i++) h.push(i);
    return h;
  }, [minHour, maxHour]);

  const totalSeconds = (maxHour - minHour) * 3600;

  if (visibleRoutes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-warm-gray text-sm">
        No visible routes. Show routes on the map to see the service summary.
      </div>
    );
  }

  return (
    <div className="p-3 flex flex-col min-h-0 flex-1">
      {/* Toolbar — scrollable on narrow viewports */}
      <div className="shrink-0 mb-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex items-center gap-3 min-w-max">
          <h3 className="text-xs font-heading font-bold text-dark-brown whitespace-nowrap">
            Trip Start Times by Route (Outbound)
          </h3>
          {calendars.length > 0 && (
            <select
              value={activeServiceId || ''}
              onChange={(e) => setSelectedServiceId(e.target.value)}
              className="px-2 py-1 border border-sand rounded-md text-xs bg-cream focus:outline-none focus:border-coral"
            >
              {calendars.map((cal) => (
                <option key={cal.service_id} value={cal.service_id}>
                  {cal._description || cal.service_id}
                </option>
              ))}
            </select>
          )}
          <span className="text-[11px] text-warm-gray whitespace-nowrap">
            {routeRows.reduce((sum, r) => sum + r.dots.length, 0)} trips
          </span>
        </div>
      </div>

      <div className="overflow-auto flex-1 min-h-0 pr-3">
        <div className="min-w-[600px]">
          {/* Time axis */}
          <div className="flex items-end mb-1 ml-[120px]">
            {hours.map((h) => (
              <div
                key={h}
                className="text-[10px] text-warm-gray"
                style={{ width: `${100 / hours.length}%` }}
              >
                {h > 24 ? `${h - 24}:00+` : `${h}:00`}
              </div>
            ))}
          </div>

          {/* Route rows — drag to reorder */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={routeRows.map((r) => r.routeId)} strategy={verticalListSortingStrategy}>
              {routeRows.map((row) => (
                <SortableRouteRow
                  key={row.routeId}
                  row={row}
                  hours={hours}
                  minHour={minHour}
                  totalSeconds={totalSeconds}
                />
              ))}
            </SortableContext>
          </DndContext>

          {/* Bottom axis label */}
          <div className="ml-[120px] mt-1 text-center text-[10px] text-warm-gray">
            Time of Day
          </div>
        </div>
      </div>
    </div>
  );
}

function SortableRouteRow({ row, hours, minHour, totalSeconds }: {
  row: { routeId: string; routeName: string; routeColor: string; dots: TripDot[] };
  hours: number[];
  minHour: number;
  totalSeconds: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.routeId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className={`flex items-center mb-1 ${isDragging ? 'shadow-md' : ''}`}>
      {/* Drag handle + route label */}
      <div className="w-[120px] shrink-0 flex items-center gap-1 pr-2">
        <button
          {...attributes}
          {...listeners}
          className="text-warm-gray hover:text-dark-brown cursor-grab active:cursor-grabbing text-[10px] shrink-0 w-4 text-center touch-none"
          title="Drag to reorder"
        >
          ⠿
        </button>
        <span
          className="w-3 h-3 rounded-sm shrink-0"
          style={{ backgroundColor: `#${row.routeColor}` }}
        />
        <span className="text-xs font-semibold text-dark-brown truncate">
          {row.routeName}
        </span>
      </div>

      {/* Timeline */}
      <div className="flex-1 relative h-6 bg-cream rounded border border-sand">
        {hours.map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 border-l border-sand/50"
            style={{ left: `${((h - minHour) * 3600 / totalSeconds) * 100}%` }}
          />
        ))}
        {row.dots.map((dot, i) => {
          const pct = ((dot.timeSeconds - minHour * 3600) / totalSeconds) * 100;
          return (
            <div
              key={i}
              className="absolute top-1/2 -translate-y-1/2 -ml-[5px]"
              style={{ left: `${pct}%` }}
              title={`${dot.timeLabel} — ${dot.serviceLabel} (${dot.tripId})`}
            >
              <ShapeIcon shape="circle" color={`#${dot.routeColor}`} size={10} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ShapeIcon({ shape, color, size }: { shape: string; color: string; size: number }) {
  const s = size;
  const half = s / 2;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} className="shrink-0">
      {shape === 'circle' && (
        <circle cx={half} cy={half} r={half - 0.5} fill={color} />
      )}
      {shape === 'diamond' && (
        <polygon points={`${half},0.5 ${s - 0.5},${half} ${half},${s - 0.5} 0.5,${half}`} fill={color} />
      )}
      {shape === 'square' && (
        <rect x={0.5} y={0.5} width={s - 1} height={s - 1} fill={color} />
      )}
      {shape === 'triangle' && (
        <polygon points={`${half},0.5 ${s - 0.5},${s - 0.5} 0.5,${s - 0.5}`} fill={color} />
      )}
    </svg>
  );
}
