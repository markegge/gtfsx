
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { RouteDetailPanel } from './RouteDetailPanel';
import { FlexRouteSection } from './FlexRouteSection';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES } from '../../utils/constants';

export function RouteList() {
  const {
    routes, addRoute, trips, routeStops,
    selectedRouteId, selectRoute,
    editingRouteId, setEditingRouteId,
    hiddenRouteIds, toggleRouteVisibility, setHiddenRouteIds,
    hiddenRouteTypes, toggleRouteType,
  } = useStore();
  const flexZones = useStore((s) => s.flexZones);
  // Signed-in users can pull routes from their other feeds. Surface that entry
  // point here (not only behind the top-bar Import button) so cross-feed route
  // import is discoverable where routes are built. The dialog lives in TopBar,
  // so we request it through the UI store seeded to the "my feeds" tab.
  const currentUser = useStore((s) => s.currentUser);
  const requestImportDialog = useStore((s) => s.requestImportDialog);

  // Quick text filter (short name / long name / description).
  const [text, setText] = useState('');

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
      {managedRoutes.length === 0 && flexZones.length === 0 ? (
        <EmptyState
          icon="🗺️"
          title="No routes yet"
          description="Create a route to start drawing paths and building timetables."
          actionLabel="Create Route"
          onAction={handleAdd}
        />
      ) : (
        <>
          {managedRoutes.length > 0 && (
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
            <div className="flex items-center justify-between px-2.5 mb-1 text-warm-gray">
              <div className="flex items-center">
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
              {/* Bulk visibility shortcuts — show/hide every route in this panel
                  on the map at once (operates on all managed routes regardless of
                  the text/type filter). "Show all" clears the whole hidden set;
                  Flex zones carry their own visibility in the Flex section. */}
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
                <button
                  type="button"
                  onClick={() => setHiddenRouteIds([])}
                  className="hover:text-coral transition-colors"
                  title="Show all routes on the map"
                >
                  Show all
                </button>
                <span className="text-sand" aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setHiddenRouteIds(managedRoutes.map((r) => r.route_id))}
                  className="hover:text-coral transition-colors"
                  title="Hide all routes from the map"
                >
                  Hide all
                </button>
              </div>
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
          </>
          )}

          <button
            onClick={handleAdd}
            className="w-full flex items-center gap-1.5 px-3 py-2 border-2 border-dashed border-sand rounded-lg text-sm font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors"
          >
            + Add Route
          </button>

          {/* Import routes from another of your feeds. Signed-in only (anon
              users have no feeds of their own). Opens the Import dialog straight
              on the "Routes from my feeds" tab. */}
          {currentUser && (
            <button
              onClick={() => requestImportDialog('myfeeds')}
              className="w-full mt-2 flex items-center gap-1.5 px-3 py-2 border-2 border-dashed border-sand rounded-lg text-sm font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors"
            >
              + Import from another feed
            </button>
          )}

          <FlexRouteSection filterText={text} />
        </>
      )}
    </div>
  );
}
