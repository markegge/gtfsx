import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../../store';
import type { SidebarSection } from '../../types/ui';

interface NavItem {
  key: SidebarSection;
  label: string;
  tile: 'tile-teal' | 'tile-coral' | 'tile-gold' | 'tile-purple';
}

const SETUP: NavItem[] = [
  { key: 'agency', label: 'Agency', tile: 'tile-teal' },
  { key: 'fares', label: 'Fares', tile: 'tile-gold' },
  { key: 'calendar', label: 'Calendars', tile: 'tile-gold' },
];
const FIXED_ROUTE: NavItem[] = [
  { key: 'routes', label: 'Routes', tile: 'tile-coral' },
  { key: 'stops', label: 'Stops', tile: 'tile-coral' },
];
const FLEX: NavItem[] = [
  { key: 'flex', label: 'Flex Zones', tile: 'tile-purple' },
];
const ANALYSIS: NavItem[] = [
  { key: 'costs', label: 'Costs', tile: 'tile-gold' },
  { key: 'stop-analysis', label: 'Stop Analysis', tile: 'tile-coral' },
  { key: 'coverage', label: 'Coverage', tile: 'tile-teal' },
  { key: 'titlevi', label: 'Title VI', tile: 'tile-purple' },
];
const OPERATIONS: NavItem[] = [
  { key: 'alerts', label: 'Service Alerts', tile: 'tile-coral' },
];

/**
 * Section icons. Single-source-of-truth: every nav surface (max/mid/min)
 * pulls icon glyphs from here so swapping a glyph only edits this map.
 * Stroke-only line icons drawn on a 24×24 viewBox; `currentColor` lets each
 * tile colorway tint them. Size is set by the wrapping <span>.
 */
function NavIcon({ section, className = 'w-4 h-4' }: { section: SidebarSection; className?: string }) {
  const path = ICON_PATHS[section];
  if (!path) return null;
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  );
}

const ICON_PATHS: Record<SidebarSection, ReactNode> = {
  // Agency — small office building
  agency: (
    <>
      <path d="M4 21V6l8-3 8 3v15" />
      <path d="M4 21h16" />
      <path d="M9 10h.01M9 14h.01M9 18h.01M15 10h.01M15 14h.01M15 18h.01" />
    </>
  ),
  // Fares — ticket
  fares: (
    <>
      <path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V9z" />
      <path d="M13 7v2M13 11v2M13 15v2" />
    </>
  ),
  // Calendars — month grid
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4M16 3v4" />
      <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
    </>
  ),
  // Routes — branching path
  routes: (
    <>
      <path d="M4 6h6a4 4 0 0 1 4 4v4a4 4 0 0 0 4 4h2" />
      <circle cx="4" cy="6" r="1.5" />
      <circle cx="20" cy="18" r="1.5" />
    </>
  ),
  // Stops — map pin
  stops: (
    <>
      <path d="M12 22s7-7.5 7-13a7 7 0 0 0-14 0c0 5.5 7 13 7 13z" />
      <circle cx="12" cy="9" r="2.5" />
    </>
  ),
  // Flex zones — dashed shaded zone
  flex: (
    <>
      <path d="M12 4l7 4v8l-7 4-7-4V8l7-4z" strokeDasharray="3 2" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  // Costs — calculator
  costs: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <rect x="8" y="6" width="8" height="3" rx="0.5" />
      <path d="M9 13h.01M12 13h.01M15 13h.01M9 17h.01M12 17h.01M15 17h.01" />
    </>
  ),
  // Stop Analysis — bar chart with a magnifier accent
  'stop-analysis': (
    <>
      <path d="M4 20V10M9 20V4M14 20v-7M19 20v-4" />
      <path d="M3 20h18" />
    </>
  ),
  // Coverage — concentric reach
  coverage: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5.5" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  // Title VI — two figures (people / community)
  titlevi: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9.5" r="2.25" />
      <path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M14.5 20c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5" />
    </>
  ),
  // Service Alerts — megaphone
  alerts: (
    <>
      <path d="M3 11v2a1 1 0 0 0 1 1h2l9 5V5L6 10H4a1 1 0 0 0-1 1z" />
      <path d="M18 9a3 3 0 0 1 0 6" />
    </>
  ),
};

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
const COMPACT_VIEWPORT = 800;    // below this (tablets / capture windows),
                                 // force a slim 66 px rail
const COMPACT_WIDTH = 66;
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

/**
 * Click a nav item: switches sections normally, but if the user clicks the
 * already-active section the right rail toggles closed (and reopens on a
 * subsequent click of the same item). This makes the nav buttons behave
 * like a pinned tab where the second click hides the panel.
 */
function useNavClick() {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const setSidebarSection = useStore((s) => s.setSidebarSection);
  return (key: SidebarSection) => {
    // Re-clicking the active section fully closes the rail (not minimize).
    if (sidebarSection === key) {
      setSidebarSection(null);
    } else {
      setSidebarSection(key);
    }
  };
}

