import { useState } from 'react';
import { useStore } from '../../store';
import type { SidebarSection } from '../../types/ui';

interface NavItem {
  key: SidebarSection;
  label: string;
  icon: string;
  bgClass: string;
  textClass: string;
}

const BUILDER_ITEMS: NavItem[] = [
  { key: 'agency', label: 'Agency', icon: 'A', bgClass: 'bg-teal-light', textClass: 'text-teal' },
  { key: 'calendar', label: 'Calendars', icon: 'C', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'routes', label: 'Routes', icon: 'R', bgClass: 'bg-coral-light', textClass: 'text-coral' },
  { key: 'stops', label: 'Stops', icon: 'S', bgClass: 'bg-coral-light', textClass: 'text-coral' },
  { key: 'fares', label: 'Fares', icon: '$', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'timetable', label: 'Timetables', icon: 'T', bgClass: 'bg-purple-light', textClass: 'text-purple' },
];

const FLEX_ITEMS: NavItem[] = [
  { key: 'flex', label: 'Flex Zones & Rules', icon: 'F', bgClass: 'bg-purple-light', textClass: 'text-purple' },
];

const ANALYSIS_ITEMS: NavItem[] = [
  { key: 'costs', label: 'Costs', icon: '\u00A2', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'coverage', label: 'Coverage', icon: '\u25CE', bgClass: 'bg-teal-light', textClass: 'text-teal' },
];

export function SidebarNav() {
  const { sidebarSection, setSidebarSection } = useStore();
  const [flexOpen, setFlexOpen] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);

  // Auto-open accordion if its section is active
  const isFlexActive = sidebarSection === 'flex';
  const isAnalysisActive = sidebarSection === 'costs' || sidebarSection === 'coverage';

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

  return (
    <div className="flex flex-col p-3 gap-0.5">
      {BUILDER_ITEMS.map(renderItem)}

      {/* GTFS-Flex accordion */}
      <div className="mt-1">
        <button
          onClick={() => setFlexOpen(!flexOpen && !isFlexActive)}
          className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-cream transition-colors"
        >
          <span className="text-[10px] font-bold text-warm-gray uppercase tracking-wider">
            GTFS-Flex
          </span>
          <span className="text-[10px] text-warm-gray">
            {flexOpen || isFlexActive ? '−' : '+'}
          </span>
        </button>
        {(flexOpen || isFlexActive) && (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {FLEX_ITEMS.map(renderItem)}
          </div>
        )}
      </div>

      {/* Analysis accordion */}
      <div className="mt-1">
        <button
          onClick={() => setAnalysisOpen(!analysisOpen && !isAnalysisActive)}
          className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-cream transition-colors"
        >
          <span className="text-[10px] font-bold text-warm-gray uppercase tracking-wider">
            Analysis
          </span>
          <span className="text-[10px] text-warm-gray">
            {analysisOpen || isAnalysisActive ? '−' : '+'}
          </span>
        </button>
        {(analysisOpen || isAnalysisActive) && (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {ANALYSIS_ITEMS.map(renderItem)}
          </div>
        )}
      </div>
    </div>
  );
}
