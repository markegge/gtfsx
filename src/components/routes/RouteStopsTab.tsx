import { useStore } from '../../store';
import { directionName } from '../../utils/constants';

export function RouteStopsTab() {
  const route = useStore((s) => s.routes.find((r) => r.route_id === s.editingRouteId));
  const routeStops = useStore((s) => s.routeStops);
  const stops = useStore((s) => s.stops);
  const setSidebarSection = useStore((s) => s.setSidebarSection);

  if (!route) return null;

  // Group route stops by direction
  const byDirection: Record<0 | 1, typeof routeStops> = { 0: [], 1: [] };
  for (const rs of routeStops) {
    if (rs.route_id !== route.route_id) continue;
    byDirection[rs.direction_id].push(rs);
  }
  byDirection[0].sort((a, b) => a.stop_sequence - b.stop_sequence);
  byDirection[1].sort((a, b) => a.stop_sequence - b.stop_sequence);

  const totalStops = new Set(
    [...byDirection[0], ...byDirection[1]].map((rs) => rs.stop_id),
  ).size;

  const renderDirection = (dir: 0 | 1) => {
    const list = byDirection[dir];
    if (list.length === 0) return null;
    return (
      <div className="mb-4" key={dir}>
        <div className="text-[11px] font-bold uppercase tracking-wide text-warm-gray mb-1.5">
          {directionName(route, dir)} · {list.length} stop{list.length !== 1 ? 's' : ''}
        </div>
        <ol className="flex flex-col gap-1">
          {list.map((rs) => {
            const stop = stops.find((s) => s.stop_id === rs.stop_id);
            return (
              <li
                key={`${rs.route_id}-${rs.stop_id}-${rs.direction_id}-${rs.stop_sequence}`}
                className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-cream text-sm"
              >
                <span className="text-[10px] font-mono text-warm-gray w-5 text-right tabular-nums">
                  {rs.stop_sequence}
                </span>
                <span className="text-dark-brown truncate">
                  {stop?.stop_name || rs.stop_id}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  };

  return (
    <div>
      {totalStops === 0 ? (
        <div className="rounded-lg bg-cream p-4 text-sm text-warm-gray">
          No stops added to this route yet.
        </div>
      ) : (
        <>
          {renderDirection(0)}
          {renderDirection(1)}
        </>
      )}
      <button
        onClick={() => setSidebarSection('stops')}
        className="w-full mt-1 px-4 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
      >
        Add or arrange stops →
      </button>
    </div>
  );
}
