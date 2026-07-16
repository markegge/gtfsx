import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { formatTimeShort, gtfsTimeToSeconds } from '../../utils/time';
import type { OrderedStop } from './useTimetableData';
import type { Trip, StopTime } from '../../types/gtfs';
import { expandFrequencyTrip, type FrequencyWindow, type VirtualTrip } from '../../services/frequencyExpansion';
import { ActionCell, ColResizer, ColumnMenu, HeadwayToggle, RowMenu, TimeCell, TripCell } from './timetableGridParts';
import {
  computeRowErrors, actColWidth, defaultColWidth,
  COL_MIN, COL_MAX, TRIP_COL_MIN, TRIP_COL_DEFAULT,
  type RowActionStyle,
} from './timetableGridHelpers';

type CommitField = 'both' | 'arrival_time' | 'departure_time';

interface PaneProps {
  orderedStops: OrderedStop[];
  routeTrips: Trip[];
  allTripIds: string[];
  timepointStopIds: Set<string>;
  continuousOverrides: Map<string, { pickup?: 0 | 1 | 2 | 3; dropOff?: 0 | 1 | 2 | 3 }>;
  findStopTime: (tripId: string, seq: number) => StopTime | undefined;
  /** frequencies.txt windows per template trip_id in scope — drives the
   *  read-only frequency build-out rows (item #8). */
  frequenciesByTrip: Map<string, FrequencyWindow[]>;
  arrDepStops: string[];
  rowActions: RowActionStyle;
  showHeadways: boolean;
  /** Column ▾ config menu + headway toggle only render in the main pane. */
  showColumnMenu: boolean;
  showContinuous: boolean;
  scrollRef?: RefObject<HTMLDivElement | null>;
  onCell: (tripId: string, seq: number, stopId: string, field: CommitField, normalized: string) => void;
  onSkip: (tripId: string, seq: number) => void;
  onRestore: (tripId: string, seq: number, stopId: string) => void;
  onRename: (tripId: string, newId: string) => void;
  onRowAction: (action: string, tripId: string) => void;
  onAddTrip: () => void;
  onToggleRowActions: () => void;
  onToggleHeadways: () => void;
  onTimepoint: (stopId: string, seq: number, on: boolean) => void;
  onArrDep: (stopId: string, on: boolean) => void;
  onContinuous: (stopId: string, value: 'default' | 'none' | 'phone') => void;
}

/** One timetable pane — the spreadsheet grid: sticky Trip column, sticky actions
 *  column, optional pinned first-timepoint column, content-based drag-resizable
 *  columns, hover crosshair, the +Add trip row, and the row/column popovers. Pure
 *  presentation over the derived data + callbacks handed down by the orchestrator. */
