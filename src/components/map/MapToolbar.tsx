import { useStore } from '../../store';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';

/**
 * Ensure there's an active route to draw on / place stops against.
 * If one is already selected, reuse it; if there's exactly one in the feed,
 * select that; otherwise create a new blank route.
 */
function ensureActiveRoute(): string {
  const state = useStore.getState();
  if (state.selectedRouteId && state.routes.some((r) => r.route_id === state.selectedRouteId)) {
    return state.selectedRouteId;
  }
  if (state.routes.length === 1) {
    state.selectRoute(state.routes[0].route_id);
    return state.routes[0].route_id;
  }

  const usedColors = state.routes.map((r) => r.route_color);
  const nextColor = ROUTE_COLORS.find((c) => !usedColors.includes(c)) || ROUTE_COLORS[0];
  const id = generateId('route');
  state.addRoute({
    route_id: id,
    agency_id: state.agencies[0]?.agency_id || '',
    route_short_name: '',
    route_long_name: '',
    route_type: 3,
    route_color: nextColor,
    route_text_color: getContrastTextColor(nextColor),
  });
  state.selectRoute(id);
  return id;
}

export function MapToolbar() {
  const mapMode = useStore((s) => s.mapMode);

  const handleDrawRoute = () => {
    const state = useStore.getState();
    const routeId = ensureActiveRoute();
    window.__drawingDirection = state.stopPlacementDirection;
    state.setDrawingRouteId(routeId);
    state.setEditingRouteId(routeId);
    state.setSidebarSection('routes');
    state.setMapMode('draw_route');
  };

  const handlePlaceStop = () => {
    const state = useStore.getState();
    ensureActiveRoute();
    state.setSidebarSection('stops');
    state.setMapMode('place_stop');
  };

  const handleSelect = () => {
    useStore.getState().setMapMode('select');
  };

  const tools = [
    { mode: 'select' as const, icon: '☞', title: 'Select', onClick: handleSelect },
    { mode: 'draw_route' as const, icon: '✎', title: 'Draw Route', onClick: handleDrawRoute },
    { mode: 'place_stop' as const, icon: '●', title: 'Add Stop', onClick: handlePlaceStop },
  ];

  return (
    <div className="absolute top-3 right-3 flex flex-col gap-1 bg-white rounded-xl shadow-md p-1.5 z-10">
      {tools.map(({ mode, icon, title, onClick }) => (
        <button
          key={mode}
          title={title}
          onClick={onClick}
          className={`w-9 h-9 rounded-lg flex items-center justify-center text-base transition-colors
            ${mapMode === mode
              ? 'bg-coral-light text-coral'
              : 'text-brown hover:bg-cream'
            }`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
