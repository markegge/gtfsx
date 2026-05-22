import { useCallback, useEffect, useRef, useState } from 'react';
import buffer from '@turf/buffer';
import { featureCollection, multiLineString } from '@turf/helpers';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import type { FlexZone } from '../../store/flexSlice';
import { FlexZoneDetails } from './FlexZoneDetails';
import { createFlexZoneWithRoute } from './flexHelpers';

const DEFAULT_FLEX_BUFFER_MILES = 0.75;

let zoneCounter = 1;

function generateServiceArea(
  shapes: ReturnType<typeof useStore.getState>['shapes'],
  routes: ReturnType<typeof useStore.getState>['routes'],
  trips: ReturnType<typeof useStore.getState>['trips'],
  hiddenRouteIds: string[],
  bufferMiles: number,
): GeoJSON.FeatureCollection | null {
  const hiddenSet = new Set(hiddenRouteIds);

  // Collect coordinate arrays for all visible bus route shapes (route_type !== 0)
  const lineCoords: [number, number][][] = [];

  for (const shape of shapes) {
    if (shape.points.length < 2) continue;
    const trip = trips.find((t) => t.shape_id === shape.shape_id);
    if (!trip) continue;
    const route = routes.find((r) => r.route_id === trip.route_id);
    if (!route) continue;
    if (hiddenSet.has(route.route_id)) continue;
    if (route.route_type === 0) continue; // skip light rail / tram

    lineCoords.push(shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]));
  }

  if (lineCoords.length === 0) return null;

  // Buffer a single MultiLineString so that overlapping buffers are
  // automatically dissolved — produces a Polygon for connected routes
  // or a MultiPolygon for disconnected service areas.
  const ml = multiLineString(lineCoords);
  const buffered = buffer(ml, bufferMiles, { units: 'miles' });
  if (!buffered) return null;

  return featureCollection([buffered]) as GeoJSON.FeatureCollection;
}

