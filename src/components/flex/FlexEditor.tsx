import { useCallback, useState } from 'react';
import buffer from '@turf/buffer';
import { featureCollection, multiLineString } from '@turf/helpers';
import { useStore } from '../../store';
import { EmptyState } from '../ui/EmptyState';
import type { FlexZone } from '../../store/flexSlice';

const FLEX_BUFFER_MILES = 0.75;

let zoneCounter = 1;

function generateServiceArea(
  shapes: ReturnType<typeof useStore.getState>['shapes'],
  routes: ReturnType<typeof useStore.getState>['routes'],
  trips: ReturnType<typeof useStore.getState>['trips'],
  hiddenRouteIds: string[],
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
  const buffered = buffer(ml, FLEX_BUFFER_MILES, { units: 'miles' });
  if (!buffered) return null;

  return featureCollection([buffered]) as GeoJSON.FeatureCollection;
}

export function FlexEditor() {
  const { shapes, routes, trips, hiddenRouteIds, flexZones, addFlexZone, removeFlexZone } = useStore();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busRoutes = routes.filter((r) => r.route_type !== 0 && !hiddenRouteIds.includes(r.route_id));

  const handleGenerate = useCallback(() => {
    setError(null);
    setGenerating(true);
    try {
      const geojson = generateServiceArea(shapes, routes, trips, hiddenRouteIds);
      if (!geojson || geojson.features.length === 0) {
        setError('No visible bus route shapes found. Draw routes on the map first.');
        return;
      }
      const zone: FlexZone = {
        id: `flex-zone-${Date.now()}`,
        name: `Service Area ${zoneCounter++}`,
        bufferMiles: FLEX_BUFFER_MILES,
        geojson,
      };
      addFlexZone(zone);
    } catch (e: any) {
      setError(e.message || 'Failed to generate service area');
    } finally {
      setGenerating(false);
    }
  }, [shapes, routes, trips, hiddenRouteIds, addFlexZone]);

  const hasShapes = shapes.some((s) => {
    const trip = trips.find((t) => t.shape_id === s.shape_id);
    if (!trip) return false;
    const route = routes.find((r) => r.route_id === trip.route_id);
    return route && route.route_type !== 0 && !hiddenRouteIds.includes(route.route_id);
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading font-bold text-base text-dark-brown mb-1">GTFS-Flex</h2>
        <p className="text-xs text-warm-gray">
          Define demand-responsive transit zones for dial-a-ride, microtransit, and deviated fixed-route services.
        </p>
      </div>

      {/* Auto-generate from fixed routes */}
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-2">
        <p className="text-xs font-semibold text-purple-800">Auto-generate from fixed routes</p>
        <p className="text-[11px] text-purple-700">
          Creates a ¾-mile service area buffer around all visible bus routes
          ({busRoutes.length} route{busRoutes.length !== 1 ? 's' : ''} visible).
          Light rail / tram routes are excluded.
        </p>
        {error && (
          <p className="text-[11px] text-red-600">{error}</p>
        )}
        <button
          onClick={handleGenerate}
          disabled={generating || !hasShapes}
          className="w-full px-3 py-2 bg-purple text-white rounded-lg text-xs font-heading font-bold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {generating ? 'Generating…' : 'Generate ¾ mi Buffer'}
        </button>
        {!hasShapes && (
          <p className="text-[11px] text-purple-600 opacity-70">
            Draw route shapes on the map to enable this feature.
          </p>
        )}
      </div>

      {/* Zone list */}
      {flexZones.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-dark-brown uppercase tracking-wide">
            Defined Service Areas
          </p>
          {flexZones.map((zone) => (
            <div
              key={zone.id}
              className="flex items-center gap-2 px-3 py-2 bg-cream rounded-lg border border-sand"
            >
              <span
                className="w-3 h-3 rounded-sm shrink-0 border border-purple-300"
                style={{ backgroundColor: 'rgba(124,58,237,0.2)' }}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-dark-brown truncate">{zone.name}</p>
                <p className="text-[11px] text-warm-gray">
                  {zone.geojson.features.length} polygon{zone.geojson.features.length !== 1 ? 's' : ''} · {zone.bufferMiles} mi buffer
                </p>
              </div>
              <button
                onClick={() => removeFlexZone(zone.id)}
                className="text-warm-gray hover:text-red-500 transition-colors text-sm leading-none px-1"
                title="Remove zone"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="📍"
          title="No service areas yet"
          description="Generate a service area from your fixed routes, or draw zones manually (coming soon)."
        />
      )}

      <div className="border-t border-sand pt-3">
        <p className="text-[10px] text-warm-gray">
          Service areas are exported as <code className="px-1 bg-sand rounded">locations.geojson</code> per the GTFS-Flex specification.
          Booking rules and time windows will be configurable in a future update.
        </p>
      </div>
    </div>
  );
}
