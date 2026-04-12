import { Source, Layer } from 'react-map-gl/mapbox';
import type { LayerProps } from 'react-map-gl/mapbox';

const ARCHIVE = 'mt-2026';
const TILE_URL = `${window.location.origin}/_demand-tiles/${ARCHIVE}/{z}/{x}/{y}.pbf`;

interface Props {
  visible: boolean;
}

const layerStyle: LayerProps = {
  id: 'demand-dots',
  type: 'circle',
  source: 'demand-dots',
  'source-layer': 'demand',
  paint: {
    'circle-radius': [
      'interpolate', ['linear'], ['zoom'],
      6, 0.3,
      10, 0.8,
      12, 1.25,
      15, 2,
    ],
    'circle-color': [
      'match', ['get', 'class'],
      'high', '#22c55e',
      'jobs', '#f97316',
      'other', '#9ca3af',
      '#9ca3af',
    ],
    'circle-opacity': [
      'interpolate', ['linear'], ['zoom'],
      6, 0.3,
      10, 0.5,
      12, 0.6,
      15, 0.8,
    ],
    'circle-stroke-width': 0,
  },
};

export function DemandDotsLayer({ visible }: Props) {
  if (!visible) return null;
  return (
    <Source
      id="demand-dots"
      type="vector"
      tiles={[TILE_URL]}
      minzoom={6}
      maxzoom={15}
    >
      <Layer {...layerStyle} beforeId="stop-circles-outer" />
    </Source>
  );
}
