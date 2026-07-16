import { useState } from 'react';
import { Drawer } from '../ui/Drawer';
import { formatTimeShort, gtfsTimeToSeconds, secondsToGtfsTime } from '../../utils/time';
import type { GenerateValidation, TimetableGenMode } from '../../services/timetableGen';
import { windowDepartureCount, validateFrequencyWindows, type FrequencyWindow } from '../../services/frequencyExpansion';

/** The raw inputs a Generate submission carries up to the orchestrator, which
 *  builds the full GenerateTripsParams (it owns the pattern's routeStops / stops
 *  / shape) and calls the shared `generateTrips` service. */
export interface GenerateInput {
  startTime: string;
  endTime: string;
  headwaySecs: number;
  runSecs: number;
  mode: TimetableGenMode;
}

const TIN = 'h-[30px] rounded-md border border-sand bg-white font-mono text-[12.5px] text-dark-brown px-2 text-center focus:outline-none focus:border-coral';
const TIN_TIME = `${TIN} w-[74px]`;
const TIN_NUM = `${TIN} w-[54px]`;
const HEADWAY_PRESETS = [10, 15, 20, 30, 60];
const VR = <span className="w-px h-[18px] bg-sand" aria-hidden="true" />;

/* ---------- ✨ Generate trips ---------- */
export function GenerateDrawer({
  ctx, endToEndDefault, getPreview, onApply, onCancel,
}: {
  ctx: string;
  endToEndDefault: number;
  getPreview: (input: GenerateInput) => GenerateValidation;
  onApply: (input: GenerateInput) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState('06:00');
  const [to, setTo] = useState('22:00');
  const [head, setHead] = useState(30);
  const [run, setRun] = useState(endToEndDefault);
  const [mode, setMode] = useState<TimetableGenMode>('explicit');

  const input: GenerateInput = { startTime: from, endTime: to, headwaySecs: head * 60, runSecs: run * 60, mode };
  const preview = getPreview(input);
  const count = mode === 'frequency'
    ? (preview.ok ? 'Creates 1 reference trip + a frequency window' : (preview.error ?? '—'))
    : (preview.ok ? `Creates ${preview.tripCount} trip${preview.tripCount === 1 ? '' : 's'}` : (preview.error ?? '—'));

  return (
    <Drawer
      icon="✨"
      iconClassName="bg-coral-light text-coral"
      title="Generate trips"
      sub={`${ctx} — set a window and an interval; we'll lay out the day's trips.`}
      count={count}
      applyLabel={mode === 'frequency' ? 'Generate frequency window' : `Generate ${preview.ok ? `${preview.tripCount} ` : ''}trips`}
      canApply={preview.ok}
      onApply={() => onApply(input)}
      onCancel={onCancel}
    >
      <span>Run from</span>
      <input className={TIN_TIME} value={from} onChange={(e) => setFrom(e.target.value)} />
      <span>to</span>
      <input className={TIN_TIME} value={to} onChange={(e) => setTo(e.target.value)} />
      {VR}
      <span>A bus every</span>
      <input className={TIN_NUM} type="number" min={1} value={head} onChange={(e) => setHead(Math.max(1, Number(e.target.value) || 0))} />
      <span>min</span>
      {HEADWAY_PRESETS.map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => setHead(h)}
          className={`h-6 px-2.5 rounded border font-heading font-bold text-[11.5px] ${
            head === h ? 'bg-coral border-coral text-white' : 'bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a]'
          }`}
        >
          {h}
        </button>
      ))}
      {VR}
      <span>End to end</span>
      <input className={TIN_NUM} type="number" min={1} value={run} title="Estimated from the route shape — adjust if needed" onChange={(e) => setRun(Math.max(1, Number(e.target.value) || 0))} />
      <span>min</span>
      <span className="basis-full h-0" />
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'explicit'} onChange={() => setMode('explicit')} className="accent-coral" />
        Individual trips <span className="text-warm-gray text-[11.5px]">(needed for vehicle blocking)</span>
      </label>
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'frequency'} onChange={() => setMode('frequency')} className="accent-coral" />
        Frequency-based <span className="text-warm-gray text-[11.5px]">(one trip + frequencies.txt)</span>
      </label>
    </Drawer>
  );
}