export function FlexEditor() {
  const {
    shapes, routes, trips, hiddenRouteIds,
    flexZones, removeFlexZone, updateFlexZone, updateRoute,
    mapMode, setMapMode, editingFlexZoneId, setEditingFlexZoneId,
  } = useStore();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bufferInput, setBufferInput] = useState<string>(String(DEFAULT_FLEX_BUFFER_MILES));
  const [expandedZoneId, setExpandedZoneId] = useState<string | null>(null);
  const [showCreatePanel, setShowCreatePanel] = useState(false);
  const [confirmDeleteZoneId, setConfirmDeleteZoneId] = useState<string | null>(null);
  // Inline-rename state for the zone name. Keyed by zone id so only one row
  // is in edit mode at a time.
  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');

  // Renaming the zone also syncs the paired auto-generated route so the
  // routes pane stays consistent with what the user sees in the flex panel.
  const commitRename = (zone: FlexZone) => {
    const next = nameDraft.trim();
    setRenamingZoneId(null);
    if (!next || next === zone.name) return;
    updateFlexZone(zone.id, { name: next });
    if (zone.routeId && routes.some((r) => r.route_id === zone.routeId)) {
      updateRoute(zone.routeId, {
        route_short_name: next,
        route_long_name: `${next} (Flex)`,
      });
    }
  };
  // Persists only for the current session — the ref is re-initialized on reload.
  const skipDeleteConfirmRef = useRef(false);

  // Let external triggers (e.g. the Flex zone map popup) expand a specific
  // zone's Details panel on mount.
  useEffect(() => {
    const pending = window.__flexZoneExpand;
    if (pending && flexZones.some((z) => z.id === pending)) {
      setExpandedZoneId(pending);
      delete window.__flexZoneExpand;
    }
  }, [flexZones]);

  const busRoutes = routes.filter((r) => r.route_type !== 0 && !hiddenRouteIds.includes(r.route_id));

  const hasShapes = shapes.some((s) => {
    const trip = trips.find((t) => t.shape_id === s.shape_id);
    if (!trip) return false;
    const route = routes.find((r) => r.route_id === trip.route_id);
    return route && route.route_type !== 0 && !hiddenRouteIds.includes(route.route_id);
  });

  const bufferMiles = Number(bufferInput);
  const bufferValid = Number.isFinite(bufferMiles) && bufferMiles > 0 && bufferMiles <= 25;

  const handleGenerate = useCallback(() => {
    setError(null);
    if (!bufferValid) {
      setError('Buffer must be between 0 and 25 miles.');
      return;
    }
    setGenerating(true);
    try {
      const geojson = generateServiceArea(shapes, routes, trips, hiddenRouteIds, bufferMiles);
      if (!geojson || geojson.features.length === 0) {
        setError('No visible bus route shapes found. Draw routes on the map first.');
        return;
      }
      createFlexZoneWithRoute({
        id: `flex-zone-${Date.now()}`,
        name: `Service Area ${zoneCounter++}`,
        bufferMiles,
        geojson,
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to generate service area');
    } finally {
      setGenerating(false);
    }
  }, [shapes, routes, trips, hiddenRouteIds, bufferMiles, bufferValid]);

  const handleDrawZone = () => {
    setMapMode('draw_flex_zone');
  };

  const handleCreateGroup = useCallback(() => {
    // Create an empty stop-group zone. User fills in stops via the zone's
    // Details panel, which expands below the new row.
    const zoneNum = useStore.getState().flexZones.length + 1;
    const zoneId = `flex-group-${Date.now()}`;
    createFlexZoneWithRoute({
      id: zoneId,
      name: `Stop Group ${zoneNum}`,
      bufferMiles: 0,
      geojson: { type: 'FeatureCollection', features: [] },
      stopIds: [],
    });
    setExpandedZoneId(zoneId);
  }, []);

  const handleEditZone = (zone: FlexZone) => {
    setEditingFlexZoneId(zone.id);
    setMapMode('edit_flex_zone');
  };

  const handleSaveEdit = () => {
    window.__flexZoneEditSave?.();
  };

  const handleCancelEdit = () => {
    window.__flexZoneEditDiscard?.();
  };

  const isDrawing = mapMode === 'draw_flex_zone';
  const isEditing = mapMode === 'edit_flex_zone';

  return (
    <div className="space-y-4">
      {/* Zone editing active */}
      {isEditing && editingFlexZoneId && (
        <div className="bg-purple-50 border border-purple-300 rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-purple-800">
            Editing: {flexZones.find((z) => z.id === editingFlexZoneId)?.name}
          </p>
          <p className="text-[11px] text-purple-700">
            Drag vertices to reshape. Click midpoints to add vertices. Use "Delete Vertex" on the map to remove.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleCancelEdit}
              className="flex-1 px-3 py-1.5 bg-white border border-sand text-warm-gray rounded-lg text-xs font-semibold hover:bg-sand transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveEdit}
              className="flex-1 px-3 py-1.5 bg-purple text-white rounded-lg text-xs font-semibold hover:opacity-90 transition-opacity"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Zone drawing active */}
      {isDrawing && (
        <div className="bg-purple-50 border border-purple-300 rounded-lg p-3 space-y-2">
          <p className="text-xs font-semibold text-purple-800">Drawing zone…</p>
          <p className="text-[11px] text-purple-700">
            Click on the map to add vertices. Double-click to close and save the polygon.
          </p>
          <button
            onClick={() => setMapMode('select')}
            className="w-full px-3 py-1.5 bg-white border border-sand text-warm-gray rounded-lg text-xs font-semibold hover:bg-sand transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Actions (not shown while editing) */}
      {!isEditing && !isDrawing && (
        !showCreatePanel ? (
          <button
            onClick={() => setShowCreatePanel(true)}
            className="w-full px-3 py-2 bg-purple text-white rounded-lg text-xs font-heading font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
          >
            <span>+</span> Create New Flex Zone
          </button>
        ) : (
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-purple-800">Create new flex zone</p>
              <button
                onClick={() => setShowCreatePanel(false)}
                className="text-[11px] text-warm-gray hover:text-dark-brown"
              >
                Cancel
              </button>
            </div>

            {/* Draw zone manually */}
            <button
              onClick={() => { handleDrawZone(); setShowCreatePanel(false); }}
              className="w-full px-3 py-2 bg-purple text-white rounded-lg text-xs font-heading font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
            >
              <span>✏</span> Draw Zone on Map
            </button>

            {/* Create stop group */}
            <button
              onClick={() => { handleCreateGroup(); setShowCreatePanel(false); }}
              className="w-full px-3 py-2 bg-white border border-purple text-purple rounded-lg text-xs font-heading font-bold hover:bg-purple-50 transition-colors flex items-center justify-center gap-2"
            >
              <span>•••</span> Create Stop Group
            </button>

            {/* Auto-generate from fixed routes */}
            <div className="bg-white border border-sand rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-dark-brown">Auto-generate from fixed routes</p>
              <p className="text-[11px] text-warm-gray">
                Buffer around all visible bus routes
                ({busRoutes.length} route{busRoutes.length !== 1 ? 's' : ''}).
                Light rail / tram excluded.
              </p>
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-dark-brown font-semibold whitespace-nowrap">
                  Buffer:
                </label>
                <input
                  type="number"
                  min="0.1"
                  max="25"
                  step="0.25"
                  value={bufferInput}
                  onChange={(e) => setBufferInput(e.target.value)}
                  className="w-20 px-2 py-1 border border-sand rounded text-xs text-dark-brown bg-white focus:outline-none focus:border-teal"
                />
                <span className="text-[11px] text-warm-gray">miles</span>
              </div>
              {error && <p className="text-[11px] text-red-600">{error}</p>}
              <button
                onClick={() => { handleGenerate(); setShowCreatePanel(false); }}
                disabled={generating || !hasShapes || !bufferValid}
                className="w-full px-3 py-2 bg-teal text-white rounded-lg text-xs font-heading font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {generating ? 'Generating…' : `Generate ${bufferValid ? bufferMiles : '?'} mi Buffer`}
              </button>
              {!hasShapes && (
                <p className="text-[11px] text-warm-gray">Draw route shapes on the map to enable.</p>
              )}
            </div>
          </div>
        )
      )}

      {/* Zone list */}
      {flexZones.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
            Service Areas ({flexZones.length})
          </p>
          {flexZones.map((zone) => {
            const expanded = expandedZoneId === zone.id;
            const hasBooking = !!zone.bookingRule;
            return (
              <div
                key={zone.id}
                className={`rounded-lg border transition-colors
                  ${editingFlexZoneId === zone.id
                    ? 'bg-purple-50 border-purple-300'
                    : 'bg-cream border-sand'
                  }`}
              >
                <div className="flex items-center gap-2 px-3 py-2">
                  <span
                    className="w-3 h-3 rounded-sm shrink-0 border border-purple-300"
                    style={{ backgroundColor: 'rgba(124,58,237,0.2)' }}
                  />
                  <div className="flex-1 min-w-0">
                    {renamingZoneId === zone.id ? (
                      <input
                        autoFocus
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onBlur={() => commitRename(zone)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          if (e.key === 'Escape') {
                            setNameDraft(zone.name);
                            setRenamingZoneId(null);
                          }
                        }}
                        className="text-sm font-medium text-dark-brown w-full px-1.5 py-0.5 bg-white border-2 border-purple-300 rounded outline-none focus:border-purple"
                      />
                    ) : (
                      <button
                        onClick={() => {
                          setNameDraft(zone.name);
                          setRenamingZoneId(zone.id);
                        }}
                        className="text-sm font-medium text-dark-brown truncate w-full text-left hover:text-purple transition-colors"
                        title="Rename service area"
                      >
                        {zone.name}
                      </button>
                    )}
                    <p className="text-[11px] text-warm-gray">
                      {Array.isArray(zone.stopIds) && zone.stopIds.length >= 0 && !zone.geojson.features.length
                        ? `${zone.stopIds.length} stop${zone.stopIds.length !== 1 ? 's' : ''}`
                        : `${zone.geojson.features.length} polygon${zone.geojson.features.length !== 1 ? 's' : ''}${zone.bufferMiles > 0 ? ` · ${zone.bufferMiles} mi buffer` : ' · hand-drawn'}`}
                      {hasBooking && ' · booking set'}
                      {zone.fareId && ` · fare ${zone.fareId}`}
                    </p>
                  </div>
                  {!isEditing && !isDrawing && (
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => setExpandedZoneId(expanded ? null : zone.id)}
                        className={`px-2 py-1 text-[11px] font-semibold rounded transition-colors
                          ${expanded
                            ? 'bg-purple-100 text-purple'
                            : 'text-warm-gray hover:text-purple hover:bg-purple-50'}`}
                        title="Booking rules, windows, fare"
                      >
                        Details {expanded ? '▾' : '▸'}
                      </button>
                      <button
                        onClick={() => handleEditZone(zone)}
                        className="px-2 py-1 text-[11px] font-semibold text-warm-gray hover:text-purple hover:bg-purple-50 rounded transition-colors"
                        title="Edit zone shape on the map"
                      >
                        Edit Shape
                      </button>
                      <button
                        onClick={() => {
                          if (skipDeleteConfirmRef.current) {
                            removeFlexZone(zone.id);
                          } else {
                            setConfirmDeleteZoneId(zone.id);
                          }
                        }}
                        className="px-1.5 py-1 text-[11px] text-warm-gray hover:text-red-500 transition-colors rounded"
                        title="Remove zone"
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
                {expanded && !isEditing && !isDrawing && (
                  <FlexZoneDetails zone={zone} />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        !isDrawing && !isEditing && (
          <EmptyState
            icon="📍"
            title="No service areas yet"
            description="Draw a zone on the map or generate one from your fixed routes."
          />
        )
      )}

      <div className="border-t border-sand pt-3">
        <p className="text-[10px] text-warm-gray">
          Exported as <code className="px-1 bg-sand rounded">locations.geojson</code> +{' '}
          <code className="px-1 bg-sand rounded">booking_rules.txt</code> per the GTFS-Flex spec.
        </p>
      </div>

      {/* Delete confirmation */}
      {confirmDeleteZoneId && (() => {
        const zone = flexZones.find((z) => z.id === confirmDeleteZoneId);
        if (!zone) { setConfirmDeleteZoneId(null); return null; }
        const doDelete = () => { removeFlexZone(confirmDeleteZoneId); setConfirmDeleteZoneId(null); };
        return (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
               onClick={() => setConfirmDeleteZoneId(null)}>
            <div className="bg-white rounded-xl shadow-lg p-5 max-w-xs mx-4"
                 onClick={(e) => e.stopPropagation()}>
              <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
                Delete this flex zone?
              </h3>
              <p className="text-sm text-warm-gray mb-4">
                "{zone.name}" will be removed, along with its paired route. This can't be undone.
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setConfirmDeleteZoneId(null)}
                  className="w-full px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-cream transition-colors"
                >
                  No, keep it
                </button>
                <button
                  onClick={doDelete}
                  className="w-full px-3 py-2 bg-red-500 text-white rounded-lg font-heading font-bold text-sm hover:bg-red-600 transition-colors"
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => { skipDeleteConfirmRef.current = true; doDelete(); }}
                  className="w-full px-3 py-2 bg-red-50 text-red-600 border border-red-200 rounded-lg font-heading font-semibold text-sm hover:bg-red-100 transition-colors"
                >
                  Yes, and don't ask again this session
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
