import { useMemo, useState } from 'react';
import {
  DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useStore } from '../../store';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { computeTripSpans, findBlockOverlaps, buildBlocks, classifyBlockScope } from '../../services/blockBuilder';
import { calculateBlockCost, calculateSystemPeakVehicles } from '../../services/costEstimation';
import { secondsToGtfsTime, formatTimeShort } from '../../utils/time';
import { EmptyState } from '../ui/EmptyState';
import { Banner } from '../ui/Banner';

const PX_PER_HOUR = 64;
const UNASSIGNED = '__unassigned__';

function hhmm(sec: number): string {
  return formatTimeShort(secondsToGtfsTime(Math.round(sec)));
}
function routeColor(hex?: string): string {
  if (!hex) return '#5B8DEF';
  return hex.startsWith('#') ? hex : `#${hex}`;
}
function readableText(hex: string): string {
  const c = hex.replace('#', '');
  if (c.length < 6) return '#1a1a1a';
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1a1a1a' : '#ffffff';
}

interface BarInfo {
  tripId: string;
  routeId: string;
  label: string;
  color: string;
  startSec: number;
  endSec: number;
  overlap: boolean;
  /** Trip direction (0/1) — shown as a → / ← arrow so an out-and-back block is
   *  readable (both legs are the same route color/label otherwise). */
  directionId?: 0 | 1;
  headsign?: string;
}

/** A draggable trip bar positioned on the time track. */
function TripBar({ bar, axisStart, onClick }: { bar: BarInfo; axisStart: number; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: bar.tripId });
  const left = ((bar.startSec - axisStart) / 3600) * PX_PER_HOUR;
  const width = Math.max(14, ((bar.endSec - bar.startSec) / 3600) * PX_PER_HOUR);
  const txt = readableText(bar.color);
  // → outbound (dir 0), ← inbound (dir 1) — so both legs of an out-and-back
  // block are distinguishable (same route → same color/label otherwise).
  const arrow = bar.directionId === 0 ? '→' : bar.directionId === 1 ? '←' : '';
  const dirNote = bar.headsign
    ? ` · ${bar.headsign}`
    : bar.directionId != null
      ? ` · dir ${bar.directionId}`
      : '';
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={onClick}
      title={`${bar.label}${dirNote} · ${hhmm(bar.startSec)}–${hhmm(bar.endSec)}${bar.overlap ? ' · OVERLAP' : ''}`}
      className={`absolute top-1.5 h-7 rounded-md px-1.5 text-[10px] font-bold flex items-center gap-0.5 overflow-hidden whitespace-nowrap shadow-sm ${
        bar.overlap ? 'ring-2 ring-red-500' : ''
      } ${isDragging ? 'opacity-80 z-50 cursor-grabbing' : 'cursor-grab'}`}
      style={{
        left, width,
        background: bar.color, color: txt,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}
    >
      {arrow && <span className="opacity-90 shrink-0" aria-hidden>{arrow}</span>}
      <span className="overflow-hidden text-ellipsis">{bar.label}</span>
    </button>
  );
}

