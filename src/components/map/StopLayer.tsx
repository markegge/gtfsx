import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import type { LayerProps } from 'react-map-gl/mapbox';

export function StopLayer() {
  const stops = useStore((s) => s.stops);
  const selectedStopId = useStore((s) => s.selectedStopId);

  const geojson = useMemo(() => ({
    type: 'FeatureCollection' as const,
    features: stops.map((stop) => ({
      type: 'Feature' as const,
      properties: {
        stop_id: stop.stop_id,
        stop_name: stop.stop_name,
        isSelected: stop.stop_id === selectedStopId,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [stop.stop_lon, stop.stop_lat],
      },
    })),
  }), [stops, selectedStopId]);

  const circleStyle: LayerProps = {
    id: 'stop-circles',
    type: 'circle',
    paint: {
      'circle-radius': [
        'case',
        ['get', 'isSelected'], 8,
        5,
      ],
      'circle-color': [
        'case',
        ['get', 'isSelected'], '#E8734A',
        '#FFFFFF',
      ],
      'circle-stroke-color': [
        'case',
        ['get', 'isSelected'], '#FFFFFF',
        '#E8734A',
      ],
      'circle-stroke-width': 2.5,
    },
  };

  const labelStyle: LayerProps = {
    id: 'stop-labels',
    type: 'symbol',
    minzoom: 13,
    layout: {
      'text-field': ['get', 'stop_name'],
      'text-size': 11,
      'text-offset': [0, 1.5],
      'text-anchor': 'top',
      'text-max-width': 10,
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
    },
    paint: {
      'text-color': '#3D2E22',
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 1.5,
    },
  };

  return (
    <Source id="stops" type="geojson" data={geojson}>
      <Layer {...circleStyle} />
      <Layer {...labelStyle} />
    </Source>
  );
}
