import { useMemo } from 'react';
import { Source, Layer } from 'react-map-gl/mapbox';
import type { LayerProps } from 'react-map-gl/mapbox';
import { useStore } from '../../store';

/**
 * Contextual highlight for the Stop Analysis panel. Mirrors CoverageLayer:
 * renders only while the Stop Analysis section is active and an overlay is set
 * (balancing removal candidates, accessibility gaps, or a trips/day ramp). The
 * panel owns the overlay state; this layer is a pure projection of it.
 */
export function StopAnalysisLayer() {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const overlay = useStore((s) => s.stopAnalysisOverlay);
  const stops = useStore((s) => s.stops);

  const geojson = useMemo(() => {
    if (sidebarSection !== 'stop-analysis' || !overlay) return null;
    const byId = new Map(stops.map((s) => [s.stop_id, s]));
    if (overlay.kind === 'intensity') {
      return {
        type: 'FeatureCollection' as const,
        features: Object.entries(overlay.trips)
          .map(([stopId, trips]) => {
            const s = byId.get(stopId);
            if (!s) return null;
            return {
              type: 'Feature' as const,
              properties: { trips },
              geometry: { type: 'Point' as const, coordinates: [s.stop_lon, s.stop_lat] },
            };
          })
          .filter(Boolean) as GeoJSON.Feature[],
      };
    }
    // balancing | accessibility — a flat stop-id set
    return {
      type: 'FeatureCollection' as const,
      features: overlay.stopIds
        .map((stopId) => {
          const s = byId.get(stopId);
          if (!s) return null;
          return {
            type: 'Feature' as const,
            properties: { stop_id: stopId },
            geometry: { type: 'Point' as const, coordinates: [s.stop_lon, s.stop_lat] },
          };
        })
        .filter(Boolean) as GeoJSON.Feature[],
    };
  }, [sidebarSection, overlay, stops]);

  if (!geojson || !overlay) return null;

  if (overlay.kind === 'intensity') {
    const max = Math.max(1, overlay.maxTrips);
    const rampFill: LayerProps = {
      id: 'analysis-intensity-fill',
      type: 'circle',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 8],
        // Light sand → deep teal as trips/day climbs toward the system max.
        'circle-color': [
          'interpolate', ['linear'], ['get', 'trips'],
          0, '#F2E9DE',
          max / 2, '#7FB2BD',
          max, '#2C5A66',
        ],
        'circle-stroke-color': '#FFFFFF',
        'circle-stroke-width': 1,
        'circle-opacity': 0.95,
      },
    };
    return (
      <Source id="analysis-intensity" type="geojson" data={geojson}>
        <Layer {...rampFill} />
      </Source>
    );
  }

  // balancing = amber removal candidates; accessibility = coral gap pins.
  const color = overlay.kind === 'balancing' ? '#E8A33D' : '#E0564C';
  const halo: LayerProps = {
    id: 'analysis-highlight-halo',
    type: 'circle',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 7, 14, 13],
      'circle-color': color,
      'circle-opacity': 0.25,
    },
  };
  const dot: LayerProps = {
    id: 'analysis-highlight-dot',
    type: 'circle',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 6],
      'circle-color': color,
      'circle-stroke-color': '#FFFFFF',
      'circle-stroke-width': 1.5,
    },
  };
  return (
    <Source id="analysis-highlight" type="geojson" data={geojson}>
      <Layer {...halo} />
      <Layer {...dot} />
    </Source>
  );
}
