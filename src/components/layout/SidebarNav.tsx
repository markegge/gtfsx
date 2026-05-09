import { useState, useEffect, type ReactNode } from 'react';
import { useStore } from '../../store';
import type { SidebarSection } from '../../types/ui';

interface NavItem {
  key: SidebarSection;
  label: string;
  icon: string;
  bgClass: string;
  textClass: string;
}

const COMMON_ITEMS: NavItem[] = [
  { key: 'agency', label: 'Agency', icon: 'A', bgClass: 'bg-teal-light', textClass: 'text-teal' },
  { key: 'fares', label: 'Fares', icon: '$', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'calendar', label: 'Calendars', icon: 'C', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
];

const FIXED_ROUTE_ITEMS: NavItem[] = [
  { key: 'routes', label: 'Routes', icon: 'R', bgClass: 'bg-coral-light', textClass: 'text-coral' },
  { key: 'stops', label: 'Stops', icon: 'S', bgClass: 'bg-coral-light', textClass: 'text-coral' },
];

const FLEX_ITEMS: NavItem[] = [
  { key: 'flex', label: 'Flex Zones & Rules', icon: 'F', bgClass: 'bg-purple-light', textClass: 'text-purple' },
];

const ANALYSIS_ITEMS: NavItem[] = [
  { key: 'costs', label: 'Costs', icon: '¢', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'coverage', label: 'Coverage', icon: '◎', bgClass: 'bg-teal-light', textClass: 'text-teal' },
  { key: 'titlevi', label: 'Title VI', icon: 'VI', bgClass: 'bg-purple-light', textClass: 'text-purple' },
];

const FIXED_ROUTE_KEYS = new Set(FIXED_ROUTE_ITEMS.map((i) => i.key));
const FLEX_KEYS = new Set(FLEX_ITEMS.map((i) => i.key));
const ANALYSIS_KEYS = new Set(ANALYSIS_ITEMS.map((i) => i.key));

function CountBadge({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[1.5rem] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums ${
        active ? 'bg-white text-coral' : 'bg-sand text-warm-gray'
      }`}
    >
      {n.toLocaleString()}
    </span>
  );
}

function CheckBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${
        active ? 'bg-white text-coral' : 'bg-teal-light text-teal'
      }`}
      aria-label="Agency configured"
      title="Agency configured"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path d="M2.5 6.2L4.7 8.4L9.5 3.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function SidebarNav() {
  const { sidebarSection, setSidebarSection } = useStore();
  const [fixedRouteOpen, setFixedRouteOpen] = useState(true);
  const [flexOpen, setFlexOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);

  const isFixedRouteActive = FIXED_ROUTE_KEYS.has(sidebarSection);
  const isFlexActive = FLEX_KEYS.has(sidebarSection);
  const isAnalysisActive = ANALYSIS_KEYS.has(sidebarSection);

  // Auto-open an accordion when the user navigates to one of its sections
  useEffect(() => { if (isFixedRouteActive) setFixedRouteOpen(true); }, [isFixedRouteActive]);
  useEffect(() => { if (isFlexActive) setFlexOpen(true); }, [isFlexActive]);
  useEffect(() => { if (isAnalysisActive) setAnalysisOpen(true); }, [isAnalysisActive]);

  // Live counts from the store — re-render when any of these change.
  const agencyValid = useStore((s) => {
    const a = s.agencies[0];
    return !!a && !!a.agency_name && !!a.agency_timezone && !!a.agency_url;
  });
  const faresCount = useStore((s) => s.fareAttributes.length);
  const calendarsCount = useStore((s) => s.calendars.length);
  const routesCount = useStore((s) => s.routes.length);
  const stopsCount = useStore((s) => s.stops.length);
  const flexCount = useStore((s) => s.flexZones.length);

  const renderBadge = (key: SidebarSection, active: boolean): ReactNode => {
    switch (key) {
      case 'agency':
        return agencyValid ? <CheckBadge active={active} /> : null;
      case 'fares':
        return faresCount > 0 ? <CountBadge n={faresCount} active={active} /> : null;
      case 'calendar':
        return calendarsCount > 0 ? <CountBadge n={calendarsCount} active={active} /> : null;
      case 'routes':
        return routesCount > 0 ? <CountBadge n={routesCount} active={active} /> : null;
      case 'stops':
        return stopsCount > 0 ? <CountBadge n={stopsCount} active={active} /> : null;
      case 'flex':
        return flexCount > 0 ? <CountBadge n={flexCount} active={active} /> : null;
      default:
        return null;
    }
  };

  const renderItem = ({ key, label, icon, bgClass, textClass }: NavItem) => {
    const active = sidebarSection === key;
    return (
      <button
        key={key}
        onClick={() => setSidebarSection(key)}
        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left
          ${active
            ? 'bg-coral-light text-coral font-semibold'
            : 'text-warm-gray hover:bg-cream hover:text-dark-brown'
          }`}
      >
        <div className={`w-5 h-5 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 ${bgClass} ${textClass}`}>
          {icon}
        </div>
        <span className="flex-1 truncate">{label}</span>
        {renderBadge(key, active)}
      </button>
    );
  };

  const renderAccordion = (
    label: string,
    items: NavItem[],
    isOpen: boolean,
    setOpen: (v: boolean) => void,
  ) => (
    <div className="mt-1">
      <button
        onClick={() => setOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-cream transition-colors"
      >
        <span className="text-[10px] font-bold text-warm-gray uppercase tracking-wider">
          {label}
        </span>
        <span className="text-[10px] text-warm-gray">
          {isOpen ? '−' : '+'}
        </span>
      </button>
      {isOpen && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {items.map(renderItem)}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col p-3 gap-0.5">
      {COMMON_ITEMS.map(renderItem)}

      {renderAccordion('Fixed Route Service', FIXED_ROUTE_ITEMS, fixedRouteOpen, setFixedRouteOpen)}
      {renderAccordion('GTFS-Flex', FLEX_ITEMS, flexOpen, setFlexOpen)}
      {renderAccordion('Analysis', ANALYSIS_ITEMS, analysisOpen, setAnalysisOpen)}
    </div>
  );
}