function MaxRail({ counts }: { counts: ItemCounts }) {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const handleClick = useNavClick();
  const [fixedManual, setFixedManual] = useState<boolean | null>(null);
  const [flexManual, setFlexManual] = useState<boolean | null>(null);
  const [analysisManual, setAnalysisManual] = useState<boolean | null>(null);
  const [operationsManual, setOperationsManual] = useState<boolean | null>(null);

  const isFixedActive = FIXED_ROUTE.some((i) => i.key === sidebarSection);
  const isFlexActive = FLEX.some((i) => i.key === sidebarSection);
  const isAnalysisActive = ANALYSIS.some((i) => i.key === sidebarSection);
  const isOperationsActive = OPERATIONS.some((i) => i.key === sidebarSection);

  // Default-open if active; user can still toggle to override.
  const fixedOpen = fixedManual ?? (isFixedActive || true);
  const flexOpen = flexManual ?? isFlexActive;
  const analysisOpen = analysisManual ?? isAnalysisActive;
  const operationsOpen = operationsManual ?? isOperationsActive;
  const setFixedOpen = (v: boolean) => setFixedManual(v);
  const setFlexOpen = (v: boolean) => setFlexManual(v);
  const setAnalysisOpen = (v: boolean) => setAnalysisManual(v);
  const setOperationsOpen = (v: boolean) => setOperationsManual(v);

  const renderRow = (item: NavItem) => {
    const active = sidebarSection === item.key;
    const count = countFor(item.key, counts);
    return (
      <button
        key={item.key}
        onClick={() => handleClick(item.key)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-left transition-colors ${
          active
            ? 'bg-coral-light text-coral font-bold'
            : 'text-brown hover:bg-cream'
        }`}
      >
        <span className={`w-[22px] h-[22px] rounded-md flex items-center justify-center shrink-0 ${TILE_COLORS[item.tile]}`}>
          <NavIcon section={item.key} className="w-3.5 h-3.5" />
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
      {renderCap('Operations', operationsOpen, setOperationsOpen)}
      {operationsOpen && OPERATIONS.map(renderRow)}
    </div>
  );
}

/* ──────────────────── MID RAIL · 96px ──────────────────── */

function MidRail({ counts }: { counts: ItemCounts }) {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const handleClick = useNavClick();

  const renderTile = (item: NavItem) => {
    const active = sidebarSection === item.key;
    const count = countFor(item.key, counts);
    return (
      <button
        key={item.key}
        onClick={() => handleClick(item.key)}
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
        <span className={`relative w-8 h-8 rounded-lg flex items-center justify-center ${TILE_COLORS[item.tile]}`}>
          <NavIcon section={item.key} className="w-[18px] h-[18px]" />
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
      {groupDivider}
      {OPERATIONS.map(renderTile)}
    </div>
  );
}

/* ──────────────────── MIN RAIL · 40px ──────────────────── */

function MinRail({ counts }: { counts: ItemCounts }) {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const handleClick = useNavClick();
  const all = [...SETUP, ...FIXED_ROUTE, ...FLEX, ...ANALYSIS, ...OPERATIONS];
  const dividerAfter = new Set<number>([
    SETUP.length - 1,
    SETUP.length + FIXED_ROUTE.length + FLEX.length - 1,
    SETUP.length + FIXED_ROUTE.length + FLEX.length + ANALYSIS.length - 1,
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
              onClick={() => handleClick(item.key)}
              title={item.label}
              className={`relative w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
                active ? 'bg-coral-light' : 'hover:bg-cream'
              }`}
            >
              {active && (
                <span className="absolute -left-1 top-1.5 bottom-1.5 w-[3px] rounded-r bg-coral" aria-hidden />
              )}
              <span
                className={`w-5 h-5 rounded-md flex items-center justify-center ${
                  isPopulated ? TILE_COLORS[item.tile] : 'bg-sand text-warm-gray'
                }`}
              >
                <NavIcon section={item.key} className="w-3 h-3" />
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
  if (viewportWidth < COMPACT_VIEWPORT) return COMPACT_WIDTH;
  if (viewportWidth > WIDE_VIEWPORT) return MAX_WIDTH;
  return 96;
}

export function LeftRail() {
  const storedWidth = useStore((s) => s.leftRailWidth);
  const setLeftRailWidth = useStore((s) => s.setLeftRailWidth);
  const counts = useItemCounts();
  const initializedRef = useRef(false);
  // Forced width tier for narrow viewports. 'narrow' (<600 px) clamps the
  // rail to MIN_WIDTH; 'compact' (600-800 px, used for tablets and video
  // capture windows) clamps it to COMPACT_WIDTH. Anything wider respects the
  // user's stored width so they can keep dragging it around.
  const [forcedTier, setForcedTier] = useState<'narrow' | 'compact' | null>(() => {
    if (typeof window === 'undefined') return null;
    if (window.innerWidth < NARROW_VIEWPORT) return 'narrow';
    if (window.innerWidth < COMPACT_VIEWPORT) return 'compact';
    return null;
  });

  // On first mount, set the responsive default. We don't override after the
  // user has resized — they're in control once they touch the rail.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    setLeftRailWidth(defaultWidthFor(window.innerWidth));
  }, [setLeftRailWidth]);

  // Auto-collapse to the appropriate tier when the viewport crosses a threshold.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < NARROW_VIEWPORT) setForcedTier('narrow');
      else if (window.innerWidth < COMPACT_VIEWPORT) setForcedTier('compact');
      else setForcedTier(null);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const widthPx =
    forcedTier === 'narrow' ? MIN_WIDTH
    : forcedTier === 'compact' ? COMPACT_WIDTH
    : clamp(storedWidth, MIN_WIDTH, MAX_WIDTH);

  let body: ReactNode;
  if (widthPx < MID_THRESHOLD) body = <MinRail counts={counts} />;
  else if (widthPx < MAX_THRESHOLD) body = <MidRail counts={counts} />;
  else body = <MaxRail counts={counts} />;

  // ── Drag handle ────────────────────────────────────────────────
  const [isDragging, setIsDragging] = useState(false);

  const startDrag = (e: React.MouseEvent) => {
    if (forcedTier !== null) return; // Locked in narrow / compact viewports.
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

      {/* Drag handle — right edge. Hidden when the rail width is forced. */}
      {forcedTier === null && (
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
