
import { useEffect } from 'react';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import { RouteEditor } from './RouteEditor';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES } from '../../utils/constants';

export function RouteList() {
  const {
    routes, addRoute, trips, routeStops,
    selectedRouteId, selectRoute,
    editingRouteId, setEditingRouteId,
    hiddenRouteIds, toggleRouteVisibility,
  } = useStore();

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

  // If editing a route, show the dedicated editor
  if (editingRouteId && routes.some((r) => r.route_id === editingRouteId) && selectedRouteId === editingRouteId) {
    return <RouteEditor />;
  }

  // Otherwise show the route list
  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-3">Routes</h3>

      {routes.length === 0 ? (
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
            Routes ({routes.length})
          </div>
          <div className="flex flex-col gap-1 mb-3">
            {routes.map((route) => {
              const tripCount = trips.filter((t) => t.route_id === route.route_id).length;
              const stopCount = new Set(
                routeStops.filter((rs) => rs.route_id === route.route_id).map((rs) => rs.stop_id)
              ).size;

              const isHidden = hiddenRouteIds.includes(route.route_id);

              return (
                <div
                  key={route.route_id}
                  onClick={() => selectRoute(route.route_id)}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-lg transition-colors cursor-pointer group
                    ${selectedRouteId === route.route_id ? 'bg-sand' : 'hover:bg-cream'}`}
                >
                  {/* Color swatch — click to toggle route visibility */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRouteVisibility(route.route_id);
                    }}
                    className={`w-3.5 h-3.5 rounded shrink-0 transition-all border-2
                      ${isHidden
                        ? 'opacity-30 border-warm-gray'
                        : 'opacity-100 border-transparent hover:scale-125'
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
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(route.route_id);
                    }}
                    className="px-2 py-1 rounded text-[11px] font-semibold text-warm-gray
                      opacity-0 group-hover:opacity-100 hover:bg-coral-light hover:text-coral transition-all"
                  >
                    Edit
                  </button>
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
        </>
      )}
    </div>
  );
}
