import { useEffect } from 'react';
import { useControl } from 'react-map-gl/mapbox';
import MapboxDraw from '@mapbox/mapbox-gl-draw';

// @ts-ignore - mapbox-gl-draw CSS
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';

interface DrawControlProps {
  onCreate?: (e: any) => void;
  onUpdate?: (e: any) => void;
  onDelete?: (e: any) => void;
  drawRef?: import('react').MutableRefObject<MapboxDraw | null>;
}

export function DrawControl({ onCreate, onUpdate, onDelete, drawRef }: DrawControlProps) {
  const draw = useControl<MapboxDraw>(
    () => {
      const d = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: 'simple_select',
        styles: [
          // Line during drawing
          {
            id: 'gl-draw-line',
            type: 'line',
            filter: ['all', ['==', '$type', 'LineString'], ['!=', 'mode', 'static']],
            paint: {
              'line-color': '#E8734A',
              'line-width': 3,
              'line-dasharray': [2, 2],
            },
          },
          // Vertices
          {
            id: 'gl-draw-point',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'vertex']],
            paint: {
              'circle-radius': 6,
              'circle-color': '#fff',
              'circle-stroke-color': '#E8734A',
              'circle-stroke-width': 2,
            },
          },
          // Midpoints
          {
            id: 'gl-draw-midpoint',
            type: 'circle',
            filter: ['all', ['==', '$type', 'Point'], ['==', 'meta', 'midpoint']],
            paint: {
              'circle-radius': 4,
              'circle-color': '#E8734A',
              'circle-opacity': 0.5,
            },
          },
          // Polygon fill (for flex zones)
          {
            id: 'gl-draw-polygon-fill',
            type: 'fill',
            filter: ['all', ['==', '$type', 'Polygon']],
            paint: {
              'fill-color': '#7B68EE',
              'fill-opacity': 0.15,
            },
          },
          // Polygon outline
          {
            id: 'gl-draw-polygon-stroke',
            type: 'line',
            filter: ['all', ['==', '$type', 'Polygon']],
            paint: {
              'line-color': '#7B68EE',
              'line-width': 2,
              'line-dasharray': [3, 2],
            },
          },
        ],
      });
      return d;
    },
    ({ map }) => {
      if (onCreate) map.on('draw.create', onCreate);
      if (onUpdate) map.on('draw.update', onUpdate);
      if (onDelete) map.on('draw.delete', onDelete);
    },
    ({ map }: { map: any }) => {
      if (onCreate) map.off('draw.create', onCreate);
      if (onUpdate) map.off('draw.update', onUpdate);
      if (onDelete) map.off('draw.delete', onDelete);
    },
  );

  useEffect(() => {
    if (drawRef) drawRef.current = draw;
  }, [draw, drawRef]);

  return null;
}
