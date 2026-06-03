
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { RouteDetailPanel } from './RouteDetailPanel';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES } from '../../utils/constants';
import { useEditorPlan } from '../billing/useEditorPlan';
import { planHasFeature } from '../billing/planConfig';

/** True when two route-id sets contain exactly the same ids (order-independent). */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((id) => sb.has(id));
}

export function RouteList() {
  const {
    routes, addRoute, trips, routeStops,
    selectedRouteId, selectRoute,
    editingRouteId, setEditingRouteId,
    hiddenRouteIds, toggleRouteVisibility,
    hiddenRouteTypes, toggleRouteType,
    visibilitySets, saveVisibilitySet,
    applyVisibilitySet, renameVisibilitySet, deleteVisibilitySet,
  } = useStore();
  const flexZones = useStore((s) => s.flexZones);

  // Scenarios (save/switch/manage named route-visibility sets) are an Agency+
  // feature; free/pro users see a compact upsell instead of the controls.
  const plan = useEditorPlan();
  const canUseScenarios = planHasFeature(plan, 'scenarios');

  // Quick text filter (short name / long name / description).
  const [text, setText] = useState('');
  // Inline "save current visibility as a scenario" form.
  const [savingScenario, setSavingScenario] = useState(false);
  const [scenarioName, setScenarioName] = useState('');
  // Inline rename of an existing scenario (managed list below the save button).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  const commitScenario = () => {
    saveVisibilitySet(scenarioName);
    setSavingScenario(false);
    setScenarioName('');
  };

  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameText(current);
  };
  const commitRename = () => {
    if (renamingId) renameVisibilitySet(renamingId, renameText);
    setRenamingId(null);
    setRenameText('');
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameText('');
  };

  // Flex zones are materialized as routes (route_type 3, "… (Flex)") so they
  // export cleanly and the validator sees them, but they're created/edited/
  // deleted in the Flex Zones panel — keep them out of the Routes list so they
  // don't read as regular routes here.
  const managedRoutes = useMemo(() => {
    const flexRouteIds = new Set(flexZones.map((z) => z.routeId).filter(Boolean));
    return routes.filter((r) => !flexRouteIds.has(r.route_id));
  }, [routes, flexZones]);

  // Distinct route_types present in the feed, in a stable order. The type
  // pillbox only appears when there's more than one mode to filter between.
  const presentTypes = useMemo(
    () => [...new Set(managedRoutes.map((r) => r.route_type))].sort((a, b) => a - b),
    [managedRoutes],
  );

  const filteredRoutes = useMemo(() => {
    const q = text.trim().toLowerCase();
    return managedRoutes.filter((r) => {
      if (hiddenRouteTypes.includes(r.route_type)) return false;
      if (!q) return true;
      return (
        r.route_short_name?.toLowerCase().includes(q) ||
        r.route_long_name?.toLowerCase().includes(q) ||
        r.route_desc?.toLowerCase().includes(q)
      );
    });
  }, [managedRoutes, hiddenRouteTypes, text]);

  const handleAdd = () => {
    const usedColors = routes.map((r) => r.route_color);
    const nextColor = ROUTE_COLORS.find((c) => !usedColors.includes(c)) || ROUTE_COLORS[0];
    const id = generateId('route');
    addRoute({
      route_id: id,
      agency_id: useStore.getState().agencies[0]?.agency_id || '',
      route_short_name: '',
      route_long_name: '',
      route_type: 3,
      route_color: nextColor,
      route_text_color: getContrastTextColor(nextColor),
    });
    selectRoute(id);
    setEditingRouteId(id);
  };

  const handleEdit = (routeId: string) => {
    selectRoute(routeId);
    setEditingRouteId(routeId);
  };

  // Clear stale editingRouteId if the route no longer exists or isn't selected
  useEffect(() => {
    if (editingRouteId) {
      const exists = routes.some((r) => r.route_id === editingRouteId);
      if (!exists || selectedRouteId !== editingRouteId) {
        setEditingRouteId(null);
      }
    }
  }, [editingRouteId, routes, selectedRouteId, setEditingRouteId]);

  // If editing a route, show the dedicated editor (tabs handled at the rail level)
  if (editingRouteId && routes.some((r) => r.route_id === editingRouteId) && selectedRouteId === editingRouteId) {
    return <RouteDetailPanel />;
  }

  // Otherwise show the route list
  return (
    <div>
      {managedRoutes.length === 0 ? (
        <EmptyState
          icon="🗺️"
          title="No routes yet"
          description="Create a route to start drawing paths and building timetables."
          actionLabel="Create Route"
          onAction={handleAdd}
        />
      ) : (
        <>
          <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
            Routes ({filteredRoutes.length === managedRoutes.length ? managedRoutes.length : `${filteredRoutes.length} of ${managedRoutes.length}`})
          </div>

          {/* Quick text filter */}
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter routes…"
            className="w-full mb-2 px-2.5 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
          />

          {/* Route-type pillbox — only when more than one mode is present */}
          {presentTypes.length > 1 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {presentTypes.map((t) => {
                const active = !hiddenRouteTypes.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleRouteType(t)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors
                      ${active
                        ? 'bg-coral text-white border-coral'
                        : 'bg-white text-warm-gray border-sand hover:border-coral hover:text-dark-brown'}`}
                    title={active ? 'Filtering on — click to hide this type' : 'Hidden — click to show'}
                  >
                    {ROUTE_TYPES[t] || `Type ${t}`}
                  </button>
                );
              })}
            </div>
          )}

          {/* Column header: the eye marks the swatch column as the map-visibility toggle.
              px-2.5 matches each row's left padding; the w-5 box centers the eye over the swatch. */}
          {filteredRoutes.length > 0 && (
            <div className="flex items-center px-2.5 mb-1 text-warm-gray">
              <div className="flex w-5 items-center justify-center shrink-0">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <title>Click a swatch to show / hide that route on the map</title>
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
              <span className="ml-2 text-[10px] uppercase tracking-wide">Map</span>
            </div>
          )}

          <div className="flex flex-col gap-1 mb-3">
            {filteredRoutes.length === 0 && (
              <EmptyState
                icon="🔍"
                title="No routes match these filters"
                description="Loosen the type or text filter above to see more routes."
              />
            )}
            {filteredRoutes.map((route) => {
              const tripCount = trips.filter((t) => t.route_id === route.route_id).length;
              const stopCount = new Set(
                routeStops.filter((rs) => rs.route_id === route.route_id).map((rs) => rs.stop_id)
              ).size;

              const isHidden = hiddenRouteIds.includes(route.route_id);

              return (
                <div
                  key={route.route_id}
                  onClick={() => handleEdit(route.route_id)}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg transition-colors cursor-pointer
                    ${selectedRouteId === route.route_id ? 'bg-sand' : 'hover:bg-cream'}`}
                >
                  {/* Color swatch — click to toggle route visibility */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRouteVisibility(route.route_id);
                    }}
                    className={`w-5 h-5 rounded-md shrink-0 transition-all border-2
                      ${isHidden
                        ? 'opacity-40 border-warm-gray hover:opacity-70'
                        : 'opacity-100 border-transparent hover:scale-110'
                      }`}
                    style={{ backgroundColor: isHidden ? 'transparent' : `#${route.route_color}`, borderColor: isHidden ? `#${route.route_color}` : 'transparent' }}
                    title={isHidden ? 'Show on map' : 'Hide from map'}
                  />
                  <div className={`flex flex-col min-w-0 flex-1 transition-opacity ${isHidden ? 'opacity-40' : ''}`}>
                    <span className="font-semibold text-sm text-dark-brown truncate">
                      {route.route_short_name || route.route_long_name || 'Untitled Route'}
                    </span>
                    <span className="text-[11px] text-warm-gray">
                      {ROUTE_TYPES[route.route_type] || 'Transit'}
                      {stopCount > 0 && ` · ${stopCount} stops`}
                      {tripCount > 0 && ` · ${tripCount} trips`}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          <button
            onClick={handleAdd}
            className="w-full flex items-center gap-1.5 px-3 py-2 border-2 border-dashed border-sand rounded-lg text-sm font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors"
          >
            + Add Route
          </button>

          {/* Scenarios — save the routes currently shown (toggle others off with
              the colour swatches) as a named visibility set you can switch
              between from the header bar. Agency+ only; free/pro see an upsell. */}
          <div className="mt-3 pt-3 border-t border-sand">
            {!canUseScenarios ? (
              <Link
                to="/pricing?feature=scenarios"
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-warm-gray hover:text-teal hover:bg-teal-light transition-colors"
                title="Save and switch between route-visibility scenarios — an Agency plan feature"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Save view as scenario</span>
                <span className="text-[10px] font-bold uppercase tracking-wide bg-cream text-warm-gray px-1.5 py-0.5 rounded border border-sand">
                  Agency
                </span>
              </Link>
            ) : (
              <>
                {savingScenario ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={scenarioName}
                      onChange={(e) => setScenarioName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitScenario();
                        if (e.key === 'Escape') { setSavingScenario(false); setScenarioName(''); }
                      }}
                      placeholder="Scenario name"
                      className="flex-1 min-w-0 px-2.5 py-1.5 border-2 border-teal rounded-lg text-xs bg-white focus:outline-none"
                    />
                    <button
                      onClick={commitScenario}
                      className="px-2.5 py-1.5 bg-teal text-white rounded-lg text-xs font-bold hover:opacity-90 transition-opacity shrink-0"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setSavingScenario(false); setScenarioName(''); }}
                      className="px-1.5 py-1.5 text-warm-gray text-xs hover:text-coral shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setScenarioName(`Scenario ${visibilitySets.length + 1}`); setSavingScenario(true); }}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-warm-gray hover:text-teal hover:bg-teal-light transition-colors"
                    title="Save the routes currently shown as a scenario you can switch to from the header"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <polygon points="12 2 2 7 12 12 22 7 12 2" />
                      <polyline points="2 17 12 22 22 17" />
                      <polyline points="2 12 12 17 22 12" />
                    </svg>
                    Save current view as scenario
                  </button>
                )}

                {/* Managed list — apply / rename / delete each saved scenario. */}
                {visibilitySets.length > 0 && (
                  <div className="mt-2 flex flex-col gap-0.5">
                    <div className="px-1 mb-0.5 text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Saved scenarios
                    </div>
                    {visibilitySets.map((v) => {
                      const isActive = sameIds(v.hiddenRouteIds, hiddenRouteIds);
                      if (renamingId === v.id) {
                        return (
                          <div key={v.id} className="flex items-center gap-1.5 px-1 py-1">
                            <input
                              autoFocus
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename();
                                if (e.key === 'Escape') cancelRename();
                              }}
                              onBlur={commitRename}
                              className="flex-1 min-w-0 px-2 py-1 border-2 border-teal rounded-md text-xs bg-white focus:outline-none"
                            />
                            <button
                              onClick={commitRename}
                              className="px-2 py-1 bg-teal text-white rounded-md text-xs font-bold hover:opacity-90 transition-opacity shrink-0"
                            >
                              Save
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={v.id}
                          className={`group flex items-center gap-1 rounded-md transition-colors ${isActive ? 'bg-teal-light' : 'hover:bg-cream'}`}
                        >
                          <button
                            onClick={() => applyVisibilitySet(v.id)}
                            className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 text-left"
                            title={isActive ? 'Currently applied' : 'Apply this scenario'}
                          >
                            <span className={`w-3 shrink-0 text-center text-teal ${isActive ? '' : 'opacity-0'}`}>✓</span>
                            <span className="truncate text-xs font-medium text-dark-brown">{v.name}</span>
                          </button>
                          <button
                            onClick={() => startRename(v.id, v.name)}
                            title="Rename scenario"
                            aria-label={`Rename scenario ${v.name}`}
                            className="px-1.5 py-1.5 text-warm-gray hover:text-teal transition-colors shrink-0"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => deleteVisibilitySet(v.id)}
                            title="Delete scenario"
                            aria-label={`Delete scenario ${v.name}`}
                            className="px-1.5 py-1.5 text-warm-gray hover:text-red-600 transition-colors shrink-0"
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
