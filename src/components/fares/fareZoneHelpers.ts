import type { Stop } from '../../types/gtfs';
import { pointInPolygon } from '../../utils/geometry';

/**
 * Stop ids whose (stop_lon, stop_lat) falls inside the outer ring of the given
 * polygon — the lasso-assign membership test for the map-drawing fare-zone tool.
 * Accepts a GeoJSON Polygon or a Feature wrapping one. Pure + testable.
 */
export function stopsInsidePolygon(
  stops: Stop[],
  polygon: GeoJSON.Feature<GeoJSON.Polygon> | GeoJSON.Polygon,
): string[] {
  const geom = polygon.type === 'Feature' ? polygon.geometry : polygon;
  const ring = (geom?.coordinates?.[0] ?? []) as [number, number][];
  if (ring.length < 3) return [];
  const ids: string[] = [];
  for (const s of stops) {
    if (pointInPolygon(s.stop_lon, s.stop_lat, ring)) ids.push(s.stop_id);
  }
  return ids;
}