/** A block row that accepts dropped trip bars. */
function BlockRow({
  id, label, children, leftCells, trackWidth,
}: {
  id: string; label: string; leftCells: React.ReactNode; children: React.ReactNode; trackWidth: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div className="flex border-b border-sand min-h-[40px]">
      {leftCells}
      <div
        ref={setNodeRef}
        className={`relative shrink-0 ${isOver ? 'bg-coral/10' : id === UNASSIGNED ? 'bg-amber-50/40' : ''}`}
        style={{ width: trackWidth }}
        aria-label={`Block ${label} timeline`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * B3 — vehicle-blocking Gantt (the bottom-rail "Blocks" tab).
 *
 * Vehicle-row × time-axis view: each row is a block (the trips one vehicle
 * runs), trip bars coloured by route, layover gaps between them, with a cost
 * header. Drag a trip bar onto another row to reassign its block_id; "Quick
 * Block" auto-chains feasible trips (a transparent greedy heuristic, fully
 * editable); "Unblock" clears the day. Overlaps (a vehicle in two places at
 * once) are flagged red. No optimiser.
 */
export function BlockGantt() {
  const trips = useStore((s) => s.trips);
  const stopTimes = useStore((s) => s.stopTimes);
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const calendars = useStore((s) => s.calendars);
  const frequencies = useStore((s) => s.frequencies);
  const updateTrip = useStore((s) => s.updateTrip);
  useStopTimesIndex(); // keep the shared index warm

  const [serviceId, setServiceId] = useState<string>(() => calendars[0]?.service_id ?? '');
  const [interline, setInterline] = useState(false);
  const [costLayover, setCostLayover] = useState(true);
  const [costDeadhead, setCostDeadhead] = useState(true);
  const [reassign, setReassign] = useState<string | null>(null); // trip_id whose menu is open
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const activeService = serviceId || calendars[0]?.service_id || '';
  const dayTrips = useMemo(
    () => trips.filter((t) => t.service_id === activeService),
    [trips, activeService],
  );
  // Frequency-based trips can't be blocked (one template stands in for a whole
  // day of departures), so the Gantt operates on the FIXED trips only and gates
  // on how the scope splits. The cost/peak-vehicle header stays on the full
  // dayTrips set (unchanged).
  const freqTripIds = useMemo(() => new Set(frequencies.map((f) => f.trip_id)), [frequencies]);
  const dayFixedTrips = useMemo(() => dayTrips.filter((t) => !freqTripIds.has(t.trip_id)), [dayTrips, freqTripIds]);
  const dayFreqCount = dayTrips.length - dayFixedTrips.length;
  const scopeKind = classifyBlockScope(dayTrips.length, dayFreqCount);

  const spans = useMemo(() => computeTripSpans(dayTrips, stopTimes), [dayTrips, stopTimes]);
  const overlaps = useMemo(() => findBlockOverlaps(dayFixedTrips, stopTimes, activeService), [dayFixedTrips, stopTimes, activeService]);
  const overlapTripIds = useMemo(() => {
    const s = new Set<string>();
    for (const o of overlaps) { s.add(o.tripA); s.add(o.tripB); }
    return s;
  }, [overlaps]);

  const routeById = useMemo(() => new Map(routes.map((r) => [r.route_id, r])), [routes]);

  // Axis bounds (clamped to a sane window).
  const { axisStart, axisEnd } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const s of spans.values()) { lo = Math.min(lo, s.startSec); hi = Math.max(hi, s.endSec); }
    if (!Number.isFinite(lo)) { lo = 5 * 3600; hi = 24 * 3600; }
    return {
      axisStart: Math.max(0, Math.floor(lo / 3600) * 3600),
      axisEnd: Math.ceil(hi / 3600) * 3600 + 1800,
    };
  }, [spans]);
  const trackWidth = Math.max(600, ((axisEnd - axisStart) / 3600) * PX_PER_HOUR);

  // Rows: blocks (sorted), then a holding row for unassigned trips.
  const rows = useMemo(() => {
    const groups = new Map<string, BarInfo[]>();
    for (const t of dayFixedTrips) {
      const sp = spans.get(t.trip_id);
      if (!sp) continue;
      const key = t.block_id || UNASSIGNED;
      const r = routeById.get(t.route_id);
      const color = routeColor(r?.route_color);
      const bar: BarInfo = {
        tripId: t.trip_id,
        routeId: t.route_id,
        label: r?.route_short_name || t.trip_headsign || t.trip_id,
        color,
        startSec: sp.startSec,
        endSec: sp.endSec,
        overlap: overlapTripIds.has(t.trip_id),
        directionId: t.direction_id,
        headsign: t.trip_headsign,
      };
      const g = groups.get(key);
      if (g) g.push(bar); else groups.set(key, [bar]);
    }
    const blockKeys = [...groups.keys()].filter((k) => k !== UNASSIGNED).sort();
    const ordered = blockKeys.map((k) => ({ id: k, bars: groups.get(k)!.sort((a, b) => a.startSec - b.startSec) }));
    if (groups.has(UNASSIGNED)) ordered.push({ id: UNASSIGNED, bars: groups.get(UNASSIGNED)!.sort((a, b) => a.startSec - b.startSec) });
    return ordered;
  }, [dayFixedTrips, spans, routeById, overlapTripIds]);

  const cost = useMemo(
    () => calculateBlockCost({ trips: dayTrips, stopTimes, stops, calendars, calendarDates: [] }, {
      costPerHour: 100, costLayover, costDeadhead, deadheadSpeedMph: 25,
    }),
    [dayTrips, stopTimes, stops, calendars, costLayover, costDeadhead],
  );
  const svcCost = cost.perService.find((p) => p.serviceId === activeService);
  const peakInService = useMemo(
    () => calculateSystemPeakVehicles({ trips: dayTrips, stopTimes }),
    [dayTrips, stopTimes],
  );

  // "Vehicles in service over the day" mini chart — concurrent trips per 30-min bin.
  const histogram = useMemo(() => {
    const bins = Math.max(1, Math.round((axisEnd - axisStart) / 1800));
    const counts = new Array(bins).fill(0);
    for (const s of spans.values()) {
      for (let b = 0; b < bins; b++) {
        const t = axisStart + b * 1800 + 900;
        if (t >= s.startSec && t < s.endSec) counts[b]++;
      }
    }
    const max = Math.max(1, ...counts);
    return { counts, max };
  }, [spans, axisStart, axisEnd]);

  const hourTicks = useMemo(() => {
    const ticks: number[] = [];
    for (let s = axisStart; s <= axisEnd; s += 3600) ticks.push(s);
    return ticks;
  }, [axisStart, axisEnd]);

  const blockIds = rows.map((r) => r.id).filter((id) => id !== UNASSIGNED);

  const handleQuickBlock = () => {
    const map = buildBlocks(dayFixedTrips, stopTimes, stops, { serviceId: activeService, interline, deadheadSpeedMph: 25 });
    for (const t of dayFixedTrips) {
      const b = map.get(t.trip_id);
      if (b && b !== t.block_id) updateTrip(t.trip_id, { block_id: b });
    }
  };
  const handleUnblock = () => {
    for (const t of dayFixedTrips) if (t.block_id) updateTrip(t.trip_id, { block_id: undefined });
  };
  const reassignTrip = (tripId: string, target: string) => {
    updateTrip(tripId, { block_id: target === UNASSIGNED ? undefined : target });
    setReassign(null);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const tripId = String(e.active.id);
    const over = e.over?.id;
    if (over == null) return;
    let target = String(over);
    if (target === '__newblock__') {
      // next free B-number
      let n = 1; const used = new Set(blockIds);
      while (used.has(`B${n}`)) n++;
      target = `B${n}`;
    }
    const cur = trips.find((t) => t.trip_id === tripId)?.block_id || UNASSIGNED;
    if (target !== cur) reassignTrip(tripId, target);
  };

  if (calendars.length === 0) {
    return <div className="relative flex-1 min-h-0 bg-white flex items-center justify-center text-warm-gray text-sm">Add a calendar (service day) to start blocking.</div>;
  }

  // Every trip in this service is frequency-based → nothing discrete to block.
  // Keep the service switcher so the planner can hop to a trips-based day.
  if (scopeKind === 'all-freq') {
    return (
      <div className="relative flex-1 min-h-0 bg-white flex flex-col">
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-sand">
          <select
            value={activeService}
            onChange={(e) => setServiceId(e.target.value)}
            className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
          >
            {calendars.map((c) => <option key={c.service_id} value={c.service_id}>{c._description || c.service_id}</option>)}
          </select>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon="🚌"
            title="Blocks aren't available for frequency-based schedules"
            description="This service runs on frequencies (headways) instead of fixed trips, so there are no discrete trips to assign to vehicles. Convert it to a trips-based schedule to build blocks."
          />
        </div>
      </div>
    );
  }

  const leftColsHeader = (
    <>
      <div className="w-14 shrink-0 px-2 py-1.5 text-[10px] font-bold uppercase text-warm-gray border-r border-sand">Block</div>
      <div className="w-16 shrink-0 px-2 py-1.5 text-[10px] font-bold uppercase text-warm-gray border-r border-sand text-right">Plat hrs</div>
      <div className="w-14 shrink-0 px-2 py-1.5 text-[10px] font-bold uppercase text-warm-gray border-r border-sand text-right">Out</div>
      <div className="w-14 shrink-0 px-2 py-1.5 text-[10px] font-bold uppercase text-warm-gray border-r border-sand text-right">In</div>
    </>
  );

  return (
    <div className="relative flex-1 min-h-0 bg-white flex flex-col">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-sand overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <select
          value={activeService}
          onChange={(e) => setServiceId(e.target.value)}
          className="px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral"
        >
          {calendars.map((c) => <option key={c.service_id} value={c.service_id}>{c._description || c.service_id}</option>)}
        </select>
        <button onClick={handleQuickBlock} className="px-3 py-1 rounded-md text-xs font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors whitespace-nowrap">⚡ Quick Block</button>
        <label className="flex items-center gap-1.5 text-xs text-dark-brown cursor-pointer whitespace-nowrap" title="Allow chaining trips on different routes onto one vehicle">
          <input type="checkbox" checked={interline} onChange={(e) => setInterline(e.target.checked)} className="accent-coral" /> Interline
        </label>
        <button onClick={handleUnblock} className="px-3 py-1 rounded-md text-xs font-semibold border-2 border-dashed border-sand text-warm-gray hover:border-red-400 hover:text-red-500 transition-colors whitespace-nowrap">Unblock all</button>
        <span className="flex-1" />
        {overlaps.length > 0 && (
          <span className="text-[11px] font-bold text-red-600 whitespace-nowrap">⚠ {overlaps.length} overlap{overlaps.length === 1 ? '' : 's'}</span>
        )}
      </div>

      {/* Cost header */}
      <div className="shrink-0 flex items-center gap-4 px-3 py-2 bg-cream border-b border-sand text-xs overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="whitespace-nowrap">
          <span className="text-warm-gray">Vehicles </span>
          <span className="font-heading font-bold text-dark-brown text-base">{svcCost?.vehicles ?? 0}</span>
          {svcCost && svcCost.unblockedTrips > 0 && <span className="text-amber-600"> · {svcCost.unblockedTrips} unassigned</span>}
        </div>
        <div className="whitespace-nowrap"><span className="text-warm-gray">Peak in service </span><span className="font-bold text-dark-brown">{peakInService}</span></div>
        {/* mini histogram */}
        <div className="flex items-end gap-px h-7" title="Vehicles in service over the day" aria-hidden>
          {histogram.counts.map((c, i) => (
            <div key={i} style={{ height: `${(c / histogram.max) * 100}%` }} className="w-1 bg-teal/60 rounded-sm min-h-[2px]" />
          ))}
        </div>
        <span className="flex-1" />
        {svcCost && (
          <div className="whitespace-nowrap text-right">
            <span className="text-warm-gray">Daily </span>
            <span className="font-heading font-bold text-dark-brown">${Math.round(svcCost.dailyCost).toLocaleString()}</span>
            <span className="text-warm-gray"> ({svcCost.serviceHours.toFixed(1)}h svc{costLayover ? ` + ${svcCost.layoverHours.toFixed(1)}h lay` : ''}{costDeadhead ? ` + ${svcCost.deadheadHours.toFixed(1)}h dh` : ''})</span>
            <span className="text-warm-gray"> · Annual </span>
            <span className="font-heading font-bold text-coral">${Math.round(cost.annualCost).toLocaleString()}</span>
          </div>
        )}
        <label className="flex items-center gap-1 text-[11px] cursor-pointer whitespace-nowrap"><input type="checkbox" checked={costLayover} onChange={(e) => setCostLayover(e.target.checked)} className="accent-coral" />Cost layover</label>
        <label className="flex items-center gap-1 text-[11px] cursor-pointer whitespace-nowrap"><input type="checkbox" checked={costDeadhead} onChange={(e) => setCostDeadhead(e.target.checked)} className="accent-coral" />Cost deadhead</label>
      </div>

      {/* Some fixed trips, some frequency templates → block the fixed ones and
          say why the frequency trips aren't on the board. */}
      {scopeKind === 'mixed' && (
        <Banner variant="warning" icon="⚠">
          {dayFreqCount} frequency-based trip{dayFreqCount === 1 ? '' : 's'} {dayFreqCount === 1 ? 'is' : 'are'} excluded from blocking — convert {dayFreqCount === 1 ? 'it' : 'them'} to a trips-based schedule to include {dayFreqCount === 1 ? 'it' : 'them'}.
        </Banner>
      )}

      {/* Gantt grid */}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-auto min-h-0">
          <div className="min-w-max">
            {/* Time axis header */}
            <div className="flex border-b border-sand sticky top-0 bg-white z-10">
              {leftColsHeader}
              <div className="relative shrink-0 h-7" style={{ width: trackWidth }}>
                {hourTicks.map((s) => (
                  <div key={s} className="absolute top-0 h-full border-l border-sand/60 text-[9px] text-warm-gray pl-1" style={{ left: ((s - axisStart) / 3600) * PX_PER_HOUR }}>
                    {hhmm(s)}
                  </div>
                ))}
              </div>
            </div>

            {/* Block rows */}
            {rows.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-warm-gray">
                No trips on this service day yet. Generate or add trips, then Quick Block them onto vehicles.
              </div>
            )}
            {rows.map((row) => {
              const first = row.bars[0];
              const last = row.bars[row.bars.length - 1];
              const platHrs = first && last ? ((last.endSec - first.startSec) / 3600).toFixed(1) : '—';
              const isHolding = row.id === UNASSIGNED;
              const leftCells = (
                <>
                  <div className={`w-14 shrink-0 px-2 py-1.5 text-xs font-mono border-r border-sand flex items-center ${isHolding ? 'text-amber-700 italic' : 'text-dark-brown font-bold'}`}>{isHolding ? 'Hold' : row.id}</div>
                  <div className="w-16 shrink-0 px-2 py-1.5 text-[11px] text-warm-gray border-r border-sand text-right tabular-nums flex items-center justify-end">{isHolding ? '—' : platHrs}</div>
                  <div className="w-14 shrink-0 px-2 py-1.5 text-[11px] text-warm-gray border-r border-sand text-right tabular-nums flex items-center justify-end">{first ? hhmm(first.startSec) : '—'}</div>
                  <div className="w-14 shrink-0 px-2 py-1.5 text-[11px] text-warm-gray border-r border-sand text-right tabular-nums flex items-center justify-end">{last ? hhmm(last.endSec) : '—'}</div>
                </>
              );
              return (
                <BlockRow key={row.id} id={row.id} label={isHolding ? 'Hold' : row.id} leftCells={leftCells} trackWidth={trackWidth}>
                  {/* layover/deadhead connectors between consecutive bars in a block */}
                  {!isHolding && row.bars.slice(1).map((bar, i) => {
                    const prev = row.bars[i];
                    const gapL = ((prev.endSec - axisStart) / 3600) * PX_PER_HOUR;
                    const gapW = ((bar.startSec - prev.endSec) / 3600) * PX_PER_HOUR;
                    if (gapW <= 1) return null;
                    const mins = Math.round((bar.startSec - prev.endSec) / 60);
                    const deadhead = prev.routeId !== bar.routeId || gapW > PX_PER_HOUR; // visual hint
                    return (
                      <div key={`gap-${i}`} className="absolute top-3 h-3.5 flex items-center" style={{ left: gapL, width: gapW }}>
                        <div className={`w-full ${deadhead ? 'border-t-2 border-dotted border-warm-gray/60' : 'border-t border-sand'}`} />
                        {gapW > 26 && <span className="absolute left-1/2 -translate-x-1/2 -top-0.5 text-[8px] text-warm-gray bg-white/80 px-0.5 rounded">{mins}′</span>}
                      </div>
                    );
                  })}
                  {row.bars.map((bar) => (
                    <TripBar key={bar.tripId} bar={bar} axisStart={axisStart} onClick={() => setReassign(reassign === bar.tripId ? null : bar.tripId)} />
                  ))}
                </BlockRow>
              );
            })}

            {/* Drop target for a new block */}
            {rows.length > 0 && <NewBlockDrop trackWidth={trackWidth} />}
          </div>
        </div>
      </DndContext>

      {/* Reassign popover */}
      {reassign && (
        <div className="absolute inset-0 z-40" onClick={() => setReassign(null)}>
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white border border-sand rounded-xl shadow-xl p-3 w-64"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs font-bold text-dark-brown mb-2">Move trip to vehicle</div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {blockIds.map((b) => (
                <button key={b} onClick={() => reassignTrip(reassign, b)} className="px-2 py-1 rounded-md bg-sand text-xs font-mono font-bold text-dark-brown hover:bg-coral hover:text-white transition-colors">{b}</button>
              ))}
              <button onClick={() => { let n = 1; const used = new Set(blockIds); while (used.has(`B${n}`)) n++; reassignTrip(reassign, `B${n}`); }} className="px-2 py-1 rounded-md bg-teal/15 text-xs font-bold text-teal hover:bg-teal hover:text-white transition-colors">＋ New</button>
            </div>
            <button onClick={() => reassignTrip(reassign, UNASSIGNED)} className="w-full px-2 py-1 rounded-md text-xs text-warm-gray hover:bg-cream transition-colors text-left">Unassign (hold)</button>
            <p className="text-[10px] text-warm-gray/70 mt-2">Tip: you can also drag a trip bar onto another row.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function NewBlockDrop({ trackWidth }: { trackWidth: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: '__newblock__' });
  return (
    <div className="flex border-b border-sand">
      <div className="w-[218px] shrink-0 px-2 py-2 text-[11px] text-teal font-semibold border-r border-sand">＋ Drop here for a new vehicle</div>
      <div ref={setNodeRef} className={`shrink-0 h-9 ${isOver ? 'bg-teal/10' : ''}`} style={{ width: trackWidth }} />
    </div>
  );
}
