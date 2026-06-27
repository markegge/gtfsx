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
import { RouteDeleteDialog } from '../routes/RouteDeleteDialog';
import { FloatingHelp } from './FloatingHelp';
import { ProUpgradeToast } from '../billing/ProUpgradeToast';
import { HistoryToast } from './HistoryToast';
import { undo, redo } from '../../store/history';
import { useStore } from '../../store';
import { trackEditorLoaded } from '../../services/trackBeacon';

function useRailKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in form fields — never steal undo/redo from inputs.
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      // Cmd/Ctrl + / → toggle right rail.
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault();
        const { sidebarSection, rightRailOpen, setRightRailOpen } = useStore.getState();
        if (sidebarSection) setRightRailOpen(!rightRailOpen);
        return;
      }

      // Undo / redo (#49): Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z (and Ctrl+Y on
      // Windows). `e.key` lowercases regardless of Shift, so compare in lower.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
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
  // When the bottom panel is maximized (and open), the map + right-rail row
  // collapses so the timetable / blocking Gantt fills the editor; toggled back
  // to the split view from the panel's maximize button.
  const bottomPanelMaximized = useStore((s) => s.bottomPanelMaximized);
  const bottomPanelOpen = useStore((s) => s.bottomPanelOpen);
  const collapseMap = bottomPanelMaximized && bottomPanelOpen;
  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <WelcomeBanner />
      <PartnerBanner />
      <VariantBanner />
      <div className="flex-1 flex overflow-hidden">
        <LeftRail />
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className={`flex-1 flex overflow-hidden min-h-0 ${collapseMap ? 'hidden' : ''}`}>
            <div className="flex-1 flex flex-col overflow-hidden min-w-0 relative">
              <Suspense fallback={<div className="flex-1 bg-sand/40" aria-hidden />}>
                <MapView />
              </Suspense>
              <FloatingHelp />
            </div>
            <RightRail />
          </div>
          <BottomPanel />
        </div>
      </div>
      <RouteDeleteDialog />
      <ProUpgradeToast />
      <HistoryToast />
    </div>
  );
}
