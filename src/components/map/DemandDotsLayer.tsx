import { useState, useEffect, useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import type { LayerProps } from 'react-map-gl/mapbox';

interface Props {
  visible: boolean;
}

export function DemandDotsLayer({ visible }: Props) {
  const [data, setData] = useState<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    if (!visible || data) return;
    fetch('/data/demand_dots.geojson')
      .then((r) => {
        if (!r.ok) throw new Error('Not found');
        return r.json();
      })
      .then((geojson) => setData(geojson))
      .catch(() => {});
  }, [visible, data]);

  const layerStyle: LayerProps = useMemo(() => ({
    id: 'demand-dots',
    type: 'circle',
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        8, 0.5,
        12, 1.25,
        15, 2,
      ],
      'circle-color': [
        'match', ['get', 'class'],
        'high', '#22c55e',     // green
        'jobs', '#f97316',     // orange
        'housing', '#3b82f6',  // blue
        'other', '#9ca3af',    // gray
        '#9ca3af',
      ],
      'circle-opacity': [
        'interpolate', ['linear'], ['zoom'],
        8, 0.4,
        12, 0.6,
        15, 0.8,
      ],
      'circle-stroke-width': 0,
    },
  }), []);

  if (!visible || !data) return null;

  return (
    <Source id="demand-dots" type="geojson" data={data}>
      <Layer {...layerStyle} beforeId="stop-circles-outer" />
    </Source>
  );
}
