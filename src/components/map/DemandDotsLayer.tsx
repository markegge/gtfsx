import { Source, Layer } from 'react-map-gl/mapbox';
import type { LayerProps } from 'react-map-gl/mapbox';

const ARCHIVE = 'us-2026';
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
      8, 0.4,
      11, 0.8,
      13, 1.25,
      15, 2,
    ],
    // Blue + orange + gray is the canonical colorblind-safe trio
    // (Okabe-Ito / ColorBrewer diverging blue-orange). Jobs stay orange;
    // high-propensity is blue; other adults are neutral gray.
    'circle-color': [
      'match', ['get', 'class'],
      'high', '#2563eb',
      'jobs', '#f97316',
      'other', '#9ca3af',
      '#9ca3af',
    ],
    'circle-opacity': [
      'interpolate', ['linear'], ['zoom'],
      8, 0.35,
      11, 0.55,
      13, 0.7,
      15, 0.85,
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
      minzoom={8}
      maxzoom={15}
    >
      <Layer {...layerStyle} beforeId="stop-circles-outer" />
    </Source>
  );
}
