import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { generateId } from '../../services/idGenerator';
import { snapToRoad } from '../../services/snapToRoad';
import { simplifyShapePoints, SIMPLIFY_LEVELS } from '../../services/simplifyShape';
import { duplicateShapePoints } from '../../services/shapeHelpers';
import { deriveRouteShapeIds } from '../../services/routeShapes';

/**
 * Shapes subpanel for the Routes editor. Extracted out of RouteEditor.tsx so
 * the Details tab stays a focused properties form. Adds three behaviours
 * beyond what the inline section had:
 *
 *   1. The "Add new shape" button is always visible (it used to disappear
 *      with a "both directions have shapes" message once two were drawn).
 *   2. Per-shape Duplicate button — clones points + creates a stub trip
 *      so the new shape immediately appears in the list.
 *   3. Per-shape Trim button — prompts for start/end, then enters
 *      'trim_shape' map mode. MapView's click handler reads the shape id
 *      and side from window globals and rewrites the points.
 */
export function RouteShapesTab() {
  const {
    routes, trips, shapes, removeTrip,
    routeStops, addRouteStop,
    selectedRouteId,
    setMapMode, setDrawingRouteId, setDrawingNewRoute,
    setEditingShapeId, setRouteDetailTab, setStopsPanelShapeId, setStopPlacementDirection,
    addShape, addTrip,
    removeShape, renameShape,
    updateShapePoints, recalcShapeDistances,
    hiddenShapeIds, toggleShapeVisibility,
  } = useStore();

  const [snappingShapeId, setSnappingShapeId] = useState<string | null>(null);
  const [confirmDeleteShapeId, setConfirmDeleteShapeId] = useState<string | null>(null);
  const [simplifyShapeId, setSimplifyShapeId] = useState<string | null>(null);
  const [warnEditShapeId, setWarnEditShapeId] = useState<string | null>(null);
  const [trimPromptShapeId, setTrimPromptShapeId] = useState<string | null>(null);
  // Duplicate-shape options popover.
  const [dupPromptShapeId, setDupPromptShapeId] = useState<string | null>(null);
  const [dupReverse, setDupReverse] = useState(false);
  const [dupCopyStops, setDupCopyStops] = useState(true);

  const editingShapeId = useStore((s) => s.editingShapeId);
  const mapMode = useStore((s) => s.mapMode);
  // Cross-component handoff: the RoutePopup's "Edit Shape" button writes a
  // shape id here and navigates the rail to Shapes; this tab runs its
  // normal handleEditShape on mount, which includes the dense-shape warning.
  const pendingShapeEditId = useStore((s) => s.pendingShapeEditId);
  const setPendingShapeEditId = useStore((s) => s.setPendingShapeEditId);

  const route = routes.find((r) => r.route_id === selectedRouteId);

  const routeShapes = useMemo(() => {
    if (!selectedRouteId) return [];
    const routeTrips = trips.filter((t) => t.route_id === selectedRouteId);
    // Derive the route's shapes from the UNION of its trips' shape_ids, its
    // routeStops' shape_ids, and freshly drawn shapes tagged with this route
    // (Shape._route_id) that have no trip/routeStop yet — so a just-drawn shape
    // doesn't vanish from this panel before it gets stops or trips. (A shape
    // with stops stays listed even after its last trip is deleted.)
    const shapeIds = deriveRouteShapeIds(selectedRouteId, trips, routeStops, shapes);
    return shapeIds.map((sid) => {
      const shape = shapes.find((s) => s.shape_id === sid);
      const shapeTrips = routeTrips.filter((t) => t.shape_id === sid);
      return { shape, trips: shapeTrips, trip: shapeTrips[0] };
    }).filter((s) => s.shape);
  }, [selectedRouteId, trips, shapes, routeStops]);

  const handleEditShape = (shapeId: string) => {
    const shape = shapes.find((s) => s.shape_id === shapeId);
    if (shape && shape.points.length > 100) {
      setWarnEditShapeId(shapeId);
      return;
    }
    setEditingShapeId(shapeId);
    setMapMode('edit_shape');
  };

  // Jump to the Stops tab focused on this shape (works even for same-direction
  // shapes the direction fallback can't disambiguate).
  const handleEditStops = (shapeId: string) => {
    const dir = trips.find((t) => t.shape_id === shapeId)?.direction_id ?? 0;
    setStopsPanelShapeId(shapeId);
    setStopPlacementDirection(dir);
    setRouteDetailTab('stops');
  };

  // When the RoutePopup signals "edit this shape", run the same flow as
  // an in-panel Edit click (warning for dense shapes, immediate edit
  // otherwise), then clear the pending marker. Sits before the !route
  // early return so hook order stays stable across renders.
  useEffect(() => {
    if (!pendingShapeEditId) return;
    if (!shapes.some((s) => s.shape_id === pendingShapeEditId)) {
      setPendingShapeEditId(null);
      return;
    }
    handleEditShape(pendingShapeEditId);
    setPendingShapeEditId(null);
    // handleEditShape is closed over the current state — depending on it
    // would loop. The pending id is the only meaningful trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingShapeEditId]);

  if (!route) return null;

  const handleDrawShape = () => {
    // First shape defaults to outbound (0); once an outbound shape exists, the
    // next drawn shape defaults to inbound (1) — the common out-and-back, which
    // is the most likely intent. Direction is still changeable via the per-shape
    // toggle (which can invert the stop order), and duplicate-then-flip is the
    // other inbound path. Sentinel pattern documented in src/types/window.d.ts.
    const dirsUsed = new Set(
      trips
        .filter((t) => t.route_id === route.route_id && t.shape_id)
        .map((t) => t.direction_id),
    );
    window.__drawingDirection = dirsUsed.has(0) && !dirsUsed.has(1) ? 1 : 0;
    setDrawingNewRoute(false); // adding a shape to this existing route
    setDrawingRouteId(route.route_id);
    setMapMode('draw_route');
  };

  const handleEditAnywayShape = (shapeId: string) => {
    setWarnEditShapeId(null);
    setEditingShapeId(shapeId);
    setMapMode('edit_shape');
  };

  const handleSaveShapeEdit = () => { window.__shapeEditSave?.(); };
  const handleCancelShapeEdit = () => { window.__shapeEditDiscard?.(); };

  const handleDeleteShape = (shapeId: string) => {
    const shapeTrips = trips.filter((t) => t.shape_id === shapeId);
    for (const trip of shapeTrips) removeTrip(trip.trip_id);
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
      .finally(() => setSnappingShapeId(null));
  };

  // Duplicate the shape + a trip pointing at it. Without the trip the new
  // shape would be invisible in this panel's list (which derives from trips
  // with shape_ids). The trip clone is intentionally minimal — same
  // direction + service + headsign with "(copy)" appended — so the user
  // can immediately reassign or rename in the timetable.
  const handleDuplicateShape = (
    shapeId: string,
    opts: { reverse: boolean; copyStops: boolean } = { reverse: false, copyStops: true },
  ) => {
    const shape = shapes.find((s) => s.shape_id === shapeId);
    if (!shape) return;
    const sourceTrip = trips.filter((t) => t.shape_id === shapeId)[0];
    const newShapeId = generateId('shape');

    // Optionally reverse the vertex order (re-sequenced) for the opposite
    // direction; recalcShapeDistances then recomputes shape_dist_traveled.
    let points = duplicateShapePoints(shape.points);
    if (opts.reverse) {
      points = points.slice().reverse().map((p, i) => ({ ...p, shape_pt_sequence: i }));
    }
    addShape({
      shape_id: newShapeId,
      points,
      _name: shape._name ? `${shape._name} (copy)` : undefined,
    });
    recalcShapeDistances(newShapeId);

    if (sourceTrip) {
      addTrip({
        ...sourceTrip,
        trip_id: generateId('trip'),
        shape_id: newShapeId,
        trip_headsign: sourceTrip.trip_headsign
          ? `${sourceTrip.trip_headsign} (copy)`
          : '',
      });
    }

    // Optionally copy the shape's stops onto the copy, reversing their order to
    // match when the vertices are reversed.
    if (opts.copyStops) {
      const ordered = routeStops
        .filter((rs) => rs.shape_id === shapeId)
        .sort((a, b) => a.stop_sequence - b.stop_sequence);
      const n = ordered.length;
      ordered.forEach((rs, i) => {
        // Drop _uid so each copied instance gets its own fresh handle
        // (addRouteStop only stamps one when absent).
        const { _uid: _drop, ...base } = rs;
        void _drop;
        addRouteStop({ ...base, shape_id: newShapeId, stop_sequence: opts.reverse ? n - 1 - i : i });
      });
    }
  };

  // Trim button → modal asks start/end, then enters 'trim_shape' map mode.
  // The shape id + side are stashed on window globals so MapView's click
  // handler can read them without subscribing to a transient piece of UI state.
  const beginTrim = (shapeId: string, side: 'start' | 'end') => {
    window.__trimShapeId = shapeId;
    window.__trimShapeSide = side;
    setTrimPromptShapeId(null);
    setMapMode('trim_shape');
  };

  return (
    <div className="mb-4">
      {mapMode === 'edit_shape' && (
        <div className="mb-3 p-2.5 bg-gold-light rounded-lg">
          <p className="text-xs text-amber-800">
            <strong>Editing shape:</strong> Drag vertices to move them. Click midpoints to add vertices. Select a vertex and press <kbd className="px-1 py-0.5 bg-amber-100 rounded text-[10px]">Delete</kbd> to remove it.
          </p>
        </div>
      )}

      {routeShapes.length > 0 ? (
        <div className="flex flex-col gap-1.5 mb-3">
          {routeShapes.map(({ shape, trips: shapeTrips, trip }) => {
            const isShapeHidden = hiddenShapeIds.includes(shape!.shape_id);
            return (
              <div key={shape!.shape_id} className="bg-cream rounded-lg text-sm">
                <div className="flex items-center gap-2 px-3 py-2">
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
                  <div className={`flex-1 min-w-0 flex items-center gap-1.5 transition-opacity ${isShapeHidden ? 'opacity-40' : ''}`}>
                    <input
                      key={`shape-name-${shape!.shape_id}-${shape!._name ?? ''}`}
                      defaultValue={shape!._name ?? ''}
                      placeholder={trip?.trip_headsign || 'Untitled shape'}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (shape!._name ?? '')) renameShape(shape!.shape_id, v);
                      }}
                      title="Rename shape"
                      className="min-w-0 flex-1 text-dark-brown font-medium text-xs bg-transparent border border-transparent rounded px-1 py-0.5 -ml-1 hover:border-sand focus:border-coral focus:bg-white focus:outline-none placeholder:text-warm-gray placeholder:font-medium"
                    />
                    <span className="text-[10px] text-warm-gray whitespace-nowrap shrink-0">
                      {shape!.points.length} pts · {shapeTrips.length} trip{shapeTrips.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1 px-3 pb-2">
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
                        Edit Shape
                      </button>
                      <button
                        onClick={() => handleEditStops(shape!.shape_id)}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                        title="Edit this shape's stops"
                      >
                        Edit Stops
                      </button>
                      <button
                        onClick={() => setDupPromptShapeId(dupPromptShapeId === shape!.shape_id ? null : shape!.shape_id)}
                        className={`px-2 py-1.5 rounded text-[11px] font-semibold transition-colors
                          ${dupPromptShapeId === shape!.shape_id ? 'bg-coral-light text-coral' : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'}`}
                        title="Duplicate shape (with options)"
                      >
                        Duplicate
                      </button>
                      <button
                        onClick={() => setTrimPromptShapeId(trimPromptShapeId === shape!.shape_id ? null : shape!.shape_id)}
                        className={`px-2 py-1.5 rounded text-[11px] font-semibold transition-colors
                          ${trimPromptShapeId === shape!.shape_id ? 'bg-coral-light text-coral' : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'}`}
                        title="Trim the start or end of this shape"
                      >
                        Trim
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

                {/* Duplicate options — reverse the vertex order (for the
                    opposite direction) and/or copy the shape's stops. */}
                {dupPromptShapeId === shape!.shape_id && (
                  <div className="mx-3 mb-2 p-2 bg-cream border border-sand rounded-lg">
                    <p className="text-[11px] text-dark-brown font-semibold mb-2">
                      Duplicate this shape
                    </p>
                    <label className="flex items-center gap-2 text-[11px] text-dark-brown mb-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={dupReverse}
                        onChange={(e) => setDupReverse(e.target.checked)}
                        className="accent-coral"
                      />
                      Reverse vertex order (for the opposite direction)
                    </label>
                    <label className="flex items-center gap-2 text-[11px] text-dark-brown mb-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={dupCopyStops}
                        onChange={(e) => setDupCopyStops(e.target.checked)}
                        className="accent-coral"
                      />
                      Copy stops{dupReverse ? ' (reversed to match)' : ''}
                    </label>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setDupPromptShapeId(null)}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => {
                          handleDuplicateShape(shape!.shape_id, { reverse: dupReverse, copyStops: dupCopyStops });
                          setDupPromptShapeId(null);
                        }}
                        className="flex-1 px-2 py-1.5 bg-coral text-white rounded text-[11px] font-semibold hover:bg-[#d4603a] transition-colors"
                      >
                        Duplicate
                      </button>
                    </div>
                  </div>
                )}

                {/* Trim picker — appears when the user clicks Trim. Pick a side,
                    then click a point on the shape on the map to set the cut. */}
                {trimPromptShapeId === shape!.shape_id && (
                  <div className="mx-3 mb-2 p-2 bg-cream border border-sand rounded-lg">
                    <p className="text-[11px] text-dark-brown font-semibold mb-2">
                      Which end of the shape do you want to trim?
                    </p>
                    <div className="flex gap-1">
                      <button
                        onClick={() => beginTrim(shape!.shape_id, 'start')}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                      >
                        Trim from start
                      </button>
                      <button
                        onClick={() => beginTrim(shape!.shape_id, 'end')}
                        className="flex-1 px-2 py-1.5 bg-sand text-brown rounded text-[11px] font-semibold hover:bg-coral-light hover:text-coral transition-colors"
                      >
                        Trim from end
                      </button>
                    </div>
                    <p className="mt-2 text-[10px] text-warm-gray">
                      Then click a point on the shape on the map to set the cut.
                    </p>
                  </div>
                )}

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

                {/* Simplify picker */}
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

      {/* Add-new-shape button. The per-draw direction picker was dropped
          along with the "both directions full" gate — routes can now carry
          an unlimited number of shapes (express / weekend / detour
          variants), and pinning every new shape to a direction at draw
          time stops making sense. New shapes default to direction 0; the
          user re-assigns each variant's direction from the Trips tab.
          Snap-to-road is also gone from this panel — the global setting
          (default on) still governs draw behaviour. */}
      <button
        onClick={handleDrawShape}
        className="w-full px-4 py-2.5 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
      >
        {routeShapes.length > 0 ? 'Add new shape' : 'Draw route shape'}
      </button>
    </div>
  );
}
