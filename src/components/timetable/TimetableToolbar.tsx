import { useRef, useState } from 'react';
import type { Route, Shape } from '../../types/gtfs';
import { directionName } from '../../utils/constants';
import type { ShapePattern } from '../ui/shapePatterns';
import { PatternSelector } from '../ui/ShapePatternSelector';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { useDismiss, directionSegmentValue, directionSegmentAction } from './timetableGridHelpers';

export type ToolId = 'generate' | 'runtime' | 'repeat' | 'removeall';

interface ToolbarProps {
  route: Route;
  routes: Route[];
  shapes: Shape[];
  calendars: { service_id: string; _description?: string }[];
  selectedRouteId: string | null;
  activeServiceId: string | null;
  patterns: ShapePattern[];
  effectiveShapeId: string | null;
  directionId: 0 | 1;
  tripCount: number;
  oppositeOpen: boolean;
  onSelectRoute: (id: string | null) => void;
  onSelectService: (id: string) => void;
  onSelectPattern: (p: ShapePattern) => void;
  onSelectDirection: (d: 0 | 1) => void;
  onSetOpposite: (v: boolean) => void;
  onEditStops: () => void;
  onTool: (id: ToolId) => void;
}

/** Cell-semantics popover behind the "?" in the trip count — replaces the
 *  always-on legend sentence (HANDOFF §1). */
function HintPopover() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useDismiss(popRef, () => setOpen(false), '[data-hint-trigger]');
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left - 150, window.innerWidth - 356)) });
    }
    setOpen((v) => !v);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-hint-trigger
        onClick={toggle}
        title="How cells work"
        aria-label="How cells work"
        className="w-[17px] h-[17px] flex items-center justify-center rounded-full border border-sand bg-white text-warm-gray text-[10px] font-bold hover:border-coral hover:text-[#d4603a]"
      >
        ?
      </button>
      {open && (
        <div
          ref={popRef}
          className="fixed z-[70] w-[340px] max-w-[calc(100vw-24px)] p-4 bg-white border border-sand rounded-xl shadow-[0_8px_28px_rgba(61,46,34,0.18)] text-[12.5px] leading-relaxed text-brown"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="flex items-start gap-2.5">
            <code className="shrink-0 min-w-[38px] text-center font-mono text-[11px] bg-cream px-1.5 py-px rounded">07:46</code>
            <span>Type a time to set it — <b>Enter</b> or <b>Tab</b> commits.</span>
          </div>
          <div className="flex items-start gap-2.5 mt-2">
            <code className="shrink-0 min-w-[38px] text-center font-mono text-[11px] bg-cream px-1.5 py-px rounded">·</code>
            <span>Leave a served stop <b>blank</b> for &ldquo;served, time interpolated.&rdquo;</span>
          </div>
          <div className="flex items-start gap-2.5 mt-2">
            <code className="shrink-0 min-w-[38px] text-center font-mono text-[11px] bg-cream px-1.5 py-px rounded">SKIP</code>
            <span>Hover a cell and click <span className="text-red-500">×</span> to skip the stop; click the chip to restore it.</span>
          </div>
          <div className="flex items-start gap-2.5 mt-2">
            <span className="shrink-0 min-w-[38px] text-center text-coral">◆</span>
            <span>Coral columns are <b>timepoints</b> (published times).</span>
          </div>
        </div>
      )}
    </>
  );
}

/** Direction / trip-pattern control that doubles as the split-view control
 *  (HANDOFF §3): 2 patterns → segmented with a ⇄ Both option; 3+ → dropdown with
 *  an attached ⇄ toggle; 1 → static label; 0 → the shapeless direction toggle. */
