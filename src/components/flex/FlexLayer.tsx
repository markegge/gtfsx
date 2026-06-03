import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { featureCollection } from '@turf/helpers';
import { useStore } from '../../store';
import { featureEnabled } from '../../store/featuresSlice';

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
    // Link first by explicit zone.routeId; fall back to matching zone.name
    // against route_short_name / route_long_name, since legacy zones and
    // some import paths leave routeId unset.
    const hiddenSet = new Set(hiddenRouteIds);
    const hiddenNameSet = new Set<string>();
    for (const r of routes) {
      if (!hiddenSet.has(r.route_id)) continue;
      const short = (r.route_short_name || '').trim();
      const long = (r.route_long_name || '').trim();
      if (short) hiddenNameSet.add(short);
      if (long) hiddenNameSet.add(long);
    }
    const isHidden = (z: typeof flexZones[number]): boolean => {
      if (z.routeId && hiddenSet.has(z.routeId)) return true;
      const name = (z.name || '').trim();
      if (name && hiddenNameSet.has(name)) return true;
      return false;
    };
    const zones = flexZones.filter(
      (z) => z.id !== editingFlexZoneId && !isHidden(z),
    );
    if (zones.length === 0) return featureCollection([]) as GeoJSON.FeatureCollection;
    const routesById = new Map(routes.map((r) => [r.route_id, r]));
    const allFeatures = zones.flatMap((z) => {
      const route = z.routeId ? routesById.get(z.routeId) : undefined;
      const color = resolveFlexColor(route?.route_color);
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
      <Layer
        id="flex-zone-fill"
        type="fill"
        paint={{
          'fill-color': ['coalesce', ['get', 'color'], DEFAULT_FLEX_COLOR],
          'fill-opacity': 0.12,
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
