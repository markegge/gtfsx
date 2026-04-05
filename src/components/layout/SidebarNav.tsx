import { useState, useEffect } from 'react';
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
  { key: 'costs', label: 'Costs', icon: '\u00A2', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'coverage', label: 'Coverage', icon: '\u25CE', bgClass: 'bg-teal-light', textClass: 'text-teal' },
  { key: 'titlevi', label: 'Title VI', icon: 'VI', bgClass: 'bg-purple-light', textClass: 'text-purple' },
];

const FIXED_ROUTE_KEYS = new Set(FIXED_ROUTE_ITEMS.map((i) => i.key));
const FLEX_KEYS = new Set(FLEX_ITEMS.map((i) => i.key));
const ANALYSIS_KEYS = new Set(ANALYSIS_ITEMS.map((i) => i.key));

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

  const renderItem = ({ key, label, icon, bgClass, textClass }: NavItem) => (
    <button
      key={key}
      onClick={() => setSidebarSection(key)}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left
        ${sidebarSection === key
          ? 'bg-coral-light text-coral font-semibold'
          : 'text-warm-gray hover:bg-cream hover:text-dark-brown'
        }`}
    >
      <div className={`w-5 h-5 rounded-md flex items-center justify-center text-[11px] font-bold ${bgClass} ${textClass}`}>
        {icon}
      </div>
      {label}
    </button>
  );

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
