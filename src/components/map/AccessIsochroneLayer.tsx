import { useMemo } from 'react';
import { Source, Layer, Marker } from 'react-map-gl/mapbox';
import type { Feature, Geometry, Position } from 'geojson';
import { useStore } from '../../store';
import { accessRingColor, ACCESS_FILL_COLOR } from '../../services/accessIsochrone/colors';

type Dir = 'n' | 'e' | 's' | 'w';
/** Extreme boundary coordinate of a (Multi)Polygon in a compass direction.
 *  Each ring labels at a different direction (n/e/s/w) so the nested contours'
 *  labels spread out instead of stacking at the same edge. */
function extremePoint(geom: Geometry, dir: Dir): Position | null {
  let best: Position | null = null;
  const score = (p: Position) =>
    dir === 'n' ? p[1] : dir === 's' ? -p[1] : dir === 'e' ? p[0] : -p[0];
  const consider = (p: Position) => {
    if (!best || score(p) > score(best)) best = p;
  };
  const walk = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number') { consider(coords as Position); return; }
    for (const c of coords) walk(c);
  };
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') walk(geom.coordinates);
  return best;
}

const LABEL_DIRS: Dir[] = ['n', 'e', 's', 'w'];

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

    // Labels in ASCENDING budget order so each ring gets a stable compass
    // direction (n/e/s/w) — keeps the nested contours' labels from stacking.
    const labelFeatures: Feature[] = [];
    result.rings.forEach((ring, i) => {
      if (!ring.polygon) return;
      const pt = extremePoint((ring.polygon as Feature).geometry, LABEL_DIRS[i % LABEL_DIRS.length]);
      if (pt) {
        labelFeatures.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pt },
          properties: { label: `${ring.budgetMin} min`, color: accessRingColor(i) },
        });
      }
    });

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
          {/* One uniform hue; nested translucent fills stack toward the origin,
              so the reachable area deepens with proximity. No outlines — the
              stepped saturation alone reads the time bands. */}
          <Layer
            id="access-isochrone-fill"
            type="fill"
            paint={{ 'fill-color': ACCESS_FILL_COLOR, 'fill-opacity': 0.2 }}
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
