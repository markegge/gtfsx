import { useMemo } from 'react';
import { Source, Layer, Marker } from 'react-map-gl/mapbox';
import type { Feature, Geometry, Position } from 'geojson';
import { useStore } from '../../store';
import { accessRingColor, ACCESS_FILL_COLOR } from '../../services/accessIsochrone/colors';

/** Northernmost coordinate of a (Multi)Polygon — used to anchor the ring's time
 *  label at the top edge of the contour, where rings naturally separate. */
function northPoint(geom: Geometry): Position | null {
  let best: Position | null = null;
  const consider = (p: Position) => {
    if (!best || p[1] > best[1]) best = p;
  };
  const walk = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') { consider(coords as Position); return; }
    for (const c of coords) walk(c);
  };
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') walk(geom.coordinates);
  return best;
}

/**
 * Map overlay for the Access Isochrones panel. The reachable area is a single
 * blue hue drawn as nested translucent fills (largest underneath), so it deepens
 * toward the origin — closest reach = most saturated. Each time band gets a
 * crisp outline in a stepped saturation ramp plus an on-map "N min" label.
 * Only renders while the Access Isochrones section is active.
 */
export function AccessIsochroneLayer() {
  const sidebarSection = useStore((s) => s.sidebarSection);
  const origin = useStore((s) => s.accessOrigin);
  const result = useStore((s) => s.accessResult);
  const setOrigin = useStore((s) => s.setAccessOrigin);

  const active = sidebarSection === 'access-isochrones';

  const { fills, labels } = useMemo(() => {
    if (!active || !result || result.status !== 'ok') {
      return { fills: null, labels: null };
    }
    // Largest budget first → drawn underneath; smaller (closer) rings on top.
    const ordered = result.rings
      .map((ring, i) => ({ ring, color: accessRingColor(i) }))
      .filter((r) => r.ring.polygon)
      .sort((a, b) => b.ring.budgetMin - a.ring.budgetMin);

    const fillFeatures: Feature[] = ordered.map(({ ring, color }) => ({
      ...(ring.polygon as Feature),
      properties: { color, budget: ring.budgetMin },
    }));

    const labelFeatures: Feature[] = [];
    for (const { ring, color } of ordered) {
      const np = ring.polygon ? northPoint((ring.polygon as Feature).geometry) : null;
      if (np) {
        labelFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: np },
          properties: { label: `${ring.budgetMin} min`, color },
        });
      }
    }

    return {
      fills: { type: 'FeatureCollection' as const, features: fillFeatures },
      labels: { type: 'FeatureCollection' as const, features: labelFeatures },
    };
  }, [active, result]);

  if (!active) return null;

  return (
    <>
      {fills && fills.features.length > 0 && (
        <Source id="access-isochrone" type="geojson" data={fills}>
          {/* One uniform hue; nested translucent fills stack toward the origin. */}
          <Layer
            id="access-isochrone-fill"
            type="fill"
            paint={{ 'fill-color': ACCESS_FILL_COLOR, 'fill-opacity': 0.18 }}
          />
          {/* Crisp per-band outline in the stepped saturation ramp. */}
          <Layer
            id="access-isochrone-outline"
            type="line"
            paint={{ 'line-color': ['get', 'color'], 'line-width': 2.2, 'line-opacity': 0.9 }}
          />
        </Source>
      )}
      {labels && labels.features.length > 0 && (
        <Source id="access-isochrone-labels" type="geojson" data={labels}>
          <Layer
            id="access-isochrone-label"
            type="symbol"
            layout={{
              'text-field': ['get', 'label'],
              'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
              'text-size': 12,
              'text-anchor': 'bottom',
              'text-offset': [0, -0.3],
              'text-allow-overlap': true,
            }}
            paint={{
              'text-color': ['get', 'color'],
              'text-halo-color': '#ffffff',
              'text-halo-width': 1.6,
            }}
          />
        </Source>
      )}
      {origin && (
        <Marker
          longitude={origin.lon}
          latitude={origin.lat}
          draggable
          onDragEnd={(e) => setOrigin({ lon: e.lngLat.lng, lat: e.lngLat.lat })}
          anchor="bottom"
        >
          <div
            title="Trip origin — drag to move"
            className="flex flex-col items-center -mb-1 cursor-grab active:cursor-grabbing"
          >
            <div className="w-4 h-4 rounded-full bg-coral border-2 border-white shadow-md" />
            <div className="w-0.5 h-2 bg-coral" />
          </div>
        </Marker>
      )}
    </>
  );
}
