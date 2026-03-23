import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import type { LayerProps } from 'react-map-gl/mapbox';

export function RouteLayer() {
  const shapes = useStore((s) => s.shapes);
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const editingShapeId = useStore((s) => s.editingShapeId);
  const mapMode = useStore((s) => s.mapMode);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);

  const geojson = useMemo(() => {
    const hiddenSet = new Set(hiddenRouteIds);
    const features = shapes
    // Hide the shape being edited in draw (to avoid double-rendering)
    .filter((shape) => !(mapMode === 'edit_shape' && shape.shape_id === editingShapeId))
    .map((shape) => {
      const trip = trips.find((t) => t.shape_id === shape.shape_id);
      const route = trip ? routes.find((r) => r.route_id === trip.route_id) : null;
      // Skip hidden routes
      if (route && hiddenSet.has(route.route_id)) return null;
      const isSelected = route?.route_id === selectedRouteId;

      return {
        type: 'Feature' as const,
        properties: {
          shape_id: shape.shape_id,
          route_id: route?.route_id || '',
          route_name: route?.route_short_name || route?.route_long_name || '',
          color: route ? `#${route.route_color}` : '#888888',
          isSelected,
          direction_id: trip?.direction_id ?? 0,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat]),
        },
      };
    }).filter((f): f is NonNullable<typeof f> => f !== null);

    return { type: 'FeatureCollection' as const, features };
  }, [shapes, routes, trips, selectedRouteId, editingShapeId, mapMode, hiddenRouteIds]);

  // Base line styling
  const lineStyle: LayerProps = {
    id: 'route-lines',
    type: 'line',
    paint: {
      'line-color': ['get', 'color'],
      'line-width': [
        'case',
        ['get', 'isSelected'], 5,
        3,
      ],
      'line-opacity': [
        'case',
        ['get', 'isSelected'], 1,
        0.7,
      ],
    },
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
  };

  // Direction arrows along the line
  const arrowStyle: LayerProps = {
    id: 'route-arrows',
    type: 'symbol',
    minzoom: 12,
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 80,
      'text-field': '▸',
      'text-size': [
        'case',
        ['get', 'isSelected'], 16,
        12,
      ],
      'text-keep-upright': false,
      'text-rotation-alignment': 'map',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 1,
      'text-opacity': [
        'case',
        ['get', 'isSelected'], 1,
        0.6,
      ],
    },
  };

  // Route name labels (only on selected or at high zoom)
  const nameLabelStyle: LayerProps = {
    id: 'route-labels',
    type: 'symbol',
    minzoom: 13,
    filter: ['==', ['get', 'isSelected'], true],
    layout: {
      'symbol-placement': 'line-center',
      'text-field': ['get', 'route_name'],
      'text-size': 13,
      'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
      'text-rotation-alignment': 'map',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 2,
    },
  };

  return (
    <Source id="routes" type="geojson" data={geojson}>
      <Layer {...lineStyle} />
      <Layer {...arrowStyle} />
      <Layer {...nameLabelStyle} />
    </Source>
  );
}
