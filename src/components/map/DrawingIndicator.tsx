import { useMemo } from 'react';
import { useStore } from '../../store';
import { directionName } from '../../utils/constants';
import { shapeEditLabel } from './shapeEditLabel';

export function DrawingIndicator() {
  const mapMode = useStore((s) => s.mapMode);
  const setMapMode = useStore((s) => s.setMapMode);
  const editingShapeId = useStore((s) => s.editingShapeId);
  const shapes = useStore((s) => s.shapes);
  const trips = useStore((s) => s.trips);
  const routes = useStore((s) => s.routes);

  // "{route} · {shape}" label for the shape-edit banners (null → generic).
  const editingLabel = useMemo(
    () => shapeEditLabel(editingShapeId, shapes, trips, routes),
    [editingShapeId, shapes, trips, routes],
  );
  const editingPrefix = editingLabel ? `Editing ${editingLabel}` : 'Editing Shape';

  if (mapMode === 'select') return null;
  // edit_shape's banner is rendered together with the Save Shape / Cancel
  // buttons by MapView, so they sit in a single top-center cluster instead
  // of separately. Skip here so we don't render the banner twice.
  if (mapMode === 'edit_shape') return null;

  // place_stop renders the pill + a compact dialog (route assignment, snap
  // toggle, optional name) — all the inputs the placement reads, anchored
  // right under the banner so the user doesn't have to dig in a side panel.
  if (mapMode === 'place_stop') {
    return (
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2">
        <div className="flex items-center gap-2">
          <div className="bg-coral text-white px-5 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full animate-pulse" />
            Click to place a stop
          </div>
          <button
            onClick={() => setMapMode('select')}
            title="Finish placing stops"
            className="bg-white text-coral border border-coral px-4 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md hover:bg-coral hover:text-white transition-colors"
          >
            Done
          </button>
        </div>
        <PlaceStopDialog />
      </div>
    );
  }

  // draw_route renders the banner plus a target dropdown (new route — default —
  // or an existing route the shape attaches to), anchored under the banner.
  if (mapMode === 'draw_route') {
    return (
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-2 w-[min(92vw,480px)]">
        <div className="bg-coral text-white px-4 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2 text-center">
          <div className="w-2 h-2 bg-white rounded-full animate-pulse shrink-0" />
          <span className="max-[600px]:hidden">Drawing Route Shape — Click to add points, double-click to finish</span>
          <span className="min-[601px]:hidden">Drawing route — double-click to finish</span>
        </div>
        <DrawRouteTargetDialog />
      </div>
    );
  }

  const messages: Record<string, string> = {
    edit_vertices: `${editingPrefix} — Drag vertices to adjust`,
    move_stop: 'Moving Stop — Click map to reposition',
    edit_shape: `${editingPrefix} — Drag vertices, click midpoints to add, Delete to remove`,
    trim_shape: 'Trimming Shape — Click a point to cut',
    draw_flex_zone: 'Drawing Flex Zone — Click to add vertices, double-click to close',
    edit_flex_zone: 'Editing Flex Zone — Drag vertices to adjust',
  };

  const messagesFull: Record<string, string> = {
    edit_vertices: `${editingPrefix} — Drag vertices to adjust`,
    move_stop: 'Moving Stop — Click the map or drag the stop to reposition. Press Esc to cancel.',
    edit_shape: `${editingPrefix} — Drag vertices, click midpoints to add, Delete key to remove. Click Save when done.`,
    trim_shape: 'Trimming Shape — Click a point on the shape to set the cut',
    draw_flex_zone: 'Drawing Flex Zone — Click to add vertices, double-click to close polygon',
    edit_flex_zone: 'Editing Flex Zone — Drag vertices, click midpoints to add, Delete key to remove',
  };

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-coral text-white px-4 py-2 rounded-full text-[13px] font-heading font-semibold shadow-md flex items-center gap-2 z-10 max-w-[min(92vw,480px)] text-center">
      <div className="w-2 h-2 bg-white rounded-full animate-pulse shrink-0" />
      <span className="max-[600px]:hidden">{messagesFull[mapMode]}</span>
      <span className="min-[601px]:hidden">{messages[mapMode]}</span>
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

  // One option per (route, direction) that actually has a shape. A freshly
  // drawn shape has no trip, so its direction is unknown; processing trip-backed
  // shapes first lets each draft take the first direction its route doesn't
  // already use (so a route's second drawn shape doesn't collide with the first
  // and get dropped). Labelled by the shape's own name when it has one.
  const options = useMemo(() => {
    const isDraft = (shapeId: string) => !trips.some((t) => t.shape_id === shapeId);
    // Trip-backed shapes (firm direction) before drafts; stable within each
    // group preserves draw order, so the 1st draft fills dir 0, the 2nd dir 1.
    const ordered = [...shapes].sort(
      (a, b) => Number(isDraft(a.shape_id)) - Number(isDraft(b.shape_id)),
    );
    const seen = new Set<string>();
    const usedDirs = new Map<string, Set<0 | 1>>();
    const out: Array<{
      key: string;
      routeId: string;
      directionId: 0 | 1;
      label: string;
      color: string;
    }> = [];
    for (const shape of ordered) {
      const trip = trips.find((t) => t.shape_id === shape.shape_id);
      const routeId = trip?.route_id ?? shape._route_id;
      if (!routeId) continue;
      const route = routes.find((r) => r.route_id === routeId);
      if (!route) continue;
      const taken = usedDirs.get(routeId) ?? new Set<0 | 1>();
      const directionId: 0 | 1 = trip ? trip.direction_id : taken.has(0) ? 1 : 0;
      const k = `${routeId}__${directionId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      taken.add(directionId);
      usedDirs.set(routeId, taken);
      const routeName = route.route_short_name || route.route_long_name || route.route_id;
      // Keep the route prefix (this dropdown spans every route); use the shape's
      // own name in place of the direction when it has one.
      const label = `${routeName} — ${shape._name?.trim() || directionName(route, directionId)}`;
      out.push({ key: k, routeId, directionId, label, color: route.route_color });
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

/** Anchored under the "Drawing Route Shape" banner: choose whether the shape
 *  being drawn starts a new route (default) or attaches to an existing one.
 *  The route isn't created until the shape is finished. */
function DrawRouteTargetDialog() {
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const drawingNewRoute = useStore((s) => s.drawingNewRoute);
  const drawingRouteId = useStore((s) => s.drawingRouteId);
  const setDrawingNewRoute = useStore((s) => s.setDrawingNewRoute);
  const setDrawingRouteId = useStore((s) => s.setDrawingRouteId);

  return (
    <div
      className="bg-white rounded-xl shadow-lg border border-sand px-3 py-2.5 flex items-center gap-2 w-[min(92vw,320px)]"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <label className="text-[10px] font-semibold text-warm-gray uppercase tracking-wide shrink-0">
        Add to
      </label>
      <select
        value={drawingNewRoute ? 'new' : (drawingRouteId ?? 'new')}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'new') {
            setDrawingNewRoute(true);
            setDrawingRouteId(null);
            window.__drawingDirection = 0;
          } else {
            setDrawingNewRoute(false);
            setDrawingRouteId(v);
            // Smart direction default for the chosen route: first shape
            // outbound, next inbound.
            const dirsUsed = new Set(
              trips.filter((t) => t.route_id === v && t.shape_id).map((t) => t.direction_id),
            );
            window.__drawingDirection = dirsUsed.has(0) && !dirsUsed.has(1) ? 1 : 0;
          }
        }}
        className="flex-1 px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral min-w-0"
      >
        <option value="new">New route</option>
        {routes.map((r) => (
          <option key={r.route_id} value={r.route_id}>
            {r.route_short_name || r.route_long_name || 'Untitled route'}
          </option>
        ))}
      </select>
    </div>
  );
}
