import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import simplify from '@turf/simplify';
import { lineString } from '@turf/helpers';
import { useStore } from '../../store';
import { getArrowColor } from '../../utils/colors';
import type { LayerProps } from 'react-map-gl/mapbox';

// Ramer–Douglas–Peucker tolerance (degrees, ~20 m) used only when rendering a
// very large feed zoomed out. Display-only — drops vertices that aren't
// distinguishable at that scale; the stored shapes are never modified.
const SIMPLIFY_TOLERANCE = 0.0002;

/** Reduce a coordinate list for display. Geometry-only (no distance recalc),
 * so it stays cheap even on dense regional shapes. */
function simplifyCoords(coords: [number, number][]): [number, number][] {
  if (coords.length <= 2) return coords;
  try {
    return simplify(lineString(coords), { tolerance: SIMPLIFY_TOLERANCE, highQuality: false })
      .geometry.coordinates as [number, number][];
  } catch {
    return coords;
  }
}

/** `simplified` is set by MapView once too many shape points are in the
 * viewport for a very large feed; it swaps full geometry for a decimated copy
 * so Mapbox isn't handed hundreds of thousands of coordinates at once. */
export function RouteLayer({ simplified = false }: { simplified?: boolean }) {
  const shapes = useStore((s) => s.shapes);
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const editingShapeId = useStore((s) => s.editingShapeId);
  const mapMode = useStore((s) => s.mapMode);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  const hiddenRouteTypes = useStore((s) => s.hiddenRouteTypes);
  const hiddenShapeIds = useStore((s) => s.hiddenShapeIds);
  const bottomPanelOpen = useStore((s) => s.bottomPanelOpen);
  const bottomPanelTab = useStore((s) => s.bottomPanelTab);
  const timetableDirectionId = useStore((s) => s.timetableDirectionId);
  const isTimetableEditing = bottomPanelOpen && bottomPanelTab === 'timetable' && !!selectedRouteId;
  // Route › Stops tab + a direction picked → emphasize that direction's
  // shape over the other so the user can see which line they're editing.
  const sidebarSection = useStore((s) => s.sidebarSection);
  const editingRouteId = useStore((s) => s.editingRouteId);
  const routeDetailTab = useStore((s) => s.routeDetailTab);
  const stopPlacementDirection = useStore((s) => s.stopPlacementDirection);
  // The exact shape whose stop list the Stops subpanel is editing. Keying the
  // highlight on this (not just the direction) means switching the Direction
  // dropdown — or picking among same-direction pattern variants — moves the
  // emphasis to that shape. Falls back to the empty string so the `==` never
  // matches a real shape_id when nothing is active.
  const stopPlacementShapeId = useStore((s) => s.stopPlacementShapeId);
  const isRouteStopsEditing =
    sidebarSection === 'routes'
    && routeDetailTab === 'stops'
    && !!editingRouteId;

  const geojson = useMemo(() => {
    const hiddenRouteSet = new Set(hiddenRouteIds);
    const hiddenShapeSet = new Set(hiddenShapeIds);
    const hiddenTypeSet = new Set(hiddenRouteTypes);
    const features = shapes
    // Hide the shape being edited in draw (to avoid double-rendering)
    .filter((shape) => !(mapMode === 'edit_shape' && shape.shape_id === editingShapeId))
    .map((shape) => {
      const trip = trips.find((t) => t.shape_id === shape.shape_id);
      // Resolve the shape's route via its trip, falling back to the editor-only
      // draft association for a freshly drawn shape that has no trip yet — so it
      // still renders in its route color and highlights when selected.
      const routeId = trip?.route_id ?? shape._route_id;
      const route = routeId ? routes.find((r) => r.route_id === routeId) : null;
      // Skip hidden routes or individually hidden shapes
      if (route && hiddenRouteSet.has(route.route_id)) return null;
      if (hiddenShapeSet.has(shape.shape_id)) return null;
      const isSelected = route?.route_id === selectedRouteId;

      return {
        type: 'Feature' as const,
        properties: {
          shape_id: shape.shape_id,
          route_id: route?.route_id || '',
          route_name: route?.route_short_name || route?.route_long_name || '',
          color: route ? `#${route.route_color}` : '#888888',
          // Arrow color: high-luminance route colors (gold, green, cyan, pink,
          // orange) are darkened so the ▸ glyph is legible on the light-v11 map
          // and never confused with a nearby darker route's arrows.
          arrowColor: route ? getArrowColor(route.route_color) : '#555555',
          isSelected,
          direction_id: trip?.direction_id ?? 0,
          // Route-type filter: dim (don't hide) routes of a filtered-out mode.
          typeDimmed: route ? hiddenTypeSet.has(route.route_type) : false,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: ((coords: [number, number][]) => (simplified ? simplifyCoords(coords) : coords))(
            shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]),
          ),
        },
      };
    }).filter((f): f is NonNullable<typeof f> => f !== null);

    return { type: 'FeatureCollection' as const, features };
  }, [shapes, routes, trips, selectedRouteId, editingShapeId, mapMode, hiddenRouteIds, hiddenRouteTypes, hiddenShapeIds, simplified]);

  const isEditing = mapMode === 'edit_shape';
  // Any route-editing context (detail panel open) — de-emphasize the other
  // routes so the one being edited stands out, even on a large feed.
  const isEditingRoute = !!editingRouteId;

  // While editing a route's stops, the active shape is the one to spotlight.
  // Match on its shape_id when one is active (so same-direction variants and
  // trip-less shapes resolve correctly); otherwise fall back to the active
  // direction for routes that have no shaped pattern yet.
  const activeStopShapeMatch: unknown[] = stopPlacementShapeId
    ? ['==', ['get', 'shape_id'], stopPlacementShapeId]
    : ['==', ['get', 'direction_id'], stopPlacementDirection];

  // Base line styling — dimmed when editing a shape
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
      // Routes of a filtered-out type are dimmed (visibly disabled) regardless
      // of the editing context.
      'line-opacity': ['case',
        ['get', 'typeDimmed'], 0.12,
        isEditing
          ? 0.15
          : isTimetableEditing
            ? ['case',
                ['all', ['get', 'isSelected'], ['==', ['get', 'direction_id'], timetableDirectionId]], 1,
                ['get', 'isSelected'], 0.4,
                0.2,
              ]
            : isRouteStopsEditing
              ? ['case',
                  ['all', ['get', 'isSelected'], activeStopShapeMatch], 1,
                  ['get', 'isSelected'], 0.3,
                  0.2,
                ]
              : isEditingRoute
                ? ['case', ['get', 'isSelected'], 1, 0.2]
                : ['case', ['get', 'isSelected'], 1, 0.7],
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
      // Arial Unicode MS is specified explicitly so the ▸ glyph (U+25B8) is
      // loaded from a comprehensive font rather than relying on map-style
      // fallbacks that may not include the Geometric Shapes block.
      'text-font': ['DIN Pro Regular', 'Arial Unicode MS Regular'],
      'text-keep-upright': false,
      'text-rotation-alignment': 'map',
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      // Use the pre-computed arrowColor (darkened for high-luminance routes) so
      // that light route colors (gold, green, cyan…) produce clearly visible,
      // on-color arrows rather than washing out on the light-v11 background and
      // being mistaken for the arrows of a nearby darker route.
      'text-color': ['get', 'arrowColor'],
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 1,
      'text-opacity': ['case',
        ['get', 'typeDimmed'], 0,
        isEditing
          ? 0.1
          : isTimetableEditing
            ? ['case',
                ['all', ['get', 'isSelected'], ['==', ['get', 'direction_id'], timetableDirectionId]], 1,
                ['get', 'isSelected'], 0.3,
                0.15,
              ]
            : isRouteStopsEditing
              ? ['case',
                  ['all', ['get', 'isSelected'], activeStopShapeMatch], 1,
                  ['get', 'isSelected'], 0.25,
                  0.15,
                ]
              : ['case', ['get', 'isSelected'], 1, 0.6],
      ],
    },
  };

  // Route name labels (hidden during editing)
  const nameLabelStyle: LayerProps = {
    id: 'route-labels',
    type: 'symbol',
    minzoom: 13,
    filter: isEditing ? ['==', 'impossible', 'true'] : ['==', ['get', 'isSelected'], true],
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
