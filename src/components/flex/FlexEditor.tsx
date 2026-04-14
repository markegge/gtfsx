import { useCallback, useState } from 'react';
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
    flexZones, removeFlexZone,
    mapMode, setMapMode, editingFlexZoneId, setEditingFlexZoneId,
  } = useStore();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bufferInput, setBufferInput] = useState<string>(String(DEFAULT_FLEX_BUFFER_MILES));
  const [expandedZoneId, setExpandedZoneId] = useState<string | null>(null);

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
    } catch (e: any) {
      setError(e.message || 'Failed to generate service area');
    } finally {
      setGenerating(false);
    }
  }, [shapes, routes, trips, hiddenRouteIds, bufferMiles, bufferValid]);

  const handleDrawZone = () => {
    setMapMode('draw_flex_zone');
  };

  const handleEditZone = (zone: FlexZone) => {
    setEditingFlexZoneId(zone.id);
    setMapMode('edit_flex_zone');
  };

  const handleSaveEdit = () => {
    (window as any).__flexZoneEditSave?.();
  };

  const handleCancelEdit = () => {
    (window as any).__flexZoneEditDiscard?.();
  };

  const isDrawing = mapMode === 'draw_flex_zone';
  const isEditing = mapMode === 'edit_flex_zone';

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading font-bold text-base text-dark-brown mb-1">GTFS-Flex</h2>
        <p className="text-xs text-warm-gray">
          Define demand-responsive transit zones for dial-a-ride, microtransit, and deviated fixed-route services.
        </p>
      </div>

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
        <>
          {/* Draw zone manually */}
          <button
            onClick={handleDrawZone}
            className="w-full px-3 py-2 bg-purple text-white rounded-lg text-xs font-heading font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
          >
            <span>✏</span> Draw Zone on Map
          </button>

          {/* Auto-generate from fixed routes */}
          <div className="bg-cream border border-sand rounded-lg p-3 space-y-2">
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
              onClick={handleGenerate}
              disabled={generating || !hasShapes || !bufferValid}
              className="w-full px-3 py-2 bg-teal text-white rounded-lg text-xs font-heading font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {generating ? 'Generating…' : `Generate ${bufferValid ? bufferMiles : '?'} mi Buffer`}
            </button>
            {!hasShapes && (
              <p className="text-[11px] text-warm-gray">Draw route shapes on the map to enable.</p>
            )}
          </div>
        </>
      )}

      {/* Zone list */}
      {flexZones.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold text-dark-brown uppercase tracking-wide">
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
                    <p className="text-sm font-medium text-dark-brown truncate">{zone.name}</p>
                    <p className="text-[11px] text-warm-gray">
                      {zone.geojson.features.length} polygon{zone.geojson.features.length !== 1 ? 's' : ''}
                      {zone.bufferMiles > 0 ? ` · ${zone.bufferMiles} mi buffer` : ' · hand-drawn'}
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
                        title="Edit zone shape"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => removeFlexZone(zone.id)}
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
    </div>
  );
}
