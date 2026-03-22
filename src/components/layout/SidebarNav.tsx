
import { useStore } from '../../store';
import type { SidebarSection } from '../../types/ui';

const NAV_ITEMS: { key: SidebarSection; label: string; icon: string; bgClass: string; textClass: string }[] = [
  { key: 'agency', label: 'Agency', icon: 'A', bgClass: 'bg-teal-light', textClass: 'text-teal' },
  { key: 'calendar', label: 'Calendars', icon: 'C', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'routes', label: 'Routes', icon: 'R', bgClass: 'bg-coral-light', textClass: 'text-coral' },
  { key: 'stops', label: 'Stops', icon: 'S', bgClass: 'bg-coral-light', textClass: 'text-coral' },
  { key: 'fares', label: 'Fares', icon: '$', bgClass: 'bg-gold-light', textClass: 'text-amber-700' },
  { key: 'timetable', label: 'Timetables', icon: 'T', bgClass: 'bg-purple-light', textClass: 'text-purple' },
];

export function SidebarNav() {
  const { sidebarSection, setSidebarSection } = useStore();

  return (
    <div className="flex flex-col p-3 gap-0.5">
      {NAV_ITEMS.map(({ key, label, icon, bgClass, textClass }) => (
        <button
          key={key}
          onClick={() => setSidebarSection(key)}
          className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left
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
      ))}
    </div>
  );
}
