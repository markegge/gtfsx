import type { Stop } from '../../types/gtfs';
import { pointInPolygon } from '../../utils/geometry';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';

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

/**
 * Stop ids whose [stop_lon, stop_lat] falls inside the drawn polygon, computed
 * with @turf/boolean-point-in-polygon. This is the membership test for the
 * GTFS-Fares v2 Areas "select stops by polygon" lasso: the polygon is a
 * transient selection tool only (Fares v2 areas have no geometry — membership
 * lives in stop_areas.txt), so the caller bulk-adds the returned stops to the
 * target area and then discards the shape. Pure + testable.
 *
 * Mirrors `stopsInsidePolygon` but goes through turf (which respects holes and
 * the full polygon, not just the outer ring) per the v2 Areas requirement.
 */
export function stopsInPolygonTurf(
  stops: Stop[],
  polygon: GeoJSON.Feature<GeoJSON.Polygon> | GeoJSON.Polygon,
): string[] {
  const geom = polygon.type === 'Feature' ? polygon.geometry : polygon;
  const ring = (geom?.coordinates?.[0] ?? []) as [number, number][];
  if (ring.length < 3) return [];
  const ids: string[] = [];
  for (const s of stops) {
    if (booleanPointInPolygon(point([s.stop_lon, s.stop_lat]), geom)) {
      ids.push(s.stop_id);
    }
  }
  return ids;
}
