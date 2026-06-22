
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { TimetableGrid } from '../timetable/TimetableGrid';
import { BlockGantt } from '../blocks/BlockGantt';
import { ServiceSummary } from '../timetable/ServiceSummary';
import { ValidationPanel } from '../validation/ValidationPanel';
import { SnapshotHistoryPanel } from '../snapshots/SnapshotHistoryPanel';
import { PublishWithDistribution } from '../distribution/PublishWithDistribution';
import { EmbedPanel } from '../embed/EmbedPanel';
import { ProjectAuditPanel } from '../audit/ProjectAuditPanel';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';

const MIN_HEIGHT = 120;
const MAX_HEIGHT_FRACTION = 0.75; // max 75% of viewport
const NARROW_VIEWPORT = 600; // phones — matches RightRail / LeftRail breakpoint

function getDefaultHeight() {
  // On phones open to 60 % of viewport height; desktop keeps 45 %.
  const narrow = typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT;
  return Math.round(window.innerHeight * (narrow ? 0.6 : 0.45));
}

export function BottomPanel() {
  const { bottomPanelOpen, bottomPanelTab, setBottomPanelTab, toggleBottomPanel } = useStore();
  const bottomPanelMaximized = useStore((s) => s.bottomPanelMaximized);
  const toggleBottomPanelMaximized = useStore((s) => s.toggleBottomPanelMaximized);
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);
  const editorPlan = useEditorPlan();
  const [panelHeight, setPanelHeight] = useState(getDefaultHeight);
  const [isDraggingState, setIsDraggingState] = useState(false);
  const isDragging = useRef(false);

  // Below 800 px (tablets + video-capture windows) the tab row collapses two
  // of the longer labels to fit the narrower header — kept in sync with the
  // LeftRail compact tier in src/components/layout/LeftRail.tsx.
  const [compactLabels, setCompactLabels] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 800,
  );
  useEffect(() => {
    const onResize = () => setCompactLabels(window.innerWidth < 800);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // On phones (<600 px) the panel becomes a fixed bottom-sheet so it is
  // always reachable above the RightRail section overlay (z-20). This also
  // means the tab row can scroll horizontally and drag-to-resize is hidden.
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT,
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < NARROW_VIEWPORT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Trigger map + grid relayout when the panel opens/closes or (un)maximizes.
  useEffect(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, [bottomPanelOpen, bottomPanelMaximized]);

  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      e.preventDefault();
      const maxH = Math.round(window.innerHeight * MAX_HEIGHT_FRACTION);
      const delta = dragStartY.current - e.clientY;
      setPanelHeight(Math.max(MIN_HEIGHT, Math.min(maxH, dragStartHeight.current + delta)));
    };
    const onMouseUp = () => {
      if (isDragging.current) {
        isDragging.current = false;
        setIsDraggingState(false);
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const handleDragStart = (e: React.MouseEvent) => {
    if (!bottomPanelOpen) return;
    isDragging.current = true;
    setIsDraggingState(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = panelHeight;
    e.preventDefault();
  };

  // On narrow viewports the panel is a fixed bottom-sheet: open height is
  // 60 % of the viewport so it gives room to see content without needing
  // drag-resize. When closed it stays fixed at 40 px so the header strip is
  // always tappable above whatever section overlay is beneath it (z-20).
  const effectiveHeight = bottomPanelOpen
    ? (isNarrow ? Math.round(window.innerHeight * 0.6) : panelHeight)
    : 40;

  // Maximize is a desktop affordance: the panel takes flex-1 (filling the
  // center column, whose map row AppShell has collapsed) instead of a fixed
  // height.
  const maximized = bottomPanelMaximized && bottomPanelOpen && !isNarrow;

  return (
    <div
      className={
        isNarrow
          ? 'fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-sand flex flex-col'
          : `bg-white border-t border-sand flex flex-col ${maximized ? 'flex-1 min-h-0' : 'shrink-0'}`
      }
      style={maximized ? undefined : { height: effectiveHeight }}
    >
      {/* Drag handle — desktop only, and not while maximized (resize is moot). */}
      {bottomPanelOpen && !isNarrow && !maximized && (
        <div
          className="h-1.5 shrink-0 flex items-center justify-center cursor-row-resize group hover:bg-sand"
          onMouseDown={handleDragStart}
        >
          <div className="w-8 h-0.5 rounded-full bg-sand group-hover:bg-warm-gray transition-colors" />
        </div>
      )}

      {/* Header — chevron + horizontally-scrollable tab strip + close button.
          The tab area scrolls on mobile so all tabs are reachable at 390 px. */}
      <div
        className="flex items-center h-10 shrink-0 border-b border-sand cursor-pointer select-none"
        onClick={() => toggleBottomPanel()}
      >
        <span className="text-xs text-warm-gray pl-3 pr-1 shrink-0">{bottomPanelOpen ? '▼' : '▲'}</span>

        {/* Scrollable tab strip — overflow-x-auto with hidden scrollbar */}
        <div
          className="flex-1 min-w-0 overflow-x-auto flex items-center [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
          <div className="flex items-center gap-1 min-[600px]:gap-4 px-1 min-[600px]:px-3">
            {(
              activeServerProjectId
                ? (['timetable', 'blocks', 'service-summary', 'validation', 'snapshots', 'publish', 'embed', 'audit'] as const)
                : (['timetable', 'blocks', 'service-summary', 'validation'] as const)
            ).map((tab) => {
              // Tab labels collapse on narrow viewports (<800 px — tablets and
              // the demo-capture window size). Shortens the two longest tabs so
              // the row doesn't wrap or overflow at the lower rail width.
              const labels: Record<string, string> = compactLabels
                ? {
                    timetable: 'Timetable',
                    blocks: 'Blocks',
                    stops: 'Stops',
                    'service-summary': 'Visualization',
                    validation: 'Validation',
                    snapshots: 'Snapshots',
                    publish: 'Share',
                    embed: 'Embed',
                    audit: 'Activity',
                  }
                : {
                    timetable: 'Timetable',
                    blocks: 'Blocks',
                    stops: 'Stops',
                    'service-summary': 'Visualization',
                    validation: 'Validation',
                    snapshots: 'Snapshots',
                    publish: 'Share & Publish',
                    embed: 'Embed',
                    audit: 'Activity',
                  };
              return (
                <button
                  key={tab}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBottomPanelTab(tab);
                    if (!bottomPanelOpen) toggleBottomPanel();
                  }}
                  className={`text-[13px] font-heading font-semibold px-2 min-[600px]:px-3 py-1 rounded-md transition-colors whitespace-nowrap
                    ${bottomPanelTab === tab && bottomPanelOpen
                      ? 'bg-coral-light text-coral'
                      : 'text-warm-gray hover:text-dark-brown'
                    }`}
                >
                  {labels[tab]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Maximize / restore — desktop only. Expands the rail to fill the
            editor (map row collapses) so the timetable / Gantt gets full height. */}
        {bottomPanelOpen && !isNarrow && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleBottomPanelMaximized(); }}
            className="w-7 h-7 shrink-0 flex items-center justify-center text-warm-gray hover:text-coral hover:bg-coral-light rounded-md transition-colors"
            title={maximized ? 'Restore split view' : 'Expand to full view'}
            aria-pressed={maximized}
          >
            {maximized ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 8V5a2 2 0 0 1 2-2h3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M21 16v3a2 2 0 0 1-2 2h-3" />
              </svg>
            )}
          </button>
        )}
        {bottomPanelOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().selectRoute(null);
              useStore.getState().setBottomPanelMaximized(false);
              useStore.getState().setBottomPanelOpen(false);
            }}
            className="w-7 h-7 mr-2 shrink-0 flex items-center justify-center text-warm-gray hover:text-red-500 hover:bg-red-50 rounded-md text-lg transition-colors"
            title="Close"
          >
            ×
          </button>
        )}
      </div>

      {/* Content */}
      {bottomPanelOpen && (
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          {bottomPanelTab === 'timetable' && <TimetableGrid />}
          {bottomPanelTab === 'blocks' && <BlockGantt />}
          {bottomPanelTab === 'service-summary' && <ServiceSummary />}
          {bottomPanelTab === 'validation' && <ValidationPanel />}
          {bottomPanelTab === 'snapshots' && activeServerProjectId && (
            <PaywallOverlay feature="snapshot_history" currentPlan={editorPlan}>
              <SnapshotHistoryPanel />
            </PaywallOverlay>
          )}
          {bottomPanelTab === 'publish' && activeServerProjectId && (
            <PaywallOverlay
              feature="managed_publishing"
              currentPlan={editorPlan}
              proIntentAction="publish_intent"
              proIntentSource="publish_tab"
            >
              <PublishWithDistribution />
            </PaywallOverlay>
          )}
          {bottomPanelTab === 'embed' && activeServerProjectId && (
            <PaywallOverlay
              feature="embeds"
              currentPlan={editorPlan}
              title="The embeddable rider site is a Pro feature"
              description="Host a rider-facing mini-site and copy-paste embeds (schedules, route maps, stop times) on any website."
              exampleHref="https://feeds.gtfsx.com/svt-demo/"
              exampleLabel="See a live example mini-site"
              proIntentAction="mini_site"
              proIntentSource="embed_tab"
            >
              <EmbedPanel />
            </PaywallOverlay>
          )}
          {bottomPanelTab === 'audit' && activeServerProjectId && <ProjectAuditPanel />}
        </div>
      )}

      {/* Full-page overlay during drag to maintain cursor and capture mouse */}
      {isDraggingState && (
        <div className="fixed inset-0 z-50 cursor-row-resize" />
      )}
    </div>
  );
}
