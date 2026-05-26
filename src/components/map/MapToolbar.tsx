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
    // Toggle off — clicking Draw Route while already in draw_route mode exits
    // without drawing anything. The typical exit is still draw + double-click;
    // this is the escape hatch when you opened the mode by mistake.
    if (state.mapMode === 'draw_route') {
      window.__cancelDrawRoute?.();
      return;
    }
    const routeId = ensureActiveRoute();
    window.__drawingDirection = state.stopPlacementDirection;
    state.setDrawingRouteId(routeId);
    state.setEditingRouteId(routeId);
    state.setSidebarSection('routes');
    state.setMapMode('draw_route');
  };

  const handlePlaceStop = () => {
    const state = useStore.getState();
    // Toggle off — clicking Add Stop while already in place_stop mode exits
    // back to select, so the user has a one-click "I'm done placing" gesture.
    if (state.mapMode === 'place_stop') {
      state.setMapMode('select');
      return;
    }
    // If we're coming from Draw Route, discard the in-progress line and reset
    // the draw control. Otherwise mapbox-gl-draw stays in draw_line_string and
    // keeps capturing clicks, leaving the user effectively still in draw mode.
    if (state.mapMode === 'draw_route') {
      window.__cancelDrawRoute?.();
    }
    ensureActiveRoute();
    state.setSidebarSection('stops');
    state.setMapMode('place_stop');
  };

  const handleSelect = () => {
    const state = useStore.getState();
    // Same cleanup as Add Stop — clicking Select while drawing should fully
    // exit draw_route (clear partial line + drawingRouteId), not just toggle
    // the store mode while mapbox-gl-draw keeps eating clicks.
    if (state.mapMode === 'draw_route') {
      window.__cancelDrawRoute?.();
      return;
    }
    state.setMapMode('select');
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
