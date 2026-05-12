
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { TimetableGrid } from '../timetable/TimetableGrid';
import { StopDepartures } from '../timetable/StopDepartures';
import { ServiceSummary } from '../timetable/ServiceSummary';
import { ValidationPanel } from '../validation/ValidationPanel';
import { VersionHistoryPanel } from '../versions/VersionHistoryPanel';
import { PublishWithDistribution } from '../distribution/PublishWithDistribution';
import { EmbedPanel } from '../embed/EmbedPanel';
import { ProjectAuditPanel } from '../audit/ProjectAuditPanel';
import { PaywallOverlay } from '../billing/PaywallOverlay';
import { useEditorPlan } from '../billing/useEditorPlan';

const MIN_HEIGHT = 120;
const MAX_HEIGHT_FRACTION = 0.75; // max 75% of viewport

function getDefaultHeight() {
  return Math.round(window.innerHeight * 0.33);
}

export function BottomPanel() {
  const { bottomPanelOpen, bottomPanelTab, setBottomPanelTab, toggleBottomPanel } = useStore();
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);
  const editorPlan = useEditorPlan();
  const [panelHeight, setPanelHeight] = useState(getDefaultHeight);
  const [isDraggingState, setIsDraggingState] = useState(false);
  const isDragging = useRef(false);

  // Trigger map resize when panel opens/closes
  useEffect(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }, [bottomPanelOpen]);

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

  return (
    <div
      className="bg-white border-t border-sand flex flex-col shrink-0"
      style={{ height: bottomPanelOpen ? panelHeight : 40 }}
    >
      {/* Drag handle — only rendered when open */}
      {bottomPanelOpen && (
        <div
          className="h-1.5 shrink-0 flex items-center justify-center cursor-row-resize group hover:bg-sand"
          onMouseDown={handleDragStart}
        >
          <div className="w-8 h-0.5 rounded-full bg-sand group-hover:bg-warm-gray transition-colors" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center px-4 h-10 gap-4 shrink-0 border-b border-sand cursor-pointer select-none"
        onClick={() => toggleBottomPanel()}
      >
        <span className="text-xs text-warm-gray">{bottomPanelOpen ? '▼' : '▲'}</span>
        {(
          activeServerProjectId
            ? (['timetable', 'stops', 'service-summary', 'validation', 'versions', 'publish', 'embed', 'audit'] as const)
            : (['timetable', 'stops', 'service-summary', 'validation'] as const)
        ).map((tab) => {
          const labels: Record<string, string> = {
            timetable: 'Timetable',
            stops: 'Stops',
            'service-summary': 'Service Summary',
            validation: 'Validation',
            versions: 'Versions',
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
              className={`text-[13px] font-heading font-semibold px-3 py-1 rounded-md transition-colors
                ${bottomPanelTab === tab && bottomPanelOpen
                  ? 'bg-coral-light text-coral'
                  : 'text-warm-gray hover:text-dark-brown'
                }`}
            >
              {labels[tab]}
            </button>
          );
        })}
        {bottomPanelOpen && (
          <>
            <div className="flex-1" />
            <button
              onClick={(e) => {
                e.stopPropagation();
                useStore.getState().selectRoute(null);
                useStore.getState().setBottomPanelOpen(false);
              }}
              className="w-7 h-7 flex items-center justify-center text-warm-gray hover:text-red-500 hover:bg-red-50 rounded-md text-lg transition-colors"
              title="Close"
            >
              ×
            </button>
          </>
        )}
      </div>

      {/* Content */}
      {bottomPanelOpen && (
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          {bottomPanelTab === 'timetable' && <TimetableGrid />}
          {bottomPanelTab === 'stops' && <StopDepartures />}
          {bottomPanelTab === 'service-summary' && <ServiceSummary />}
          {bottomPanelTab === 'validation' && <ValidationPanel />}
          {bottomPanelTab === 'versions' && activeServerProjectId && <VersionHistoryPanel />}
          {bottomPanelTab === 'publish' && activeServerProjectId && (
            <PaywallOverlay feature="managed_publishing" currentPlan={editorPlan}>
              <PublishWithDistribution />
            </PaywallOverlay>
          )}
          {bottomPanelTab === 'embed' && activeServerProjectId && (
            <PaywallOverlay feature="embeds" currentPlan={editorPlan}>
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
