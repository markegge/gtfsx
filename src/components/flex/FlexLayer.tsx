import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { featureCollection } from '@turf/helpers';
import { useStore } from '../../store';

export function FlexLayer() {
  const flexZones = useStore((s) => s.flexZones);
  const editingFlexZoneId = useStore((s) => s.editingFlexZoneId);

  const combinedGeojson = useMemo(() => {
    // Exclude the zone currently being edited in draw (draw renders it instead)
    const zones = flexZones.filter((z) => z.id !== editingFlexZoneId);
    if (zones.length === 0) return featureCollection([]) as GeoJSON.FeatureCollection;
    const allFeatures = zones.flatMap((z) =>
      z.geojson.features.map((f) => ({
        ...f,
        properties: { ...f.properties, zoneId: z.id, zoneName: z.name },
      })),
    );
    return featureCollection(allFeatures) as GeoJSON.FeatureCollection;
  }, [flexZones, editingFlexZoneId]);

  if (flexZones.length === 0) return null;

  return (
    <Source id="flex-zones" type="geojson" data={combinedGeojson}>
      <Layer
        id="flex-zone-fill"
        type="fill"
        paint={{ 'fill-color': '#7C3AED', 'fill-opacity': 0.12 }}
      />
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
