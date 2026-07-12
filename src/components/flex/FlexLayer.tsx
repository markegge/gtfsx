import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { featureCollection } from '@turf/helpers';
import { useStore } from '../../store';
import { featureEnabled } from '../../store/featuresSlice';
import { findFlexZoneRoute } from './flexHelpers';

const DEFAULT_FLEX_COLOR = '#7C3AED';

function resolveFlexColor(routeColor?: string): string {
  if (!routeColor) return DEFAULT_FLEX_COLOR;
  const hex = routeColor.startsWith('#') ? routeColor : `#${routeColor}`;
  return /^#[0-9A-F]{6}$/i.test(hex) ? hex : DEFAULT_FLEX_COLOR;
}

export function FlexLayer() {
  const flexZones = useStore((s) => s.flexZones);
  const routes = useStore((s) => s.routes);
  const editingFlexZoneId = useStore((s) => s.editingFlexZoneId);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  // Demand response can be turned off in Settings (data is kept but hidden) —
  // when it's off, the zones shouldn't render on the map either.
  const demandResponseOn = useStore((s) => featureEnabled(s, 'demandResponse'));

  const combinedGeojson = useMemo(() => {
    // Exclude the zone currently being edited in draw (draw renders it instead)
    // and any zone whose associated route is hidden via the routes pane.
    // findFlexZoneRoute pairs by explicit zone.routeId, falling back to the
    // legacy name match for zones (older feeds, some import paths) that leave
    // routeId unset.
    const hiddenSet = new Set(hiddenRouteIds);
    const zoneRoutes = new Map(flexZones.map((z) => [z.id, findFlexZoneRoute(routes, z)]));
    const zones = flexZones.filter((z) => {
      if (z.id === editingFlexZoneId) return false;
      const route = zoneRoutes.get(z.id);
      return !route || !hiddenSet.has(route.route_id);
    });
    if (zones.length === 0) return featureCollection([]) as GeoJSON.FeatureCollection;
    const allFeatures = zones.flatMap((z) => {
      const color = resolveFlexColor(zoneRoutes.get(z.id)?.route_color);
      return z.geojson.features.map((f) => ({
        ...f,
        properties: {
          ...f.properties,
          zoneId: z.id,
          zoneName: z.name,
          color,
        },
      }));
    });
    return featureCollection(allFeatures) as GeoJSON.FeatureCollection;
  }, [flexZones, editingFlexZoneId, routes, hiddenRouteIds]);

  if (!demandResponseOn || flexZones.length === 0) return null;

  return (
    <Source id="flex-zones" type="geojson" data={combinedGeojson}>
      {/*
        Flex zones are symbolized by the dashed outline only — a visible fill
        made the (often large) service areas dominate the map. The click target
        is this invisible "hit" line tracing the zone boundary: an opacity-0
        line is still returned by queryRenderedFeatures, so clicking ON (or just
        beside) the outline opens the zone popup, while clicking the empty
        interior does nothing. It's wider than the visible outline so it's easy
        to hit, and solid (no dash gaps) so the whole boundary is live (see
        MapView's interactiveLayerIds + the 'flex-zone-hit' check in
        handleMapClick). Do NOT delete this layer — without it the zone would
        only be selectable on the thin, gappy dashed line.
      */}
      <Layer
        id="flex-zone-hit"
        type="line"
        paint={{
          'line-color': '#000000',
          'line-opacity': 0,
          'line-width': 14,
        }}
      />
      <Layer
        id="flex-zone-outline"
        type="line"
        paint={{
          'line-color': ['coalesce', ['get', 'color'], DEFAULT_FLEX_COLOR],
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.7,
        }}
      />
    </Source>
  );
}
