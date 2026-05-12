import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import type { LayerProps } from 'react-map-gl/mapbox';

export function StopLayer() {
  const stops = useStore((s) => s.stops);
  const routes = useStore((s) => s.routes);
  const routeStops = useStore((s) => s.routeStops);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const mapMode = useStore((s) => s.mapMode);
  const isEditingShape = mapMode === 'edit_shape';
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  // When the Stops panel is filtering, fade non-matching stops so the user
  // sees the filter in context. null = no overlay; render everything normally.
  const mapStopFilter = useStore((s) => s.mapStopFilter);

  const geojson = useMemo(() => {
    const hiddenSet = new Set(hiddenRouteIds);

    // Build a lookup: stop_id → primary route color (excluding hidden routes)
    const stopRouteColor = new Map<string, string>();
    const stopRouteCount = new Map<string, number>();
    // Track which stops are ONLY on hidden routes (to hide them entirely)
    const stopVisibleRoutes = new Map<string, number>();

    for (const rs of routeStops) {
      if (!hiddenSet.has(rs.route_id)) {
        stopVisibleRoutes.set(rs.stop_id, (stopVisibleRoutes.get(rs.stop_id) || 0) + 1);
      }
      const count = (stopRouteCount.get(rs.stop_id) || 0) + 1;
      stopRouteCount.set(rs.stop_id, count);

      // If this is the selected route, always use its color
      if (rs.route_id === selectedRouteId) {
        const route = routes.find((r) => r.route_id === rs.route_id);
        if (route) stopRouteColor.set(rs.stop_id, `#${route.route_color}`);
      }
      // Otherwise set only if not already set (first route wins)
      if (!stopRouteColor.has(rs.stop_id)) {
        const route = routes.find((r) => r.route_id === rs.route_id);
        if (route) stopRouteColor.set(rs.stop_id, `#${route.route_color}`);
      }
    }

    const matchedSet = mapStopFilter ? new Set(mapStopFilter.matched) : null;

    return {
      type: 'FeatureCollection' as const,
      features: stops
        .filter((stop) => {
          // Show stops that: have no route assignment, have at least one visible route, or are selected
          const visibleCount = stopVisibleRoutes.get(stop.stop_id) || 0;
          const totalCount = stopRouteCount.get(stop.stop_id) || 0;
          if (totalCount === 0) return true; // unassigned stop — always show
          if (stop.stop_id === selectedStopId) return true; // selected — always show
          return visibleCount > 0; // at least one visible route
        })
        .map((stop) => {
          const color = stopRouteColor.get(stop.stop_id) || '#8B7E74';
          const isSelected = stop.stop_id === selectedStopId;
          const numRoutes = stopRouteCount.get(stop.stop_id) || 0;
          const isFilteredOut = !!matchedSet && !matchedSet.has(stop.stop_id);

          return {
            type: 'Feature' as const,
            properties: {
              stop_id: stop.stop_id,
              stop_name: stop.stop_name,
              isSelected,
              color,
              numRoutes,
              isTransfer: numRoutes > 1,
              isFilteredOut,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [stop.stop_lon, stop.stop_lat],
            },
          };
        }),
    };
  }, [stops, routes, routeStops, selectedStopId, selectedRouteId, hiddenRouteIds, mapStopFilter]);

  // Outer ring — route-colored border. Filter-faded stops shrink, gray out,
  // and drop opacity so they're context, not foreground.
  const outerCircle: LayerProps = {
    id: 'stop-circles-outer',
    type: 'circle',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, [
          'case',
          ['get', 'isFilteredOut'], 1.5,
          ['get', 'isSelected'], 6,
          3,
        ],
        14, [
          'case',
          ['get', 'isFilteredOut'], 3,
          ['get', 'isSelected'], 10,
          ['case', ['get', 'isTransfer'], 7, 6],
        ],
      ],
      'circle-color': [
        'case',
        ['get', 'isFilteredOut'], '#B8AFA5',
        ['get', 'color'],
      ],
      'circle-opacity': isEditingShape ? 0.15 : [
        'case',
        ['get', 'isFilteredOut'], 0.45,
        ['get', 'isSelected'], 1,
        0.9,
      ],
    },
  };

  // Inner fill — white circle (or route-colored when selected). Filtered-out
  // stops use the same gray so the dot reads as a single muted dot.
  const innerCircle: LayerProps = {
    id: 'stop-circles',
    type: 'circle',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, [
          'case',
          ['get', 'isFilteredOut'], 0.6,
          ['get', 'isSelected'], 3,
          1.5,
        ],
        14, [
          'case',
          ['get', 'isFilteredOut'], 1.2,
          ['get', 'isSelected'], 5,
          ['case', ['get', 'isTransfer'], 4, 3.5],
        ],
      ],
      'circle-color': [
        'case',
        ['get', 'isFilteredOut'], '#B8AFA5',
        ['get', 'isSelected'], ['get', 'color'],
        '#FFFFFF',
      ],
      'circle-opacity': isEditingShape ? 0.15 : [
        'case',
        ['get', 'isFilteredOut'], 0.6,
        1,
      ],
    },
  };

  // Selected stop — extra white outer ring for emphasis (hidden during shape editing)
  const selectionRing: LayerProps = {
    id: 'stop-selection-ring',
    type: 'circle',
    filter: isEditingShape ? ['==', 'impossible', 'true'] : ['==', ['get', 'isSelected'], true],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        10, 8,
        14, 13,
      ],
      'circle-color': 'transparent',
      'circle-stroke-color': '#FFFFFF',
      'circle-stroke-width': 3,
    },
  };

  // Transfer indicator — small diamond/dot for multi-route stops
  // (the larger size from outerCircle already handles this visually)

  // Labels
  const labelStyle: LayerProps = {
    id: 'stop-labels',
    type: 'symbol',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'stop_name'],
      'text-size': [
        'case',
        ['get', 'isSelected'], 12,
        11,
      ],
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-font': [
        'case',
        ['get', 'isSelected'],
        ['literal', ['DIN Pro Bold', 'Arial Unicode MS Bold']],
        ['literal', ['DIN Pro Medium', 'Arial Unicode MS Regular']],
      ],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': [
        'case',
        ['get', 'isSelected'], ['get', 'color'],
        '#3D2E22',
      ],
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 2,
      'text-opacity': isEditingShape ? 0.1 : 1,
    },
  };

  return (
    <Source id="stops" type="geojson" data={geojson}>
      <Layer {...selectionRing} />
      <Layer {...outerCircle} />
      <Layer {...innerCircle} />
      <Layer {...labelStyle} />
    </Source>
  );
}