/* ---------- ⏱ Set run time ---------- */
export function RuntimeDrawer({
  ctx, currentRun, tripCount, estimateDefaults, onApply, onEstimate, onCancel,
}: {
  ctx: string;
  currentRun: number;
  tripCount: number;
  estimateDefaults: { dwellSec: number; speedFactor: number };
  onApply: (input: { runMin: number; scoped: boolean }) => void;
  /** Estimate mode — async (may hit Map Matching); resolves with a status the
   *  drawer surfaces. On success the orchestrator closes the drawer. */
  onEstimate: (input: { dwellSec: number; speedFactor: number; scoped: boolean }) => Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'runtime' | 'estimate'>('runtime');
  const [run, setRun] = useState(currentRun);
  const [scoped, setScoped] = useState(false);
  const [dwell, setDwell] = useState(estimateDefaults.dwellSec);
  const [speed, setSpeed] = useState(estimateDefaults.speedFactor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickMode = (m: 'runtime' | 'estimate') => { if (!busy) { setMode(m); setError(null); } };

  const handleApply = async () => {
    if (mode === 'runtime') { onApply({ runMin: run, scoped }); return; }
    setBusy(true);
    setError(null);
    const res = await onEstimate({ dwellSec: dwell, speedFactor: speed, scoped });
    // On success the drawer unmounts; only need to recover on failure.
    if (!res.ok) { setError(res.error ?? 'Estimate failed.'); setBusy(false); }
  };

  const trips = `${tripCount} trip${tripCount === 1 ? '' : 's'}`;
  const count = error
    ? <span className="text-red-500">{error}</span>
    : mode === 'runtime'
      ? `Current run time ${currentRun} min · re-times ${trips}`
      : `Estimates times for ${trips}`;
  const applyLabel = mode === 'runtime'
    ? `Re-time ${trips}`
    : busy ? 'Estimating…' : `Estimate ${trips}`;

  return (
    <Drawer
      icon="⏱"
      iconClassName="bg-teal-light text-teal"
      title="Set run time"
      sub={mode === 'runtime'
        ? `${ctx} — every trip keeps its own start time; headways stay intact.`
        : `${ctx} — lay times from the road network; every trip keeps its own start time.`}
      count={count}
      applyLabel={applyLabel}
      canApply={!busy && tripCount > 0 && (mode === 'runtime' ? run > 0 : true)}
      onApply={handleApply}
      onCancel={onCancel}
    >
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'runtime'} onChange={() => pickMode('runtime')} disabled={busy} className="accent-coral" />
        Set run time
      </label>
      <label className="inline-flex items-center gap-1.5 cursor-pointer">
        <input type="radio" checked={mode === 'estimate'} onChange={() => pickMode('estimate')} disabled={busy} className="accent-coral" />
        Estimate from route geometry
      </label>
      <span className="basis-full h-0" />
      {mode === 'runtime' ? (
        <>
          <span>End to end, this pattern takes</span>
          <input className={TIN_NUM} type="number" min={1} value={run} onChange={(e) => setRun(Math.max(1, Number(e.target.value) || 0))} />
          <span>min</span>
        </>
      ) : (
        <>
          <span>Dwell</span>
          <input className={TIN_NUM} type="number" min={0} value={dwell} disabled={busy} title="Seconds added at each stop for boarding/alighting" onChange={(e) => setDwell(Math.max(0, Number(e.target.value) || 0))} />
          <span>sec/stop · bus runs</span>
          <input className={TIN_NUM} type="number" min={0.1} step={0.1} value={speed} disabled={busy} title="A bus is slower than a car — driving time is multiplied by this factor" onChange={(e) => setSpeed(Math.max(0.1, Number(e.target.value) || 0.1))} />
          <span>× slower than a car</span>
        </>
      )}
      {VR}
      <label className="inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer">
        <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} disabled={busy} className="accent-coral" />
        This service day only
      </label>
    </Drawer>
  );
}

/* ---------- ↻ Repeat last trip ---------- */
export function RepeatDrawer({
  lastStart, tripCount, onApply, onCancel,
}: {
  lastStart: string; // formatted HH:MM, or '—'
  tripCount: number;
  onApply: (input: { headway: number; copies: number }) => void;
  onCancel: () => void;
}) {
  const [head, setHead] = useState(30);
  const [copies, setCopies] = useState(4);
  const lastSec = lastStart === '—' ? null : gtfsTimeToSeconds(lastStart);
  const ok = tripCount > 0 && head > 0 && copies > 0;
  const range = ok && lastSec != null
    ? `${formatTimeShort(secondsToGtfsTime(lastSec + head * 60))} → ${formatTimeShort(secondsToGtfsTime(lastSec + head * copies * 60))}`
    : '';
  return (
    <Drawer
      icon="↻"
      iconClassName="bg-gold-light text-[#b8860b]"
      title="Repeat last trip"
      sub="Add copies of the last trip, spaced at a set headway."
      count={ok ? `Adds ${copies} trip${copies === 1 ? '' : 's'}${range ? ` · ${range}` : ''}` : '—'}
      applyLabel={`Add ${copies} trip${copies === 1 ? '' : 's'}`}
      canApply={ok}
      onApply={() => onApply({ headway: head, copies })}
      onCancel={onCancel}
    >
      <span>A new trip every</span>
      <input className={TIN_NUM} type="number" min={1} value={head} onChange={(e) => setHead(Math.max(1, Number(e.target.value) || 0))} />
      <span>min,</span>
      <input className={TIN_NUM} type="number" min={1} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 0))} />
      <span>more copies, starting after the {lastStart} trip</span>
    </Drawer>
  );
}

