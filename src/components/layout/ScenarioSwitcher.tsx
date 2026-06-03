import { useState } from 'react';
import { useStore } from '../../store';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

/** True when two route-id sets contain exactly the same ids (order-independent). */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((id) => sb.has(id));
}

/**
 * Header-bar switcher for saved route-visibility scenarios. Renders nothing
 * until at least one scenario exists (so the editor's "GTFS Editor • Route
 * Planner" tagline shows by default). Picking a scenario applies its hidden-
 * route set, which the map and every analysis panel react to live. The active
 * label is DERIVED by matching the current visibility against the saved sets —
 * no separate "active" state to keep in sync, so a manual route toggle simply
 * reads as "Custom view".
 */
export function ScenarioSwitcher() {
  const visibilitySets = useStore((s) => s.visibilitySets);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  const applyVisibilitySet = useStore((s) => s.applyVisibilitySet);
  const deleteVisibilitySet = useStore((s) => s.deleteVisibilitySet);
  const setHiddenRouteIds = useStore((s) => s.setHiddenRouteIds);
  const plan = useEditorPlan();
  const [open, setOpen] = useState(false);

  // Scenarios are an Agency+ feature; the switcher never renders for free/pro
  // users (the server enforces the real gate). Also self-hides until at least
  // one scenario exists so the editor's tagline shows by default.
  if (!planHasFeature(plan, 'scenarios') || visibilitySets.length === 0) return null;

  const activeSet = visibilitySets.find((v) => sameIds(v.hiddenRouteIds, hiddenRouteIds));
  const allVisible = hiddenRouteIds.length === 0;
  const label = activeSet ? activeSet.name : allVisible ? 'All routes' : 'Custom view';

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium text-dark-brown border border-sand hover:bg-cream transition-colors max-w-[11rem]"
        title="Switch scenario (saved route-visibility set)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-teal">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
        <span className="truncate">{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-warm-gray">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 top-full mt-1 z-40 w-60 bg-white border border-sand rounded-xl shadow-lg p-1.5 flex flex-col">
            <div className="px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-warm-gray">Scenarios</div>
            <button
              onClick={() => { setHiddenRouteIds([]); setOpen(false); }}
              className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left text-dark-brown hover:bg-cream transition-colors"
            >
              <span className="w-3.5 shrink-0 text-teal">{allVisible && !activeSet ? '✓' : ''}</span>
              All routes
            </button>
            {visibilitySets.map((v) => (
              <div key={v.id} className="group flex items-center rounded-md hover:bg-cream transition-colors">
                <button
                  onClick={() => { applyVisibilitySet(v.id); setOpen(false); }}
                  className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-sm text-left text-dark-brown"
                >
                  <span className="w-3.5 shrink-0 text-teal">{activeSet?.id === v.id ? '✓' : ''}</span>
                  <span className="truncate">{v.name}</span>
                </button>
                <button
                  onClick={() => deleteVisibilitySet(v.id)}
                  title="Delete scenario"
                  aria-label={`Delete scenario ${v.name}`}
                  className="px-2 py-1.5 text-warm-gray hover:text-red-600 transition-colors shrink-0"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
