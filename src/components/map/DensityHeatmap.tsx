import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import { useStore } from '../../store';
import type { LayerProps } from 'react-map-gl/mapbox';

interface DensityHeatmapProps {
  visible: boolean;
  metric: 'population' | 'workers' | 'households';
}

export function DensityHeatmap({ visible, metric }: DensityHeatmapProps) {
  const coverageData = useStore((s) => s.coverageData);

  const geojson = useMemo(() => {
    if (!coverageData?.blockGroups?.length) {
      return { type: 'FeatureCollection' as const, features: [] };
    }

    return {
      type: 'FeatureCollection' as const,
      features: coverageData.blockGroups
        .filter((bg) => bg.lat && bg.lon && bg[metric] > 0)
        .map((bg) => ({
          type: 'Feature' as const,
          properties: {
            weight: bg[metric],
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [bg.lon, bg.lat],
          },
        })),
    };
  }, [coverageData, metric]);

  if (!visible || geojson.features.length === 0) return null;

  const heatmapLayer: LayerProps = {
    id: 'density-heatmap',
    type: 'heatmap',
    paint: {
      // Weight by the metric value
      'heatmap-weight': [
        'interpolate', ['linear'],
        ['get', 'weight'],
        0, 0,
        100, 0.3,
        500, 0.6,
        2000, 1,
      ],
      // Increase radius with zoom
      'heatmap-radius': [
        'interpolate', ['linear'], ['zoom'],
        8, 15,
        12, 25,
        15, 40,
      ],
      // Color ramp: transparent → blue → green → yellow → red
      'heatmap-color': [
        'interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)',
        0.1, 'rgba(65,105,225,0.3)',
        0.3, 'rgba(0,180,180,0.5)',
        0.5, 'rgba(100,200,50,0.6)',
        0.7, 'rgba(230,180,30,0.7)',
        0.9, 'rgba(220,60,30,0.8)',
        1, 'rgba(180,0,30,0.9)',
      ],
      'heatmap-intensity': [
        'interpolate', ['linear'], ['zoom'],
        8, 1,
        15, 3,
      ],
      // Fade out at high zoom, show points instead
      'heatmap-opacity': [
        'interpolate', ['linear'], ['zoom'],
        13, 0.8,
        16, 0.3,
      ],
    },
  };

  return (
    <Source id="density-heatmap" type="geojson" data={geojson}>
      <Layer {...heatmapLayer} />
    </Source>
  );
}
