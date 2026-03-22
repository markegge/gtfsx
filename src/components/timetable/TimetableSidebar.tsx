
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';

export function TimetableSidebar() {
  const { routes, selectedRouteId, selectRoute, setBottomPanelOpen, setBottomPanelTab, trips } = useStore();

  const handleOpenTimetable = (routeId: string) => {
    selectRoute(routeId);
    setBottomPanelOpen(true);
    setBottomPanelTab('timetable');
  };

  return (
    <div>
      <h3 className="font-heading font-bold text-base text-dark-brown mb-3">Timetables</h3>
      <p className="text-xs text-warm-gray mb-4">
        Select a route to view and edit its timetable in the bottom panel.
      </p>

      {routes.length === 0 ? (
        <EmptyState
          icon="📋"
          title="No timetable"
          description="Create routes and add stops first, then build timetables."
        />
      ) : (
        <div className="flex flex-col gap-1">
          {routes.map((route) => {
            const tripCount = trips.filter((t) => t.route_id === route.route_id).length;
            return (
              <button
                key={route.route_id}
                onClick={() => handleOpenTimetable(route.route_id)}
                className={`flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors text-left
                  ${selectedRouteId === route.route_id ? 'bg-coral-light' : 'hover:bg-cream'}`}
              >
                <div
                  className="w-3.5 h-3.5 rounded shrink-0"
                  style={{ backgroundColor: `#${route.route_color}` }}
                />
                <div className="flex-1 min-w-0">
                  <span className="font-semibold text-sm text-dark-brown truncate block">
                    {route.route_short_name || route.route_long_name || 'Untitled'}
                  </span>
                </div>
                <span className="text-[11px] text-warm-gray shrink-0">
                  {tripCount} trips
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
