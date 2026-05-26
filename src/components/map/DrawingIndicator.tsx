import { useMemo } from 'react';
import { useStore } from '../../store';
import { directionName } from '../../utils/constants';

export function DrawingIndicator() {
  const mapMode = useStore((s) => s.mapMode);

  if (mapMode === 'select') return null;

  // place_stop renders the pill + a compact dialog (route assignment, snap
  // toggle, optional name) — all the inputs the placement reads, anchored
  // right under the banner so the user doesn't have to dig in a side panel.
  if (mapMode === 'place_stop') {
    return (
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
        <div className="bg-coral text-white px-5 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2">
          <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
          Click to place a stop
        </div>
        <PlaceStopDialog />
      </div>
    );
  }

  const messages: Record<string, string> = {
    draw_route: 'Drawing Route Shape — Click to add points, double-click to finish',
    edit_vertices: 'Editing Shape — Drag vertices to adjust',
    move_stop: 'Moving Stop — Click the map or drag the stop to reposition. Press Esc to cancel.',
    edit_shape: 'Editing Shape — Drag vertices, click midpoints to add, Delete key to remove. Click Save when done.',
    draw_flex_zone: 'Drawing Flex Zone — Click to add vertices, double-click to close polygon',
    edit_flex_zone: 'Editing Flex Zone — Drag vertices, click midpoints to add, Delete key to remove',
  };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-coral text-white px-5 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2 z-10">
      <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
      {messages[mapMode]}
    </div>
  );
}

/** Compact panel anchored under the "Click to place a stop" banner. Lets
 *  the user pick the route+shape the next stop attaches to (default = the
 *  most recently drawn shape), toggle snap-to-route, and type an optional
 *  name (used once, then cleared automatically after placement). */
function PlaceStopDialog() {
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const shapes = useStore((s) => s.shapes);
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const stopPlacementMode = useStore((s) => s.stopPlacementMode);
  const setStopPlacementMode = useStore((s) => s.setStopPlacementMode);
  const stopPlacementDirection = useStore((s) => s.stopPlacementDirection);
  const setStopPlacementDirection = useStore((s) => s.setStopPlacementDirection);
  const selectRoute = useStore((s) => s.selectRoute);
  const nextStopName = useStore((s) => s.nextStopName);
  const setNextStopName = useStore((s) => s.setNextStopName);

  // One option per (route, direction) that actually has a shape. Stable
  // labels even when the same route has shapes in both directions.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{
      key: string;
      routeId: string;
      directionId: 0 | 1;
      label: string;
      color: string;
    }> = [];
    for (const shape of shapes) {
      const trip = trips.find((t) => t.shape_id === shape.shape_id);
      if (!trip) continue;
      const route = routes.find((r) => r.route_id === trip.route_id);
      if (!route) continue;
      const k = `${route.route_id}__${trip.direction_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const name = route.route_short_name || route.route_long_name || route.route_id;
      out.push({
        key: k,
        routeId: route.route_id,
        directionId: trip.direction_id,
        label: `${name} — ${directionName(route, trip.direction_id)}`,
        color: route.route_color,
      });
    }
    return out;
  }, [shapes, trips, routes]);

  const currentKey =
    selectedRouteId
      ? `${selectedRouteId}__${stopPlacementDirection}`
      : '';
  const hasRoute = options.some((o) => o.key === currentKey);

  return (
    <div
      className="bg-white rounded-xl shadow-lg border border-sand px-3 py-2.5 flex flex-col gap-2 w-[min(92vw,320px)]"
      // Keep map clicks from leaking through the dialog (placing a stop under it).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <label className="text-[10px] font-semibold text-warm-gray uppercase tracking-wide">
        Assign to
      </label>
      <select
        value={currentKey}
        onChange={(e) => {
          const k = e.target.value;
          if (!k) {
            selectRoute(null);
            return;
          }
          const opt = options.find((o) => o.key === k);
          if (!opt) return;
          selectRoute(opt.routeId);
          setStopPlacementDirection(opt.directionId);
        }}
        className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
      >
        <option value="">(No route — freehand)</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>

      {/* Snap-to-route only matters when a route is selected. */}
      {hasRoute && (
        <label className="flex items-center gap-2 text-xs text-dark-brown cursor-pointer select-none">
          <input
            type="checkbox"
            checked={stopPlacementMode === 'snap_to_route'}
            onChange={(e) =>
              setStopPlacementMode(e.target.checked ? 'snap_to_route' : 'freehand')
            }
            className="accent-coral"
          />
          Snap to route shape
        </label>
      )}

      <input
        type="text"
        value={nextStopName ?? ''}
        onChange={(e) => setNextStopName(e.target.value || null)}
        placeholder="Name (optional — cleared after placement)"
        className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
      />
    </div>
  );
}
