import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store';
import type { SidebarSection } from '../../types/ui';

interface NavItem {
  key: SidebarSection;
  label: string;
  icon: string;
  tile: 'tile-teal' | 'tile-coral' | 'tile-gold' | 'tile-purple';
}

const SETUP: NavItem[] = [
  { key: 'agency', label: 'Agency', icon: 'A', tile: 'tile-teal' },
  { key: 'fares', label: 'Fares', icon: '$', tile: 'tile-gold' },
  { key: 'calendar', label: 'Calendars', icon: 'C', tile: 'tile-gold' },
];
const FIXED_ROUTE: NavItem[] = [
  { key: 'routes', label: 'Routes', icon: 'R', tile: 'tile-coral' },
  { key: 'stops', label: 'Stops', icon: 'S', tile: 'tile-coral' },
];
const FLEX: NavItem[] = [
  { key: 'flex', label: 'Flex Zones', icon: 'F', tile: 'tile-purple' },
];
const ANALYSIS: NavItem[] = [
  { key: 'costs', label: 'Costs', icon: '¢', tile: 'tile-gold' },
  { key: 'coverage', label: 'Coverage', icon: '◎', tile: 'tile-teal' },
  { key: 'titlevi', label: 'Title VI', icon: 'VI', tile: 'tile-purple' },
];

const TILE_COLORS: Record<NavItem['tile'], string> = {
  'tile-teal': 'bg-teal-light text-teal',
  'tile-coral': 'bg-coral-light text-coral',
  'tile-gold': 'bg-gold-light text-amber-700',
  'tile-purple': 'bg-purple-light text-purple',
};

const MIN_WIDTH = 40;
const MAX_WIDTH = 260;
// Width breakpoints for which variant to render at the current actual width.
const MID_THRESHOLD = 64;   // < this → render min variant (icons only)
const MAX_THRESHOLD = 180;  // >= this → render max variant (rows)
// Auto-default thresholds.
const NARROW_VIEWPORT = 600;     // below this (phones), force min (40 px)
const WIDE_VIEWPORT = 1440;      // above this, default to max (260 px)
                                 // between → default to mid (96 px)


interface ItemCounts {
  agencyValid: boolean;
  fares: number;
  calendars: number;
  routes: number;
  stops: number;
  flex: number;
}

function useItemCounts(): ItemCounts {
  const agencyValid = useStore((s) => {
    const a = s.agencies[0];
    return !!a && !!a.agency_name && !!a.agency_timezone && !!a.agency_url;
  });
  const fares = useStore((s) => s.fareAttributes.length);
  const calendars = useStore((s) => s.calendars.length);
  const routes = useStore((s) => s.routes.length);
  const stops = useStore((s) => s.stops.length);
  const flex = useStore((s) => s.flexZones.length);
  return { agencyValid, fares, calendars, routes, stops, flex };
}

function countFor(key: SidebarSection, c: ItemCounts): number | null {
  switch (key) {
    case 'agency':
      return c.agencyValid ? -1 : null; // -1 = check icon
    case 'fares':
      return c.fares;
    case 'calendar':
      return c.calendars;
    case 'routes':
      return c.routes;
    case 'stops':
      return c.stops;
    case 'flex':
      return c.flex;
    default:
      return null;
  }
}

function CheckChip({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full shadow-sm ${
        active ? 'bg-white text-coral' : 'bg-teal-light text-teal'
      }`}
      aria-hidden
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M2.5 6.2L4.7 8.4L9.5 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function CountPill({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[26px] h-5 px-2 rounded-full text-[11px] font-bold tabular-nums ${
        active ? 'bg-white text-coral' : 'bg-sand text-warm-gray'
      }`}
    >
      {n.toLocaleString()}
    </span>
  );
}

function CornerBadge({ n }: { n: number }) {
  return (
    <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-dark-brown text-white text-[10px] font-bold inline-flex items-center justify-center border-2 border-white tabular-nums">
      {n.toLocaleString()}
    </span>
  );
}

/* ──────────────────── MAX RAIL · 260px ──────────────────── */

