import { useStore } from '../../store';
import type { CenterView } from '../../types/ui';

/**
 * Segmented control that switches the central pane between the map, the
 * timetable builder, and the blocking Gantt (the two service-planning views).
 * Rendered as a thin bar atop the center pane in AppShell.
 *
 * Switching is intentionally cheap: the map stays mounted-but-hidden behind a
 * scheduling view (Mapbox re-init is expensive), so flipping back to 'map' is
 * instant and preserves the camera. Trip editing itself is free; the premium
 * "Variants" comparison is paywalled inside the timetable view, not here, so
 * the control stays discoverable (and demoable on /demo) for everyone.
 */

interface ViewDef {
  id: CenterView;
  label: string;
  icon: React.ReactNode;
  title: string;
}

const MapIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
    <line x1="8" y1="2" x2="8" y2="18" />
    <line x1="16" y1="6" x2="16" y2="22" />
  </svg>
);

const TimetableIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="9" y1="9" x2="9" y2="20" />
    <line x1="15" y1="9" x2="15" y2="20" />
  </svg>
);

const BlocksIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="5" width="9" height="4" rx="1" />
    <rect x="13" y="5" width="7" height="4" rx="1" />
    <rect x="2" y="14" width="6" height="4" rx="1" />
    <rect x="10" y="14" width="11" height="4" rx="1" />
  </svg>
);

const VIEWS: ViewDef[] = [
  { id: 'map', label: 'Map', icon: MapIcon, title: 'Map editor' },
  { id: 'timetable', label: 'Timetable', icon: TimetableIcon, title: 'Service & timetable builder' },
  { id: 'blocks', label: 'Blocks', icon: BlocksIcon, title: 'Vehicle blocking' },
];

export function CenterViewSwitcher() {
  const centerView = useStore((s) => s.centerView);
  const setCenterView = useStore((s) => s.setCenterView);

  return (
    <div
      className="inline-flex items-center gap-0.5 p-0.5 bg-sand/70 rounded-lg shrink-0"
      role="tablist"
      aria-label="Center pane view"
    >
      {VIEWS.map((v) => {
        const active = centerView === v.id;
        return (
          <button
            key={v.id}
            role="tab"
            aria-selected={active}
            onClick={() => setCenterView(v.id)}
            title={v.title}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-heading font-bold transition-colors ${
              active
                ? 'bg-white text-coral shadow-sm'
                : 'text-warm-gray hover:text-dark-brown'
            }`}
          >
            <span className={active ? 'text-coral' : 'text-warm-gray'}>{v.icon}</span>
            <span className="hidden sm:inline">{v.label}</span>
          </button>
        );
      })}
    </div>
  );
}
