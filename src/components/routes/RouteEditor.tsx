import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { FormField } from '../ui/FormField';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import { ROUTE_TYPES, directionName } from '../../utils/constants';
import { calculateRouteStats } from '../../services/costEstimation';
import { snapToRoad } from '../../services/snapToRoad';
import { simplifyShapePoints, SIMPLIFY_LEVELS } from '../../services/simplifyShape';
import type { Route } from '../../types/gtfs';

function formatCurrency(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

function CostEstimationSection({ route }: { route: Route }) {
  const { routes, trips, stopTimes, calendars, calendarDates, updateRoute } = useStore();

  const stats = useMemo(
    () => calculateRouteStats(route.route_id, { routes, trips, stopTimes, calendars, calendarDates }),
    [route.route_id, route._cost_per_revenue_hour, routes, trips, stopTimes, calendars, calendarDates]
  );

  return (
    <div className="px-3 pb-3">
      <div className="mb-3">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Cost per Revenue Hour ($)
        </label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={route._cost_per_revenue_hour ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            updateRoute(route.route_id, {
              _cost_per_revenue_hour: val === '' ? undefined : Number(val),
            });
          }}
          placeholder="e.g., 125"
          className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm text-dark-brown bg-cream focus:outline-none focus:border-coral focus:bg-white transition-colors"
        />
      </div>
      <div className="flex flex-col gap-1.5 text-sm">
        <div className="flex justify-between">
          <span className="text-warm-gray">Weekly Revenue Hours</span>
          <span className="font-semibold text-dark-brown">{stats.revenueHoursWeekly.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Total Hours (w/ deadhead)</span>
          <span className="font-semibold text-dark-brown">{stats.totalHoursWeekly.toFixed(1)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Trips / Week</span>
          <span className="font-semibold text-dark-brown">{stats.tripsPerWeek}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-warm-gray">Peak Vehicles</span>
          <span className="font-semibold text-dark-brown">{stats.peakVehicles}</span>
        </div>
        {route._cost_per_revenue_hour != null && route._cost_per_revenue_hour > 0 && (
          <>
            <div className="h-px bg-sand my-1" />
            <div className="flex justify-between">
              <span className="text-warm-gray">Weekly Cost</span>
              <span className="font-semibold text-coral">{formatCurrency(stats.weeklyCost)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-warm-gray">Annual Cost</span>
              <span className="font-semibold text-coral">{formatCurrency(stats.annualCost)}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function RouteEditor() {
  const {
    routes, updateRoute, removeRoute, trips, shapes, stops, removeTrip,
    selectedRouteId, selectRoute,
    setMapMode, setDrawingRouteId,
    setEditingRouteId, setEditingShapeId,
    setSidebarSection,
    snapToRoad: snapToRoadEnabled, setSnapToRoad,
    removeShape,
    updateShapePoints, recalcShapeDistances,
    routeStops,
    hiddenShapeIds, toggleShapeVisibility,
  } = useStore();

  const [costOpen, setCostOpen] = useState(false);
  const [snappingShapeId, setSnappingShapeId] = useState<string | null>(null);
  const [drawDirection, setDrawDirection] = useState<0 | 1>(0);
  const [confirmDeleteShapeId, setConfirmDeleteShapeId] = useState<string | null>(null);
  const [showDeleteRouteConfirm, setShowDeleteRouteConfirm] = useState(false);
  const [dontWarnDelete, setDontWarnDelete] = useState(false);
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

  const handleBack = () => {
    setEditingRouteId(null);
  };

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

  // Compute what would be deleted with this route
  const deleteInfo = useMemo(() => {
    if (!route) return { tripCount: 0, uniqueStops: [] as typeof stops };
    const routeTripCount = trips.filter((t) => t.route_id === route.route_id).length;
    const thisRouteStopIds = new Set(
      routeStops.filter((rs) => rs.route_id === route.route_id).map((rs) => rs.stop_id)
    );
    const otherRouteStopIds = new Set(
      routeStops.filter((rs) => rs.route_id !== route.route_id).map((rs) => rs.stop_id)
    );
    const uniqueStopIds = [...thisRouteStopIds].filter((sid) => !otherRouteStopIds.has(sid));
    const uniqueStops = uniqueStopIds
      .map((sid) => stops.find((s) => s.stop_id === sid))
      .filter(Boolean) as typeof stops;
    return { tripCount: routeTripCount, uniqueStops };
  }, [route, trips, routeStops, stops]);

  const handleDeleteClick = () => {
    // Check localStorage for "don't warn again"
    const skipWarning = localStorage.getItem('gtfs-skip-route-delete-warning') === 'true';
    if (skipWarning || (deleteInfo.tripCount === 0 && deleteInfo.uniqueStops.length === 0)) {
      executeDelete();
    } else {
      setShowDeleteRouteConfirm(true);
    }
  };

  const executeDelete = () => {
    if (!route) return;
    if (dontWarnDelete) {
      localStorage.setItem('gtfs-skip-route-delete-warning', 'true');
    }
    removeRoute(route.route_id);
    selectRoute(null);
    setEditingRouteId(null);
    setShowDeleteRouteConfirm(false);
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
      {/* Header with back button */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={handleBack}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-warm-gray hover:bg-cream hover:text-dark-brown transition-colors text-sm"
        >
          ←
        </button>
        <div
          className="w-4 h-4 rounded shrink-0"
          style={{ backgroundColor: `#${route.route_color}` }}
        />
        <h3 className="font-heading font-bold text-base text-dark-brown truncate">
          {route.route_short_name || route.route_long_name || 'Untitled Route'}
        </h3>
      </div>

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

      {/* Cost Estimation */}
      <div className="border-2 border-sand rounded-lg mb-4">
        <button
          onClick={() => setCostOpen(!costOpen)}
          className="w-full flex items-center justify-between px-3 py-2.5 text-sm font-heading font-bold text-dark-brown hover:bg-cream rounded-lg transition-colors"
        >
          <span>Cost Estimation</span>
          <span className="text-warm-gray text-xs">{costOpen ? '−' : '+'}</span>
        </button>
        {costOpen && <CostEstimationSection route={route} />}
      </div>

      {/* Shapes section */}
      <div className="border-t border-sand pt-4 mb-4">
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
          Route Shapes ({routeShapes.length})
        </label>

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

      {/* Quick actions */}
      <button
        onClick={() => {
          selectRoute(route.route_id);
          setSidebarSection('stops');
        }}
        className="w-full px-4 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors mb-2"
      >
        Add Stops to Route
      </button>

      <button
        onClick={() => {
          selectRoute(route.route_id);
          useStore.getState().setBottomPanelOpen(true);
          useStore.getState().setBottomPanelTab('timetable');
          setSidebarSection('timetable');
        }}
        className="w-full px-4 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors mb-4"
      >
        Edit Timetable
      </button>

      <button
        onClick={handleDeleteClick}
        className="text-xs text-red-400 hover:text-red-600"
      >
        Delete route
      </button>

      {/* Delete route confirmation dialog */}
      {showDeleteRouteConfirm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => setShowDeleteRouteConfirm(false)}
        >
          <div className="bg-white rounded-xl shadow-lg p-5 max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
              Delete "{route.route_short_name || route.route_long_name}"?
            </h3>
            <p className="text-sm text-warm-gray mb-3">
              This will also delete:
            </p>
            <ul className="text-sm text-dark-brown mb-3 space-y-1">
              {deleteInfo.tripCount > 0 && (
                <li>• {deleteInfo.tripCount} trip{deleteInfo.tripCount !== 1 ? 's' : ''} and their stop times</li>
              )}
              {deleteInfo.uniqueStops.length > 0 && (
                <li>
                  • {deleteInfo.uniqueStops.length} stop{deleteInfo.uniqueStops.length !== 1 ? 's' : ''} not used by other routes:
                  <div className="ml-3 mt-1 max-h-32 overflow-y-auto">
                    {deleteInfo.uniqueStops.slice(0, 10).map((s) => (
                      <div key={s.stop_id} className="text-xs text-warm-gray">{s.stop_name || s.stop_id}</div>
                    ))}
                    {deleteInfo.uniqueStops.length > 10 && (
                      <div className="text-xs text-warm-gray italic">...and {deleteInfo.uniqueStops.length - 10} more</div>
                    )}
                  </div>
                </li>
              )}
            </ul>

            <label className="flex items-center gap-2 text-xs text-warm-gray mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={dontWarnDelete}
                onChange={(e) => setDontWarnDelete(e.target.checked)}
                className="rounded"
              />
              Don't warn me again
            </label>

            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteRouteConfirm(false)}
                className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-cream transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeDelete}
                className="flex-1 px-3 py-2 bg-red-500 text-white rounded-lg font-heading font-bold text-sm hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