export function TimetableGridPane(props: PaneProps) {
  const {
    orderedStops, routeTrips, allTripIds, timepointStopIds, continuousOverrides, findStopTime,
    frequenciesByTrip, arrDepStops, rowActions, showHeadways, showColumnMenu, showContinuous, scrollRef,
    onCell, onSkip, onRestore, onRename, onRowAction, onAddTrip, onToggleRowActions, onToggleHeadways,
    onTimepoint, onArrDep, onContinuous,
  } = props;

  const arrDepSet = useMemo(() => new Set(arrDepStops), [arrDepStops]);
  const [menu, setMenu] = useState<{ tripId: string; rect: DOMRect } | null>(null);
  const [colMenu, setColMenu] = useState<{ stopId: string; seq: number; rect: DOMRect } | null>(null);
  const [colW, setColW] = useState<Record<string, number>>({});
  const [tripW, setTripW] = useState(TRIP_COL_DEFAULT);
  const [hoverSi, setHoverSi] = useState<number | null>(null);
  const dragBase = useRef<Record<string, number>>({});

  const stopsSig = orderedStops.map((s) => s.uid).join('|');
  useEffect(() => { setColW({}); }, [stopsSig]);

  const widthOf = (col: OrderedStop) =>
    colW[col.uid] ?? defaultColWidth(col.stop.stop_name, timepointStopIds.has(col.stop.stop_id), arrDepSet.has(col.stop.stop_id));

  const resize = (col: OrderedStop) => (dx: number | null) => {
    if (dx === null) { delete dragBase.current[col.uid]; return; }
    if (dragBase.current[col.uid] === undefined) dragBase.current[col.uid] = widthOf(col);
    setColW((c) => ({ ...c, [col.uid]: Math.max(COL_MIN, Math.min(COL_MAX, dragBase.current[col.uid] + dx)) }));
  };
  const resizeTrip = (dx: number | null) => {
    if (dx === null) { delete dragBase.current.__trip; return; }
    if (dragBase.current.__trip === undefined) dragBase.current.__trip = tripW;
    // No hard cap (owner request) — but keep the Trip column within the pane so
    // the sticky actions/pinned columns don't get pushed off-screen (a Trip
    // column wider than the pane would put their sticky `left` past the viewport).
    const paneW = scrollRef?.current?.clientWidth ?? 1200;
    const ceiling = Math.max(TRIP_COL_MIN + 120, paneW - actColWidth(rowActions) - 60);
    setTripW(Math.max(TRIP_COL_MIN, Math.min(ceiling, dragBase.current.__trip + dx)));
  };

  const actW = actColWidth(rowActions);
  const pinFirst = orderedStops.length > 0 && timepointStopIds.has(orderedStops[0].stop.stop_id);
  const pinLeft = tripW + actW;
  const totalW = tripW + actW + orderedStops.reduce((sum, c) => sum + widthOf(c), 0);

  // Headway hints: interval since previous trip; flag intervals ≠ the modal one.
  const starts = useMemo(() => routeTrips.map((tr) => {
    for (const col of orderedStops) {
      const st = findStopTime(tr.trip_id, col.seq);
      const t = st?.departure_time || st?.arrival_time;
      if (t) return Math.round(gtfsTimeToSeconds(t) / 60);
    }
    return null;
  }), [routeTrips, orderedStops, findStopTime]);
  const deltas = starts.map((v, i) => (i > 0 && v != null && starts[i - 1] != null ? v - (starts[i - 1] as number) : null));
  const hwCommon = useMemo(() => {
    const freq: Record<number, number> = {};
    deltas.forEach((d) => { if (d != null) freq[d] = (freq[d] || 0) + 1; });
    const entries = Object.entries(freq);
    return entries.length ? Number(entries.sort((a, b) => b[1] - a[1])[0][0]) : null;
  }, [deltas]);

  const dupIds = useMemo(() => {
    const seen = new Set<string>(), dup = new Set<string>();
    for (const id of allTripIds) { if (seen.has(id)) dup.add(id); seen.add(id); }
    return dup;
  }, [allTripIds]);
  const deltaByTripId = new Map(routeTrips.map((t, i) => [t.trip_id, deltas[i]]));

  // Rows = the real trips PLUS the read-only build-out of any frequency-based
  // template trips (item #8), interleaved chronologically so the grid reads like
  // actual service. Projections re-derive here whenever the template's times
  // change; they never enter the store.
  const mergedRows = useMemo(() => {
    const firstDep = (tripId: string) => {
      for (const col of orderedStops) {
        const st = findStopTime(tripId, col.seq);
        const t = st?.departure_time || st?.arrival_time;
        if (t) return gtfsTimeToSeconds(t);
      }
      return Number.MAX_SAFE_INTEGER;
    };
    const rows: ({ kind: 'real'; trip: Trip; startSec: number } | { kind: 'virtual'; v: VirtualTrip; startSec: number })[] =
      routeTrips.map((trip) => ({ kind: 'real', trip, startSec: firstDep(trip.trip_id) }));
    if (frequenciesByTrip.size > 0) {
      for (const trip of routeTrips) {
        const windows = frequenciesByTrip.get(trip.trip_id);
        if (!windows || windows.length === 0) continue;
        const sts = orderedStops.map((c) => findStopTime(trip.trip_id, c.seq)).filter((x): x is StopTime => !!x);
        for (const v of expandFrequencyTrip(trip.trip_id, sts, windows)) rows.push({ kind: 'virtual', v, startSec: v.departureSec });
      }
    }
    return rows.sort((a, b) => a.startSec - b.startSec);
  }, [routeTrips, frequenciesByTrip, orderedStops, findStopTime]);

  const canApplyAll = routeTrips.length > 1;
  const canEstimate = orderedStops.length >= 2;

  return (
    <div className="flex-1 min-h-0 overflow-auto" ref={scrollRef ?? undefined}>
      <table
        className="border-separate border-spacing-0 table-fixed text-[13px]"
        style={{ width: totalW }}
        onMouseLeave={() => setHoverSi(null)}
      >
        <colgroup>
          <col style={{ width: tripW }} />
          <col style={{ width: actW }} />
          {orderedStops.map((c) => <col key={c.uid} style={{ width: widthOf(c) }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-[5] bg-white border-b-2 border-sand border-r border-sand px-2 py-2 text-left align-middle overflow-visible" style={{ width: tripW }}>
              <span className="relative inline-flex items-center gap-1.5 font-heading font-bold text-[11.5px] text-brown">
                Trip
                <HeadwayToggle on={showHeadways} onToggle={onToggleHeadways} />
              </span>
              <ColResizer onResize={resizeTrip} />
            </th>
            <th
              className="sticky top-0 z-[5] bg-white border-b-2 border-sand border-r-2 border-r-sand text-center align-middle"
              style={{ left: tripW }}
              aria-label="Trip actions"
            >
              {rowActions === 'strip' ? (
                <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wide text-warm-gray">
                  Actions
                  <button type="button" onClick={onToggleRowActions} title="Collapse back to the compact menu" aria-label="Collapse actions" className="w-[18px] h-[18px] flex items-center justify-center rounded border border-sand bg-white text-warm-gray hover:border-coral hover:text-[#d4603a] hover:bg-coral-light">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 6l-6 6 6 6M11 6l-6 6 6 6" /></svg>
                  </button>
                </span>
              ) : rowActions === 'menu' ? (
                <button type="button" onClick={onToggleRowActions} title="Expand into an always-visible icon strip — handy when repeating the same action" aria-label="Expand actions" className="w-[18px] h-[18px] flex items-center justify-center rounded border border-sand bg-white text-warm-gray hover:border-coral hover:text-[#d4603a] hover:bg-coral-light">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 6l6 6-6 6M13 6l6 6-6 6" /></svg>
                </button>
              ) : null}
            </th>
            {orderedStops.map((c, si) => {
              const isTp = timepointStopIds.has(c.stop.stop_id);
              const ov = continuousOverrides.get(c.stop.stop_id);
              const flagged = !!ov && (ov.pickup !== undefined || ov.dropOff !== undefined);
              const hl = hoverSi === si;
              const pin = pinFirst && si === 0;
              const bg = isTp ? (hl ? 'bg-[#FBDDCB]' : 'bg-coral-light') : (hl ? 'bg-[#F3E4CF]' : 'bg-white');
              return (
                <th
                  key={c.uid}
                  title={c.stop.stop_name}
                  className={`sticky top-0 border-b-2 border-sand border-r border-r-sand/60 px-2 py-2 text-left font-heading font-bold text-[11.5px] whitespace-nowrap ${bg} ${isTp ? 'text-[#d4603a]' : 'text-brown'} ${pin ? 'z-[5] border-r-2 border-r-sand' : 'z-[3]'}`}
                  style={pin ? { left: pinLeft } : undefined}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    {isTp && <span className="text-[8px] align-super mr-0.5" title="Timepoint — published time">◆</span>}
                    <span className="flex-1 min-w-0 overflow-hidden text-ellipsis">{c.stop.stop_name}</span>
                    {flagged && <span className="text-[10px] text-amber-700 ml-0.5" title="Continuous pickup/drop-off override active">⚑</span>}
                    {showColumnMenu && (
                      <button
                        type="button"
                        data-colmenu-trigger
                        title="Column controls — timepoint, arrival/departure, pickup/drop-off"
                        aria-label="Column controls"
                        onClick={(e) => setColMenu(colMenu?.stopId === c.stop.stop_id && colMenu.seq === c.seq ? null : { stopId: c.stop.stop_id, seq: c.seq, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                        className="shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded border border-sand bg-white text-warm-gray text-[10px] opacity-55 hover:opacity-100 hover:border-coral hover:text-[#d4603a] hover:bg-coral-light"
                      >
                        ▾
                      </button>
                    )}
                  </div>
                  <ColResizer onResize={resize(c)} />
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {mergedRows.map((row, ti) => {
            if (row.kind === 'virtual') {
              const bySeq = new Map(row.v.stopTimes.map((s) => [s.stop_sequence, s]));
              const tip = `Derived from the ${row.v.templateTripId} frequency template — every ${Math.round(row.v.headwaySecs / 60)}m${row.v.exactTimes === 0 ? ' (approximate)' : ''}. Edit the template to reshape it.`;
              return (
                <tr key={row.v.key} data-ti={ti} title={tip}>
                  <th scope="row" className="sticky left-0 z-[2] bg-[#FBF6EF] border-r border-sand border-b border-[#F5F0EB] px-2 whitespace-nowrap overflow-hidden text-left" style={{ width: tripW, maxWidth: tripW }}>
                    <span className="inline-flex items-center gap-1 text-[11px] italic text-warm-gray/70">
                      <span aria-hidden="true">↳</span>{row.v.exactTimes === 0 ? '≈' : ''} freq
                    </span>
                  </th>
                  <td className="sticky z-[2] bg-[#FBF6EF] border-r-2 border-r-sand border-b border-[#F5F0EB] p-0 text-center" style={{ left: tripW }}>
                    <span className="text-warm-gray/30 text-[11px]" aria-hidden="true">·</span>
                  </td>
                  {orderedStops.map((col, si) => {
                    const vst = bySeq.get(col.seq);
                    const arrDep = arrDepSet.has(col.stop.stop_id);
                    const a = vst?.arrival_time || '';
                    const d = vst?.departure_time || '';
                    const text = !vst ? '–' : arrDep && a !== d ? `${formatTimeShort(a)} / ${formatTimeShort(d)}` : formatTimeShort(a || d || '');
                    const isTp = timepointStopIds.has(col.stop.stop_id);
                    const pin = pinFirst && si === 0;
                    const bg = isTp ? 'bg-[#FCF4EC]' : 'bg-[#FBF6EF]';
                    return (
                      <td
                        key={col.uid}
                        className={`h-9 px-2 border-b border-[#F5F0EB] font-mono text-[13px] tabular-nums ${!vst ? 'text-warm-gray/30' : 'text-warm-gray/60'} ${bg} ${pin ? 'sticky z-[2] border-r-2 border-r-sand' : ''}`}
                        style={pin ? { left: pinLeft } : undefined}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              );
            }
            const trip = row.trip;
            const rowTimes = orderedStops.map((col) => {
              const st = findStopTime(trip.trip_id, col.seq);
              if (!st) return null;
              return st.arrival_time || st.departure_time || '';
            });
            const errors = computeRowErrors(rowTimes);
            const delta = deltaByTripId.get(trip.trip_id) ?? null;
            return (
              <tr key={trip.trip_id} data-ti={ti}>
                <TripCell
                  tripId={trip.trip_id}
                  isDuplicate={dupIds.has(trip.trip_id)}
                  width={tripW}
                  headway={showHeadways && delta != null ? `${delta > 0 ? '+' : ''}${delta}m` : null}
                  irregular={hwCommon != null && delta != null && delta !== hwCommon}
                  onRename={(id) => onRename(trip.trip_id, id)}
                />
                <ActionCell
                  mode={rowActions}
                  open={menu?.tripId === trip.trip_id}
                  stickyLeft={tripW}
                  canApplyAll={canApplyAll}
                  canEstimate={canEstimate}
                  onMenu={(rect) => setMenu(menu?.tripId === trip.trip_id ? null : { tripId: trip.trip_id, rect })}
                  onAct={(a) => onRowAction(a, trip.trip_id)}
                />
                {orderedStops.map((col, si) => {
                  const st = findStopTime(trip.trip_id, col.seq);
                  const arrDep = arrDepSet.has(col.stop.stop_id);
                  let value: string | null;
                  if (!st) value = null;
                  else if (arrDep) {
                    const a = st.arrival_time || '';
                    const d = st.departure_time || '';
                    value = a === d ? a : `${a}/${d}`;
                  } else {
                    value = st.arrival_time || st.departure_time || '';
                  }
                  return (
                    <TimeCell
                      key={col.uid}
                      value={value}
                      arrDep={arrDep}
                      isTimepoint={timepointStopIds.has(col.stop.stop_id)}
                      pinned={pinFirst && si === 0}
                      pinnedLeft={pinLeft}
                      highlighted={hoverSi === si}
                      timeError={errors[si]}
                      ti={ti}
                      si={si}
                      totalStops={orderedStops.length}
                      onHover={() => { if (hoverSi !== si) setHoverSi(si); }}
                      onCommit={(v) => onCell(trip.trip_id, col.seq, col.stop.stop_id, 'both', v)}
                      onCommitArr={(v) => onCell(trip.trip_id, col.seq, col.stop.stop_id, 'arrival_time', v)}
                      onCommitDep={(v) => onCell(trip.trip_id, col.seq, col.stop.stop_id, 'departure_time', v)}
                      onSkip={() => onSkip(trip.trip_id, col.seq)}
                      onRestore={() => onRestore(trip.trip_id, col.seq, col.stop.stop_id)}
                    />
                  );
                })}
              </tr>
            );
          })}
          <tr>
            <th className="sticky left-0 z-[2] bg-white px-2.5 py-1.5 text-left" style={{ width: tripW }} colSpan={2} scope="row">
              <button
                type="button"
                onClick={onAddTrip}
                title="Add a blank trip — every current stop, times to fill in"
                className="font-heading font-bold text-[12.5px] text-[#d4603a] border-[1.5px] border-dashed border-coral/50 rounded-md px-3 py-1.5 whitespace-nowrap hover:bg-coral-light hover:border-coral hover:border-solid"
              >
                + Add trip
              </button>
            </th>
            <td colSpan={orderedStops.length} className="bg-white" />
          </tr>
        </tbody>
      </table>

      {menu && (
        <RowMenu
          rect={menu.rect}
          canApplyAll={canApplyAll}
          canEstimate={canEstimate}
          onClose={() => setMenu(null)}
          onPick={(a) => { setMenu(null); onRowAction(a, menu.tripId); }}
        />
      )}
      {colMenu && (() => {
        const col = orderedStops.find((c) => c.stop.stop_id === colMenu.stopId && c.seq === colMenu.seq);
        if (!col) return null;
        const ov = continuousOverrides.get(col.stop.stop_id);
        const continuousValue: 'default' | 'none' | 'phone' =
          ov?.pickup === 2 ? 'phone' : ov?.pickup === 1 ? 'none' : 'default';
        return (
          <ColumnMenu
            stopName={col.stop.stop_name}
            rect={colMenu.rect}
            isTimepoint={timepointStopIds.has(col.stop.stop_id)}
            arrDepOn={arrDepSet.has(col.stop.stop_id)}
            showContinuous={showContinuous}
            continuousValue={continuousValue}
            onTimepoint={(on) => onTimepoint(col.stop.stop_id, col.seq, on)}
            onArrDep={(on) => onArrDep(col.stop.stop_id, on)}
            onContinuous={(v) => onContinuous(col.stop.stop_id, v)}
            onClose={() => setColMenu(null)}
          />
        );
      })()}
    </div>
  );
}