/* ---------- ⏲ Edit frequency windows ---------- */
const DEFAULT_WINDOW: FrequencyWindow = { start_time: '06:00:00', end_time: '22:00:00', headway_secs: 1800, exact_times: 0 };
const hhmm = (s: string) => s.slice(0, 5); // HH:MM:SS → HH:MM for the input
const withSecs = (s: string) => { const t = s.trim(); return /^\d{1,2}:\d{2}$/.test(t) ? `${t}:00` : t; };

export function FrequencyDrawer({
  ctx, tripId, initialWindows, onApply, onCancel,
}: {
  ctx: string;
  tripId: string;
  initialWindows: FrequencyWindow[];
  onApply: (windows: FrequencyWindow[]) => void;
  onCancel: () => void;
}) {
  const [windows, setWindows] = useState<FrequencyWindow[]>(
    () => (initialWindows.length ? initialWindows.map((w) => ({ ...w })) : [{ ...DEFAULT_WINDOW }]),
  );
  const issues = validateFrequencyWindows(windows);
  const departures = windowDepartureCount(windows);
  const empty = windows.length === 0;

  const setW = (i: number, patch: Partial<FrequencyWindow>) =>
    setWindows((ws) => ws.map((w, k) => (k === i ? { ...w, ...patch } : w)));

  const count = empty
    ? <span className="text-amber-600 font-normal">Removes the frequency — {tripId} becomes a plain single trip.</span>
    : <>→ {departures} departure{departures === 1 ? '' : 's'}{issues.overlaps.length > 0 && <span className="text-amber-600 font-normal"> · overlapping windows</span>}</>;

  return (
    <Drawer
      icon="⏲"
      iconClassName="bg-teal-light text-teal"
      title="Edit frequency"
      sub={`${ctx} · ${tripId} — headway windows. The trip's stop times stay editable in the grid.`}
      count={count}
      applyLabel={empty ? 'Remove frequency' : 'Apply windows'}
      canApply={empty || issues.ok}
      onApply={() => onApply(windows.map((w) => ({ ...w, start_time: withSecs(w.start_time), end_time: withSecs(w.end_time) })))}
      onCancel={onCancel}
    >
      {windows.map((w, i) => {
        const err = issues.errors[i];
        const overlap = issues.overlaps.includes(i);
        const note = err.badHeadway ? 'headway must be > 0' : err.badRange ? 'end must be after start' : overlap ? 'overlaps another window' : null;
        return (
          <div key={i} className="basis-full flex items-center gap-2 flex-wrap">
            <span>Every</span>
            <input className={TIN_NUM} type="number" min={1} value={Math.max(1, Math.round(w.headway_secs / 60))}
              onChange={(e) => setW(i, { headway_secs: Math.max(1, Number(e.target.value) || 0) * 60 })} />
            <span>min from</span>
            <input className={TIN_TIME} value={hhmm(w.start_time)} onChange={(e) => setW(i, { start_time: e.target.value })} />
            <span>to</span>
            <input className={TIN_TIME} value={hhmm(w.end_time)} onChange={(e) => setW(i, { end_time: e.target.value })} />
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-[12.5px]">
              <input type="checkbox" checked={w.exact_times === 1} onChange={(e) => setW(i, { exact_times: e.target.checked ? 1 : 0 })} className="accent-coral" />
              Exact times
            </label>
            {note && <span className={`text-[11px] ${err.badHeadway || err.badRange ? 'text-red-500' : 'text-amber-600'}`}>{note}</span>}
            <button type="button" onClick={() => setWindows((ws) => ws.filter((_, k) => k !== i))} title="Remove window"
              className="ml-auto w-6 h-6 flex items-center justify-center rounded text-warm-gray hover:text-red-500 hover:bg-red-50 text-base leading-none">×</button>
          </div>
        );
      })}
      <button type="button" onClick={() => setWindows((ws) => [...ws, { ...DEFAULT_WINDOW }])}
        className="basis-full text-left text-[12.5px] font-heading font-bold text-teal hover:text-[#0d7a6f]">+ Add window</button>
    </Drawer>
  );
}
