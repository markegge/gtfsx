import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { directionName } from '../../utils/constants';
import {
  generateTrips,
  validateGenerateParams,
  estimateRunSecs,
  type GenerateTripsParams,
  type TimetableGenMode,
} from '../../services/timetableGen';

interface Props {
  routeId: string;
  directionId: 0 | 1;
  shapeId?: string;
  serviceId: string;
  headsign?: string;
  /** Compact = the inline card inside the timetable; full = the larger card in
   *  the route Trips tab. Same form, slightly different chrome. */
  variant?: 'inline' | 'card';
  onGenerated?: () => void;
  onCancel?: () => void;
}

const HEADWAY_PRESETS = [10, 15, 20, 30, 60];

/**
 * B1 "Generate service" — the empty-pattern → full-timetable form.
 *
 * Designed to read like a sentence ("Run service from 06:00 to 22:00, a bus
 * every 30 min, 20 min end to end") with a live "Creates N trips" preview, so a
 * planner who's never seen it can fill it in without instructions. The run time
 * is pre-filled from the shape's length so the common case is just: pick a
 * window + headway, hit Generate.
 */
export function GenerateServiceForm({
  routeId, directionId, shapeId, serviceId, headsign, variant = 'inline', onGenerated, onCancel,
}: Props) {
  const route = useStore((s) => s.routes.find((r) => r.route_id === routeId));
  const allRouteStops = useStore((s) => s.routeStops);
  const stops = useStore((s) => s.stops);
  const shapes = useStore((s) => s.shapes);
  const calendars = useStore((s) => s.calendars);

  // The ordered stops for this exact pattern (route + direction, narrowed to the
  // shape when one is selected). Mirrors how the timetable scopes its columns.
  const routeStops = useMemo(() => {
    const matches = allRouteStops.filter(
      (rs) => rs.route_id === routeId
        && rs.direction_id === directionId
        && (shapeId ? rs.shape_id === shapeId : true),
    );
    return [...matches].sort((a, b) => a.stop_sequence - b.stop_sequence);
  }, [allRouteStops, routeId, directionId, shapeId]);

  const shape = shapeId ? shapes.find((s) => s.shape_id === shapeId) : undefined;

  const [start, setStart] = useState('06:00');
  const [end, setEnd] = useState('22:00');
  const [headwayMin, setHeadwayMin] = useState(30);
  const [runMin, setRunMin] = useState(() =>
    Math.max(1, Math.round(estimateRunSecs({ shape, routeStops, stops }) / 60)),
  );
  const [mode, setMode] = useState<TimetableGenMode>('explicit');
  const [error, setError] = useState<string | null>(null);

  const params: GenerateTripsParams = useMemo(() => ({
    routeId,
    directionId,
    shapeId,
    serviceId,
    startTime: start,
    endTime: end,
    headwaySecs: headwayMin * 60,
    runSecs: runMin * 60,
    mode,
    routeStops,
    stops,
    shape,
    headsign,
  }), [routeId, directionId, shapeId, serviceId, start, end, headwayMin, runMin, mode, routeStops, stops, shape, headsign]);

  const validation = useMemo(() => validateGenerateParams(params), [params]);

  const serviceLabel = calendars.find((c) => c.service_id === serviceId)?._description || serviceId || '—';
  const dirLabel = route ? directionName(route, directionId) : `Direction ${directionId}`;

  const handleGenerate = () => {
    if (!validation.ok) { setError(validation.error ?? 'Check the inputs.'); return; }
    const st = useStore.getState();
    const result = generateTrips({ ...params, existingTripIds: new Set(st.trips.map((t) => t.trip_id)) });
    if (result.trips.length === 0) { setError('Nothing to generate — check the inputs.'); return; }
    st.setTrips([...st.trips, ...result.trips]);
    st.setStopTimes([...st.stopTimes, ...result.stopTimes]);
    result.frequencies.forEach((f) => st.addFrequency(f));
    onGenerated?.();
  };

  const preview = validation.ok
    ? (mode === 'frequency'
        ? `One reference trip + a frequency window (a bus every ${headwayMin} min)`
        : `Creates ${validation.tripCount} trip${validation.tripCount === 1 ? '' : 's'}`)
    : (validation.error ?? '');

  const padded = variant === 'card' ? 'p-4' : 'p-3.5';

  return (
    <div className={`bg-white border border-sand rounded-xl ${padded} shadow-sm`}>
      <div className="flex items-start gap-2 mb-3">
        <span className="mt-0.5 text-coral" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
          </svg>
        </span>
        <div>
          <h3 className="font-heading font-bold text-dark-brown text-sm leading-tight">Generate service</h3>
          <p className="text-[11px] text-warm-gray mt-0.5">
            {dirLabel} · {serviceLabel} — set a window and headway; we&rsquo;ll lay out the trips.
          </p>
        </div>
      </div>

      {/* Sentence-style inputs */}
      <div className="flex flex-col gap-2.5 text-sm text-dark-brown">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-warm-gray">Run from</span>
          <input
            type="time"
            value={start}
            onChange={(e) => { setStart(e.target.value); setError(null); }}
            className="px-2 py-1 border border-sand rounded-md bg-cream focus:border-coral focus:bg-white focus:outline-none font-mono text-sm tabular-nums"
          />
          <span className="text-warm-gray">to</span>
          <input
            type="time"
            value={end}
            onChange={(e) => { setEnd(e.target.value); setError(null); }}
            className="px-2 py-1 border border-sand rounded-md bg-cream focus:border-coral focus:bg-white focus:outline-none font-mono text-sm tabular-nums"
          />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-warm-gray">A bus every</span>
          <input
            type="number"
            min={1}
            max={240}
            value={headwayMin}
            onChange={(e) => { setHeadwayMin(Math.max(1, Number(e.target.value) || 0)); setError(null); }}
            className="w-16 px-2 py-1 border border-sand rounded-md bg-cream focus:border-coral focus:bg-white focus:outline-none text-sm tabular-nums"
          />
          <span className="text-warm-gray">min</span>
          <div className="flex gap-1 ml-1">
            {HEADWAY_PRESETS.map((m) => (
              <button
                key={m}
                onClick={() => { setHeadwayMin(m); setError(null); }}
                className={`px-1.5 py-0.5 rounded text-[11px] font-semibold transition-colors ${
                  headwayMin === m ? 'bg-coral text-white' : 'bg-sand text-warm-gray hover:bg-coral-light hover:text-coral'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-warm-gray">End to end</span>
          <input
            type="number"
            min={1}
            max={600}
            value={runMin}
            onChange={(e) => { setRunMin(Math.max(1, Number(e.target.value) || 0)); setError(null); }}
            className="w-16 px-2 py-1 border border-sand rounded-md bg-cream focus:border-coral focus:bg-white focus:outline-none text-sm tabular-nums"
          />
          <span className="text-warm-gray">min</span>
          <span className="text-[11px] text-warm-gray/80 italic">
            {shape ? 'estimated from the route shape — adjust if needed' : 'estimate — adjust if needed'}
          </span>
        </div>

        {/* Mode — explicit is the default; frequency is the compact alternative */}
        <div className="flex items-center gap-3 pt-0.5">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" checked={mode === 'explicit'} onChange={() => setMode('explicit')} className="accent-coral" />
            <span title="One trip per departure in stop_times — needed for vehicle blocking">Individual trips</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer text-warm-gray">
            <input type="radio" checked={mode === 'frequency'} onChange={() => setMode('frequency')} className="accent-coral" />
            <span title="One reference trip + a frequencies.txt window — a compact, headway-based feed">Frequency-based</span>
          </label>
        </div>
      </div>

      {/* Live preview + actions */}
      <div className="mt-3 flex items-center gap-2">
        <span className={`text-xs font-semibold ${validation.ok ? 'text-teal' : 'text-red-600'}`}>
          {error || preview}
        </span>
        <div className="flex-1" />
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-heading font-bold text-warm-gray hover:text-dark-brown transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          onClick={handleGenerate}
          disabled={!validation.ok}
          className="px-4 py-1.5 rounded-lg font-heading font-bold text-xs bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {mode === 'frequency' ? 'Generate' : `Generate ${validation.ok ? validation.tripCount : ''} trips`.trim()}
        </button>
      </div>
    </div>
  );
}