function MaxRail({ counts }: { counts: ItemCounts }) {
  const { sidebarSection, setSidebarSection } = useStore();
  const [fixedManual, setFixedManual] = useState<boolean | null>(null);
  const [flexManual, setFlexManual] = useState<boolean | null>(null);
  const [analysisManual, setAnalysisManual] = useState<boolean | null>(null);

  const isFixedActive = FIXED_ROUTE.some((i) => i.key === sidebarSection);
  const isFlexActive = FLEX.some((i) => i.key === sidebarSection);
  const isAnalysisActive = ANALYSIS.some((i) => i.key === sidebarSection);

  // Default-open if active; user can still toggle to override.
  const fixedOpen = fixedManual ?? (isFixedActive || true);
  const flexOpen = flexManual ?? isFlexActive;
  const analysisOpen = analysisManual ?? isAnalysisActive;
  const setFixedOpen = (v: boolean) => setFixedManual(v);
  const setFlexOpen = (v: boolean) => setFlexManual(v);
  const setAnalysisOpen = (v: boolean) => setAnalysisManual(v);

  const renderRow = (item: NavItem) => {
    const active = sidebarSection === item.key;
    const count = countFor(item.key, counts);
    return (
      <button
        key={item.key}
        onClick={() => setSidebarSection(item.key)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-left transition-colors ${
          active
            ? 'bg-coral-light text-coral font-bold'
            : 'text-brown hover:bg-cream'
        }`}
      >
        <span className={`w-[22px] h-[22px] rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 ${TILE_COLORS[item.tile]}`}>
          {item.icon}
        </span>
        <span className="flex-1 min-w-0 truncate">{item.label}</span>
        {active && count === -1 ? <CheckChip active /> : null}
        {!active && count === -1 ? <CheckChip active={false} /> : null}
        {count !== null && count !== -1 && count > 0 ? <CountPill n={count} active={active} /> : null}
      </button>
    );
  };

  const renderCap = (label: string, isOpen: boolean, setOpen: (v: boolean) => void) => (
    <button
      onClick={() => setOpen(!isOpen)}
      className="w-full flex items-center justify-between px-3 pt-3.5 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-warm-gray hover:text-dark-brown"
    >
      <span>{label}</span>
      <span className="text-sm">{isOpen ? '−' : '+'}</span>
    </button>
  );

  return (
    <div className="flex flex-col gap-0.5 p-2.5">
      {SETUP.map(renderRow)}
      {renderCap('Fixed Route Service', fixedOpen, setFixedOpen)}
      {fixedOpen && FIXED_ROUTE.map(renderRow)}
      {renderCap('GTFS-Flex', flexOpen, setFlexOpen)}
      {flexOpen && FLEX.map(renderRow)}
      {renderCap('Analysis', analysisOpen, setAnalysisOpen)}
      {analysisOpen && ANALYSIS.map(renderRow)}
    </div>
  );
}

/* ──────────────────── MID RAIL · 96px ──────────────────── */

function MidRail({ counts }: { counts: ItemCounts }) {
  const { sidebarSection, setSidebarSection } = useStore();

  const renderTile = (item: NavItem) => {
    const active = sidebarSection === item.key;
    const count = countFor(item.key, counts);
    return (
      <button
        key={item.key}
        onClick={() => setSidebarSection(item.key)}
        className={`relative mx-1.5 my-0.5 px-1.5 py-2 flex flex-col items-center gap-1 rounded-lg transition-colors ${
          active
            ? 'bg-coral-light text-coral'
            : 'text-warm-gray hover:bg-cream hover:text-dark-brown'
        }`}
        title={item.label}
      >
        {active && (
          <span className="absolute -left-1.5 top-2 bottom-2 w-[3px] rounded-r bg-coral" aria-hidden />
        )}
        <span className={`relative w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${TILE_COLORS[item.tile]}`}>
          {item.icon}
          {count !== null && count !== -1 && count > 0 ? <CornerBadge n={count} /> : null}
        </span>
        <span className="text-[10px] font-semibold leading-none">{item.label}</span>
      </button>
    );
  };

  const groupDivider = (
    <div className="my-1.5 mx-auto w-6 h-px bg-sand" aria-hidden />
  );

  return (
    <div className="flex flex-col py-2 gap-0.5">
      {SETUP.map(renderTile)}
      {groupDivider}
      {FIXED_ROUTE.map(renderTile)}
      {FLEX.map(renderTile)}
      {groupDivider}
      {ANALYSIS.map(renderTile)}
    </div>
  );
}

/* ──────────────────── MIN RAIL · 40px ──────────────────── */

function MinRail({ counts }: { counts: ItemCounts }) {
  const { sidebarSection, setSidebarSection } = useStore();
  const all = [...SETUP, ...FIXED_ROUTE, ...FLEX, ...ANALYSIS];
  const dividerAfter = new Set<number>([
    SETUP.length - 1,
    SETUP.length + FIXED_ROUTE.length + FLEX.length - 1,
  ]);

  return (
    <div className="flex flex-col items-center py-2 gap-1">
      {all.map((item, i) => {
        const active = sidebarSection === item.key;
        const count = countFor(item.key, counts);
        const isPopulated = count !== null && (count === -1 || count > 0);
        return (
          <div key={item.key} className="contents">
            <button
              onClick={() => setSidebarSection(item.key)}
              title={item.label}
              className={`relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                active ? 'bg-coral-light' : 'hover:bg-cream'
              }`}
            >
              {active && (
                <span className="absolute -left-1 top-1.5 bottom-1.5 w-[3px] rounded-r bg-coral" aria-hidden />
              )}
              <span
                className={`w-5 h-5 rounded-md flex items-center justify-center text-[10px] font-bold ${
                  isPopulated ? TILE_COLORS[item.tile] : 'bg-sand text-warm-gray'
                }`}
              >
                {item.icon}
              </span>
            </button>
            {dividerAfter.has(i) && <div className="w-5 h-px bg-sand my-1" />}
          </div>
        );
      })}
    </div>
  );
}

/* ──────────────────── LeftRail wrapper ──────────────────── */

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Pick a sensible default width for the current viewport. Run on first mount
 * (after the persisted store has hydrated) and on viewport-resize.
 */
function defaultWidthFor(viewportWidth: number): number {
  if (viewportWidth < NARROW_VIEWPORT) return MIN_WIDTH;
  if (viewportWidth > WIDE_VIEWPORT) return MAX_WIDTH;
  return 96;
}

export function LeftRail() {
  const storedWidth = useStore((s) => s.leftRailWidth);
  const setLeftRailWidth = useStore((s) => s.setLeftRailWidth);
  const counts = useItemCounts();
  const initializedRef = useRef(false);
  const [forcedNarrow, setForcedNarrow] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT,
  );

  // On first mount, set the responsive default. We don't override after the
  // user has resized — they're in control once they touch the rail.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    setLeftRailWidth(defaultWidthFor(window.innerWidth));
  }, [setLeftRailWidth]);

  // Auto-collapse to min when the viewport drops below the narrow threshold.
  useEffect(() => {
    const onResize = () => setForcedNarrow(window.innerWidth < NARROW_VIEWPORT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const widthPx = forcedNarrow
    ? MIN_WIDTH
    : clamp(storedWidth, MIN_WIDTH, MAX_WIDTH);

  let body: ReactNode;
  if (widthPx < MID_THRESHOLD) body = <MinRail counts={counts} />;
  else if (widthPx < MAX_THRESHOLD) body = <MidRail counts={counts} />;
  else body = <MaxRail counts={counts} />;

  // ── Drag handle ────────────────────────────────────────────────
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = (e: React.MouseEvent) => {
    if (forcedNarrow) return; // Locked in narrow viewports.
    e.preventDefault();
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      const next = clamp(ev.clientX, MIN_WIDTH, MAX_WIDTH);
      setLeftRailWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      className={`relative bg-white border-r border-sand shrink-0 flex flex-col overflow-hidden ${
        isDragging ? '' : 'transition-[width] duration-150'
      }`}
      style={{ width: widthPx }}
    >
      <div className="flex-1 overflow-y-auto">{body}</div>

      {/* Drag handle — right edge. Hidden when forced narrow. */}
      {!forcedNarrow && (
        <div
          onMouseDown={startDrag}
          onDoubleClick={() => setLeftRailWidth(defaultWidthFor(window.innerWidth))}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize navigation rail"
          title="Drag to resize · double-click to reset"
          className={`absolute top-0 right-0 h-full w-1.5 cursor-col-resize z-10 transition-colors ${
            isDragging ? 'bg-coral/40' : 'hover:bg-coral/30'
          }`}
        />
      )}

      {/* Block other pointer events (and keep cursor) while dragging */}
      {isDragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
    </div>
  );
}