function DirectionControl({
  route, shapes, patterns, effectiveShapeId, directionId, oppositeOpen,
  onSelectPattern, onSelectDirection, onSetOpposite,
}: Pick<ToolbarProps,
  'route' | 'shapes' | 'patterns' | 'effectiveShapeId' | 'directionId' | 'oppositeOpen' |
  'onSelectPattern' | 'onSelectDirection' | 'onSetOpposite'>) {
  const canOpposite = patterns.length >= 2;

  if (patterns.length >= 3) {
    return (
      <span className="inline-flex items-stretch shrink-0">
        <PatternSelector
          patterns={patterns}
          selectedShapeId={effectiveShapeId}
          route={route}
          shapes={shapes}
          onChange={onSelectPattern}
          className="appearance-none h-[30px] pl-2.5 pr-7 rounded-l-md border border-sand bg-white shadow-sm font-heading font-bold text-xs text-dark-brown cursor-pointer hover:border-coral focus:outline-none focus:border-coral max-w-[200px]"
        />
        <button
          type="button"
          onClick={() => onSetOpposite(!oppositeOpen)}
          title="Split view — compare another pattern side-by-side"
          aria-pressed={oppositeOpen}
          className={`-ml-px h-[30px] px-2.5 rounded-r-md border font-heading font-bold text-[13px] ${
            oppositeOpen ? 'bg-coral-light border-coral text-[#d4603a]' : 'bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a]'
          }`}
        >
          ⇄
        </button>
      </span>
    );
  }

  if (patterns.length === 2) {
    const selectedIdx = Math.max(0, patterns.findIndex((p) => p.shapeId === effectiveShapeId));
    const labels = patterns.map((p) => directionName(route, p.directionId));
    return (
      <Segmented
        value={directionSegmentValue(oppositeOpen, selectedIdx, patterns.length)}
        options={[...labels, '⇄ Both']}
        dividerBefore={patterns.length}
        aria-label="Direction / split view"
        onChange={(i) => {
          const action = directionSegmentAction(i, patterns.length);
          if (action.type === 'both') onSetOpposite(true);
          else { onSetOpposite(false); onSelectPattern(patterns[action.index]); }
        }}
      />
    );
  }

  if (patterns.length === 1) {
    return (
      <span className="text-xs font-semibold text-brown whitespace-nowrap shrink-0">
        {directionName(route, patterns[0].directionId)}
      </span>
    );
  }

  // Shapeless in-progress route (0 patterns) — direction-only toggle, no split.
  void canOpposite;
  return (
    <Select
      value={String(directionId)}
      onChange={(v) => onSelectDirection(Number(v) as 0 | 1)}
      options={[
        { id: '0', name: directionName(route, 0) },
        { id: '1', name: directionName(route, 1) },
      ]}
      aria-label="Direction"
    />
  );
}

/** Two-row timetable header (HANDOFF §1): row 1 is context + view (route,
 *  service, direction/split, trip count + "?", Edit Stops); row 2 is "Trip
 *  tools" (Generate / Set run time / Repeat, and a right-aligned danger Remove
 *  all trips). Both rows scroll horizontally on narrow viewports so every
 *  control stays reachable at 390px. */
export function TimetableToolbar(props: ToolbarProps) {
  const {
    route, routes, shapes, calendars, activeServiceId, patterns, effectiveShapeId,
    directionId, tripCount, oppositeOpen,
    onSelectRoute, onSelectService, onSelectPattern, onSelectDirection, onSetOpposite,
    onEditStops, onTool,
  } = props;

  return (
    <div className="shrink-0">
      {/* Row 1 — context & view */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sand overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Select
          value={route.route_id}
          onChange={(v) => onSelectRoute(v || null)}
          options={routes.map((r) => ({ id: r.route_id, name: r.route_short_name || r.route_long_name || r.route_id }))}
          aria-label="Route"
        />
        {calendars.length > 0 && (
          <Select
            value={activeServiceId || ''}
            onChange={onSelectService}
            options={calendars.map((c) => ({ id: c.service_id, name: c._description || c.service_id }))}
            aria-label="Service pattern"
          />
        )}
        <DirectionControl
          route={route}
          shapes={shapes}
          patterns={patterns}
          effectiveShapeId={effectiveShapeId}
          directionId={directionId}
          oppositeOpen={oppositeOpen}
          onSelectPattern={onSelectPattern}
          onSelectDirection={onSelectDirection}
          onSetOpposite={onSetOpposite}
        />
        <span className="inline-flex items-center gap-1.5 text-[12.5px] text-warm-gray whitespace-nowrap">
          {tripCount} trips
          <HintPopover />
        </span>
        <span className="flex-1 min-w-[12px]" />
        <Button variant="ghost" onClick={onEditStops} title="Add or reorder this route's stops">
          <span>Edit Stops</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M6 6h12v12" />
            <path d="M6 18 18 6" />
          </svg>
        </Button>
      </div>

      {/* Row 2 — Trip tools */}
      <div className="flex items-center gap-2 px-3 py-[7px] border-b border-sand bg-cream overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="font-body font-bold text-[10px] uppercase tracking-wider text-warm-gray whitespace-nowrap mr-0.5">
          Trip tools
        </span>
        <Button variant="secondary" icon="✨" title="Lay out a whole day of trips at a set interval" onClick={() => onTool('generate')}>
          Generate trips…
        </Button>
        <Button variant="secondary" icon="⏱" title="Re-time every trip to a new end-to-end run" onClick={() => onTool('runtime')} disabled={tripCount === 0}>
          Set run time…
        </Button>
        <Button variant="secondary" icon="↻" title="Add copies of the last trip at a set interval" onClick={() => onTool('repeat')} disabled={tripCount === 0}>
          Repeat last trip…
        </Button>
        {/* Danger action sits with the other trip tools (owner reference), not
            pushed to the far right — a small gap sets it apart. */}
        <span className="w-3 shrink-0" aria-hidden="true" />
        <Button variant="ghost" danger onClick={() => onTool('removeall')} disabled={tripCount === 0}>
          Remove all trips
        </Button>
      </div>
    </div>
  );
}
