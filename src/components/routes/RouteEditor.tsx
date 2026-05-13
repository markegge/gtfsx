import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { RailSubHeading, RailDivider } from '../ui/RailHeadings';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES, directionName } from '../../utils/constants';
import { snapToRoad } from '../../services/snapToRoad';
import { simplifyShapePoints, SIMPLIFY_LEVELS } from '../../services/simplifyShape';
export function RouteEditor() {
  const {
    routes, updateRoute, trips, shapes, removeTrip,
    selectedRouteId,
    setMapMode, setDrawingRouteId,
    setEditingShapeId,
    snapToRoad: snapToRoadEnabled, setSnapToRoad,
    removeShape,
    updateShapePoints, recalcShapeDistances,
    hiddenShapeIds, toggleShapeVisibility,
  } = useStore();

  const [snappingShapeId, setSnappingShapeId] = useState<string | null>(null);
  const [drawDirection, setDrawDirection] = useState<0 | 1>(0);
  const [confirmDeleteShapeId, setConfirmDeleteShapeId] = useState<string | null>(null);
  const [simplifyShapeId, setSimplifyShapeId] = useState<string | null>(null);
  const [warnEditShapeId, setWarnEditShapeId] = useState<string | null>(null);

  const route = routes.find((r) => r.route_id === selectedRouteId);

  const routeShapes = useMemo(() => {
    if (!selectedRouteId) return [];
    const routeTrips = trips.filter((t) => t.route_id === selectedRouteId);
    const shapeIds = [...new Set(routeTrips.map((t) => t.shape_id).filter(Boolean))] as string[];
    return shapeIds.map((sid) => {
      const shape = shapes.find((s) => s.shape_id === sid);
      const shapeTrips = routeTrips.filter((t) => t.shape_id === sid);
      return { shape, trips: shapeTrips, trip: shapeTrips[0] };
    }).filter((s) => s.shape);
  }, [selectedRouteId, trips, shapes]);

  if (!route) return null;

  const handleDrawShape = () => {
    // Set direction on window for MapView to read
    (window as any).__drawingDirection = drawDirection;
    setDrawingRouteId(route.route_id);
    setMapMode('draw_route');
  };

  const handleEditShape = (shapeId: string) => {
    const shape = shapes.find((s) => s.shape_id === shapeId);
    if (shape && shape.points.length > 100) {
      setWarnEditShapeId(shapeId);
      return;
    }
    setEditingShapeId(shapeId);
    setMapMode('edit_shape');
  };

  const handleEditAnywayShape = (shapeId: string) => {
    setWarnEditShapeId(null);
    setEditingShapeId(shapeId);
    setMapMode('edit_shape');
  };

  const handleSaveShapeEdit = () => {
    // Call the save function exposed by MapView
    (window as any).__shapeEditSave?.();
  };

  const handleCancelShapeEdit = () => {
    // Call the discard function exposed by MapView
    (window as any).__shapeEditDiscard?.();
  };

  const handleDeleteShape = (shapeId: string) => {
    // Remove all trips that use this shape
    const shapeTrips = trips.filter((t) => t.shape_id === shapeId);
    for (const trip of shapeTrips) {
      removeTrip(trip.trip_id);
    }
    // Remove the shape itself
    removeShape(shapeId);
    setConfirmDeleteShapeId(null);
  };


  const handleResnapShape = (shapeId: string) => {
    const shape = shapes.find((s) => s.shape_id === shapeId);
    if (!shape || shape.points.length < 2) return;

    const coords: [number, number][] = shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]);
    setSnappingShapeId(shapeId);

    snapToRoad(coords)
      .then((snapped) => {
        const newPoints = snapped.map((c, i) => ({
          shape_pt_lat: c[1],
          shape_pt_lon: c[0],
          shape_pt_sequence: i,
          shape_dist_traveled: 0,
        }));
        updateShapePoints(shapeId, newPoints);
        recalcShapeDistances(shapeId);
      })
      .finally(() => {
        setSnappingShapeId(null);
      });
  };

  const editingShapeId = useStore((s) => s.editingShapeId);
  const mapMode = useStore((s) => s.mapMode);

  return (
    <div>
      {/* Route properties */}
      <FormField
        label="Short Name"
        value={route.route_short_name}
        onChange={(v) => updateRoute(route.route_id, { route_short_name: v })}
        placeholder="e.g., Blueline"
        required
      />
      <FormField
        label="Long Name"
        value={route.route_long_name}
        onChange={(v) => updateRoute(route.route_id, { route_long_name: v })}
        placeholder="e.g., Main Street Express"
      />
      <FormField
        label="Description"
        value={route.route_desc || ''}
        onChange={(v) => updateRoute(route.route_id, { route_desc: v })}
        placeholder="Brief route description"
      />
      <FormField
        label="URL"
        value={route.route_url || ''}
        onChange={(v) => updateRoute(route.route_id, { route_url: v })}
        placeholder="https://..."
      />

      {/* Route Type */}
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Route Type
        </label>
        <select
          value={route.route_type}
          onChange={(e) => updateRoute(route.route_id, { route_type: Number(e.target.value) })}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral"
        >
          {Object.entries(ROUTE_TYPES).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

      {/* Route Color */}
      <div className="mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Route Color
        </label>
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-lg"
            style={{ backgroundColor: `#${route.route_color}` }}
          />
          <input
            value={`#${route.route_color}`}
            onChange={(e) => {
              const hex = e.target.value.replace('#', '').toUpperCase();
              if (/^[0-9A-F]{6}$/.test(hex)) {
                updateRoute(route.route_id, {
                  route_color: hex,
                  route_text_color: getContrastTextColor(hex),
                });
              }
            }}
            className="w-24 px-2 py-1 border-2 border-sand rounded-lg text-sm font-mono bg-cream focus:outline-none focus:border-coral"
          />
        </div>
        <div className="grid grid-cols-8 gap-1.5">
          {ROUTE_COLORS.map((color) => (
            <button
              key={color}
              onClick={() => updateRoute(route.route_id, {
                route_color: color,
                route_text_color: getContrastTextColor(color),
              })}
              className={`w-7 h-7 rounded-md transition-transform hover:scale-110
                ${route.route_color === color ? 'ring-2 ring-dark-brown ring-offset-2' : ''}`}
              style={{ backgroundColor: `#${color}` }}
            />
          ))}
        </div>
      </div>

      {/* Direction Names */}
      <div className="mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          Direction Labels
        </label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Direction 0</label>
            <input
              value={route._direction_0_name || ''}
              onChange={(e) => updateRoute(route.route_id, { _direction_0_name: e.target.value })}
              placeholder="Outbound"
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </div>
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Direction 1</label>
            <input
              value={route._direction_1_name || ''}
              onChange={(e) => updateRoute(route.route_id, { _direction_1_name: e.target.value })}
              placeholder="Inbound"
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            />
          </div>
        </div>
      </div>

      {/* Flag-Stop (GTFS-Flex continuous pickup/drop-off) */}
      <RailDivider />
      <RailSubHeading>Flag-Stop Service</RailSubHeading>
      <div className="mb-4">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Pickup</label>
            <select
              value={route.continuous_pickup ?? ''}
              onChange={(e) => updateRoute(route.route_id, {
                continuous_pickup: e.target.value === '' ? undefined
                  : (Number(e.target.value) as 0 | 1 | 2 | 3),
              })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">Not set (fixed stops only)</option>
              <option value="0">0 — Continuous boarding allowed</option>
              <option value="1">1 — No continuous pickup</option>
              <option value="2">2 — Must phone agency</option>
              <option value="3">3 — Coordinate with driver</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-warm-gray mb-0.5">Drop-off</label>
            <select
              value={route.continuous_drop_off ?? ''}
              onChange={(e) => updateRoute(route.route_id, {
                continuous_drop_off: e.target.value === '' ? undefined
                  : (Number(e.target.value) as 0 | 1 | 2 | 3),
              })}
              className="w-full px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-cream focus:outline-none focus:border-coral"
            >
              <option value="">Not set (fixed stops only)</option>
              <option value="0">0 — Continuous alighting allowed</option>
              <option value="1">1 — No continuous drop-off</option>
              <option value="2">2 — Must phone agency</option>
              <option value="3">3 — Coordinate with driver</option>
            </select>
          </div>
        </div>
        <p className="text-[10px] text-warm-gray/80 mt-1">
          Allows passengers to board or alight anywhere along the route, not just at fixed stops. Leave unset unless this is flag-stop / deviated fixed-route service.
        </p>
      </div>

      {/* Shapes section */}
      <RailDivider />
      <RailSubHeading count={routeShapes.length}>Route Shapes</RailSubHeading>
      <div className="mb-4">

        {routeShapes.length > 0 ? (
          <div className="flex flex-col gap-1.5 mb-3">
            {routeShapes.map(({ shape, trips: shapeTrips, trip }) => {
              const isShapeHidden = hiddenShapeIds.includes(shape!.shape_id);
              return (
              <div
                key={shape!.shape_id}
                className="bg-cream rounded-lg text-sm"
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  {/* Shape visibility toggle — click the circle */}
                  <button
                    onClick={() => toggleShapeVisibility(shape!.shape_id)}
                    className={`w-2.5 h-2.5 rounded-full shrink-0 transition-all border
                      ${isShapeHidden ? 'opacity-30' : 'opacity-100 hover:scale-150'}`}
                    style={{
                      backgroundColor: isShapeHidden ? 'transparent' : `#${route.route_color}`,
                      borderColor: `#${route.route_color}`,
                    }}
                    title={isShapeHidden ? 'Show shape on map' : 'Hide shape from map'}
                  />
                  <div className={`flex-1 min-w-0 transition-opacity ${isShapeHidden ? 'opacity-40' : ''}`}>
                    <span className="text-dark-brown font-medium text-xs">
                      {trip?.trip_headsign || directionName(route, trip?.direction_id ?? 0)}
                    </span>
                    <span className="text-[10px] text-warm-gray ml-1.5">
                      {shape!.points.length} pts · {shapeTrips.length} trip{shapeTrips.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-1 px-3 pb-2">
                  {mapMode === 'edit_shape' && editingShapeId === shape!.shape_id ? (
                    <>
                      <button
                        onClick={handleCancelShapeEdit}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-red-100 hover:text-red-600 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => setSimplifyShapeId(simplifyShapeId === shape!.shape_id ? null : shape!.shape_id)}
                        className={`px-2 py-1.5 rounded text-[11px] font-semibold transition-colors
                          ${simplifyShapeId === shape!.shape_id ? 'bg-coral-light text-coral' : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'}`}
                      >
                        Simplify
                      </button>
                      <button
                        onClick={handleSaveShapeEdit}
                        className="flex-1 px-2 py-1.5 bg-teal text-white rounded text-[11px] font-semibold hover:bg-teal/80 transition-colors"
                      >
                        Save
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => handleEditShape(shape!.shape_id)}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleResnapShape(shape!.shape_id)}
                        disabled={snappingShapeId === shape!.shape_id}
                        className="px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors disabled:opacity-50"
                      >
                        {snappingShapeId === shape!.shape_id ? '...' : 'Snap'}
                      </button>
                      <button
                        onClick={() => setConfirmDeleteShapeId(shape!.shape_id)}
                        className="px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-red-100 hover:text-red-600 transition-colors"
                        title="Delete shape"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>

                {/* Vertex count warning when clicking Edit on dense shapes */}
                {warnEditShapeId === shape!.shape_id && (
                  <div className="mx-3 mb-2 p-2.5 bg-gold-light border border-gold rounded-lg">
                    <p className="text-[11px] text-brown mb-2">
                      This shape has <strong>{shape!.points.length} vertices</strong>. Editing may be slow.
                    </p>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleEditAnywayShape(shape!.shape_id)}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                      >
                        Edit Anyway
                      </button>
                      <button
                        onClick={() => {
                          setWarnEditShapeId(null);
                          setSimplifyShapeId(shape!.shape_id);
                        }}
                        className="flex-1 px-2 py-1.5 bg-coral text-white rounded text-[11px] font-semibold hover:bg-[#d4603a] transition-colors"
                      >
                        Simplify First
                      </button>
                    </div>
                  </div>
                )}

                {/* Simplify picker (shown during editing or from warning) */}
                {simplifyShapeId === shape!.shape_id && (
                  <div className="mx-3 mb-2 p-2 bg-cream border border-sand rounded-lg">
                    <p className="text-[11px] text-dark-brown font-semibold mb-2">
                      Reduce vertices ({shape!.points.length} pts)
                    </p>
                    <div className="flex flex-col gap-1">
                      {SIMPLIFY_LEVELS.map((level) => {
                        const preview = simplifyShapePoints(shape!.points, level.tolerance);
                        return (
                          <button
                            key={level.label}
                            onClick={() => {
                              updateShapePoints(shape!.shape_id, preview);
                              recalcShapeDistances(shape!.shape_id);
                              setSimplifyShapeId(null);
                              // Always enter (or re-enter) edit mode after simplification
                              setEditingShapeId(null);
                              setTimeout(() => {
                                setEditingShapeId(shape!.shape_id);
                                setMapMode('edit_shape');
                              }, 50);
                            }}
                            className="flex items-center justify-between px-2 py-1.5 bg-sand rounded text-[11px] hover:bg-coral-light hover:text-coral transition-colors"
                          >
                            <span className="font-semibold">{level.label}</span>
                            <span className="text-warm-gray">
                              {level.description} → {preview.length} pts
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => setSimplifyShapeId(null)}
                      className="mt-1 w-full text-[10px] text-warm-gray hover:text-dark-brown transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Delete confirmation */}
                {confirmDeleteShapeId === shape!.shape_id && (
                  <div className="mx-3 mb-2 p-2 bg-red-50 border border-red-200 rounded-lg">
                    <p className="text-[11px] text-red-700 mb-2">
                      Delete this shape and its {shapeTrips.length} trip{shapeTrips.length !== 1 ? 's' : ''}?
                    </p>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setConfirmDeleteShapeId(null)}
                        className="flex-1 px-2 py-1 bg-sand text-brown rounded text-[11px] font-semibold"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleDeleteShape(shape!.shape_id)}
                        className="flex-1 px-2 py-1 bg-red-500 text-white rounded text-[11px] font-semibold"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-warm-gray mb-3">
            No shapes drawn yet. Draw a route shape on the map.
          </p>
        )}

        {mapMode === 'edit_shape' && (
          <div className="mb-3 p-2.5 bg-gold-light rounded-lg">
            <p className="text-xs text-amber-800">
              <strong>Editing shape:</strong> Drag vertices to move them. Click midpoints to add vertices. Select a vertex and press <kbd className="px-1 py-0.5 bg-amber-100 rounded text-[10px]">Delete</kbd> to remove it.
            </p>
          </div>
        )}

        {/* Direction selector + draw button, or "both directions full" message */}
        {(() => {
          const hasOutbound = routeShapes.some((s) => s.trip?.direction_id === 0);
          const hasInbound = routeShapes.some((s) => s.trip?.direction_id === 1);

          if (hasOutbound && hasInbound) {
            return (
              <div className="bg-cream rounded-lg px-3 py-2 text-xs text-warm-gray">
                Both directions have shapes. Delete one to draw a replacement.
              </div>
            );
          }

          // If one direction exists, only allow drawing the other
          const onlyOneAvailable = hasOutbound || hasInbound;
          const availableDirection: 0 | 1 = hasOutbound ? 1 : 0;

          return (
            <>
              {/* Show direction selector only when no shapes exist yet (both directions available) */}
              {!onlyOneAvailable && (
                <div className="mb-2">
                  <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                    Direction for new shape
                  </label>
                  <div className="flex rounded-md border border-sand overflow-hidden">
                    <button
                      onClick={() => setDrawDirection(0)}
                      className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors
                        ${drawDirection === 0 ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}`}
                    >
                      {directionName(route, 0)}
                    </button>
                    <button
                      onClick={() => setDrawDirection(1)}
                      className={`flex-1 px-3 py-1.5 text-xs font-semibold transition-colors border-l border-sand
                        ${drawDirection === 1 ? 'bg-coral text-white' : 'bg-white text-warm-gray hover:text-dark-brown'}`}
                    >
                      {directionName(route, 1)}
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => {
                  if (onlyOneAvailable) {
                    setDrawDirection(availableDirection);
                    (window as any).__drawingDirection = availableDirection;
                  }
                  handleDrawShape();
                }}
                className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
              >
                {onlyOneAvailable
                  ? `Draw ${directionName(route, availableDirection)} Shape`
                  : routeShapes.length > 0 ? 'Draw Another Shape' : 'Draw Route Shape'}
              </button>

              {/* When the user has an outbound shape but no inbound, offer a
                  split alternative: pick a turnaround point on the existing
                  shape and cleave it into outbound + inbound halves. Common
                  case is imported feeds where someone drew the whole loop
                  as one continuous Direction-0 line. Loop detection happens
                  at confirm-time as a warning, not as a hard disable here. */}
              {hasOutbound && !hasInbound && (() => {
                const outboundShape = routeShapes.find((s) => s.trip?.direction_id === 0)?.shape;
                if (!outboundShape || outboundShape.points.length < 3) return null;
                const splitting = mapMode === 'split_shape';
                return (
                  <button
                    onClick={() => setMapMode(splitting ? 'select' : 'split_shape')}
                    title="Click a point on the existing shape on the map to split it into outbound + inbound halves."
                    className={`w-full mt-2 px-4 py-2 rounded-lg font-heading font-bold text-sm transition-colors
                      ${splitting
                        ? 'bg-coral text-white'
                        : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'}`}
                  >
                    {splitting
                      ? 'Click route on map to split…  (Cancel)'
                      : `Or split existing ${directionName(route, 0)} shape`}
                  </button>
                );
              })()}
            </>
          );
        })()}

        <div className="flex items-center gap-2 mt-2">
          <input
            type="checkbox"
            id="snap-to-road"
            checked={snapToRoadEnabled}
            onChange={(e) => setSnapToRoad(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="snap-to-road" className="text-xs text-dark-brown">
            Snap to road
          </label>
        </div>
      </div>

    </div>
  );
}
