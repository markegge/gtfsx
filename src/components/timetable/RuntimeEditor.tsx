import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { directionName } from '../../utils/constants';
import { applyPatternRunTime, currentPatternRunSecs, type PatternRef } from '../../services/runtimes';

interface Props {
  routeId: string;
  directionId: 0 | 1;
  shapeId?: string;
  serviceId: string;
  onApplied?: () => void;
  onCancel?: () => void;
}

/**
 * B2 — running-time editor. Set a pattern's scheduled end-to-end run time and
 * re-lay every trip on it, keeping each trip's start fixed (headways intact).
 * Intermediate stops are re-interpolated. Inline, matching the Generate form.
 */
export function RuntimeEditor({ routeId, directionId, shapeId, serviceId, onApplied, onCancel }: Props) {
  const route = useStore((s) => s.routes.find((r) => r.route_id === routeId));
  const trips = useStore((s) => s.trips);

  const ref: PatternRef = useMemo(() => ({ routeId, directionId, shapeId }), [routeId, directionId, shapeId]);
  const currentRun = useMemo(() => currentPatternRunSecs(ref), [ref]);
  const [runMin, setRunMin] = useState(() => (currentRun ? Math.round(currentRun / 60) : 20));
  const [scopeService, setScopeService] = useState(true); // this day-type only by default
  const [applied, setApplied] = useState<number | null>(null);

  const matching = trips.filter(
    (t) => t.route_id === routeId && t.direction_id === directionId
      && (shapeId ? t.shape_id === shapeId : true)
      && (scopeService ? t.service_id === serviceId : true),
  ).length;

  const dirLabel = route ? directionName(route, directionId) : `Direction ${directionId}`;

  const handleApply = () => {
    const n = applyPatternRunTime(scopeService ? { ...ref, serviceId } : ref, runMin * 60);
    setApplied(n);
    onApplied?.();
  };

  return (
    <div className="bg-white border border-sand rounded-xl p-3.5 shadow-sm">
      <div className="flex items-start gap-2 mb-3">
        <span className="mt-0.5 text-teal" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
          </svg>
        </span>
        <div>
          <h3 className="font-heading font-bold text-dark-brown text-sm leading-tight">Running time</h3>
          <p className="text-[11px] text-warm-gray mt-0.5">
            {dirLabel} — re-time every trip end to end; each trip keeps its start, so headways stay put.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-sm text-dark-brown">
        <span className="text-warm-gray">End to end</span>
        <input
          type="number"
          min={1}
          max={600}
          value={runMin}
          onChange={(e) => { setRunMin(Math.max(1, Number(e.target.value) || 0)); setApplied(null); }}
          className="w-16 px-2 py-1 border border-sand rounded-md bg-cream focus:border-coral focus:bg-white focus:outline-none text-sm tabular-nums"
        />
        <span className="text-warm-gray">min</span>
        {currentRun != null && (
          <span className="text-[11px] text-warm-gray/80 italic">currently {Math.round(currentRun / 60)} min</span>
        )}
      </div>

      <label className="flex items-center gap-1.5 text-xs text-warm-gray cursor-pointer mt-2">
        <input type="checkbox" checked={scopeService} onChange={(e) => { setScopeService(e.target.checked); setApplied(null); }} className="accent-coral" />
        This service day only
      </label>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs font-semibold text-teal">
          {applied != null ? `Re-timed ${applied} trip${applied === 1 ? '' : 's'}.` : `Applies to ${matching} trip${matching === 1 ? '' : 's'}`}
        </span>
        <div className="flex-1" />
        {onCancel && (
          <button onClick={onCancel} className="px-3 py-1.5 text-xs font-heading font-bold text-warm-gray hover:text-dark-brown transition-colors">Close</button>
        )}
        <button
          onClick={handleApply}
          disabled={matching === 0}
          className="px-4 py-1.5 rounded-lg font-heading font-bold text-xs bg-teal text-white hover:bg-[#0e7e75] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
