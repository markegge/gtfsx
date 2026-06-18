import { lazy, Suspense, useEffect } from 'react';
import { TopBar } from './TopBar';
import { LeftRail } from './LeftRail';
import { RightRail } from './RightRail';
import { BottomPanel } from './BottomPanel';
import { WelcomeBanner } from './WelcomeBanner';
import { PartnerBanner } from './PartnerBanner';
import { VariantBanner } from '../variants/VariantBanner';
// Mapbox GL (~450 KB) is the single largest contributor to main-thread
// script-eval on first load. Lazy-loading it lets the editor chrome paint and
// become interactive before the map bundle is fetched and initialized.
const MapView = lazy(() => import('../map/MapView').then((m) => ({ default: m.MapView })));
// Scheduling views render in the SAME pane as the map (per Mark). Lazy so they
// don't weigh on first paint for users who never open them.
const TimetableView = lazy(() => import('../timetable/TimetableView').then((m) => ({ default: m.TimetableView })));
const BlockGantt = lazy(() => import('../blocks/BlockGantt').then((m) => ({ default: m.BlockGantt })));
import { RouteDeleteDialog } from '../routes/RouteDeleteDialog';
import { FloatingHelp } from './FloatingHelp';
import { CenterViewSwitcher } from './CenterViewSwitcher';
import { useStore } from '../../store';
import { trackEditorLoaded } from '../../services/trackBeacon';

function useRailKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in form fields.
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      // Cmd/Ctrl + / → toggle right rail.
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        const { sidebarSection, rightRailOpen, setRightRailOpen } = useStore.getState();
        if (sidebarSection) setRightRailOpen(!rightRailOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function AppShell() {
  useRailKeyboardShortcuts();
  // The editor shell only mounts on the editor routes (anonymous, demo, or
  // server-backed), so one fire per mount marks an editor session.
  useEffect(() => {
    trackEditorLoaded();
  }, []);
  const centerView = useStore((s) => s.centerView);
  const mapActive = centerView === 'map';
  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <WelcomeBanner />
      <PartnerBanner />
      <VariantBanner />
      <div className="flex-1 flex overflow-hidden">
        <LeftRail />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 flex overflow-hidden min-h-0">
            <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
              {/* Shared thin bar: switch the pane between map and the two
                  scheduling views. Trip editing is free; the premium Variants
                  comparison is paywalled inside the timetable view, not here. */}
              <div className="shrink-0 h-9 flex items-center gap-2 px-2 bg-white border-b border-sand">
                <CenterViewSwitcher />
              </div>
              {/* View area. The map stays MOUNTED (Mapbox re-init is expensive)
                  but is hidden behind a scheduling view when one is active. */}
              <div className="flex-1 relative min-h-0 overflow-hidden">
                <div
                  className={`absolute inset-0 ${mapActive ? '' : 'invisible pointer-events-none'}`}
                  aria-hidden={!mapActive}
                >
                  <Suspense fallback={<div className="w-full h-full bg-sand/40" aria-hidden />}>
                    <MapView />
                  </Suspense>
                </div>
                {centerView === 'timetable' && (
                  <Suspense fallback={<div className="absolute inset-0 bg-white" aria-hidden />}>
                    <TimetableView />
                  </Suspense>
                )}
                {centerView === 'blocks' && (
                  <Suspense fallback={<div className="absolute inset-0 bg-white" aria-hidden />}>
                    <BlockGantt />
                  </Suspense>
                )}
                <FloatingHelp />
              </div>
            </div>
            <RightRail />
          </div>
          <BottomPanel />
        </div>
      </div>
      <RouteDeleteDialog />
    </div>
  );
}
