import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { featureCollection } from '@turf/helpers';
import { useStore } from '../../store';

export function FlexLayer() {
  const flexZones = useStore((s) => s.flexZones);
  const sidebarSection = useStore((s) => s.sidebarSection);

  // Only render when the flex panel is active or zones exist
  const visible = flexZones.length > 0;

  const combinedGeojson = useMemo(() => {
    if (flexZones.length === 0) return featureCollection([]) as GeoJSON.FeatureCollection;
    const allFeatures = flexZones.flatMap((z) =>
      z.geojson.features.map((f) => ({
        ...f,
        properties: { ...f.properties, zoneId: z.id, zoneName: z.name },
      })),
    );
    return featureCollection(allFeatures) as GeoJSON.FeatureCollection;
  }, [flexZones]);

  if (!visible) return null;

  return (
    <Source id="flex-zones" type="geojson" data={combinedGeojson}>
      {/* Fill */}
      <Layer
        id="flex-zone-fill"
        type="fill"
        paint={{
          'fill-color': '#7C3AED',
          'fill-opacity': 0.12,
        }}
      />
      {/* Outline */}
      <Layer
        id="flex-zone-outline"
        type="line"
        paint={{
          'line-color': '#7C3AED',
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.7,
        }}
      />
    </Source>
  );
}
