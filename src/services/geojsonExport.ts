// GeoJSON export — turn a feed's geometry (route shapes + stops) into a single
// GeoJSON FeatureCollection for GIS tools (QGIS, ArcGIS, Mapbox, etc.).
//
// This is a convenience GIS export, NOT a GTFS round-trip: it only carries
// geometry + a few labelling attributes, and it's geometry-only, so it works
// even when the feed has validation errors that would block a GTFS .zip export.
// Free on every plan via the `geojson_export` feature (see planConfig.ts);
// the download happens entirely client-side.

import type { Feature, FeatureCollection, GeoJsonProperties, LineString, Point } from 'geojson';
import type { Route, RouteStop, Shape, Stop, Trip } from '../types/gtfs';
import { deriveRouteShapeIds } from './routeShapes';
import { downloadBlob } from './gtfsExport';

export interface FeedGeoJSONInput {
  routes: Route[];
  stops: Stop[];
  shapes: Shape[];
  trips: Trip[];
  routeStops: RouteStop[];
}

export interface FeedGeoJSONResult {
  geojson: FeatureCollection;
  /** LineString features written (one per route × shape with ≥2 points). */
  routeFeatureCount: number;
  /** Point features written (one per stop with valid coordinates). */
  stopFeatureCount: number;
  /** Routes that produced no geometry (no shape with ≥2 points). */
  routesWithoutGeometry: number;
}

/** Build a FeatureCollection of route shapes (LineStrings) + stops (Points).
 *  Each feature carries a `_layer` property ('route' | 'stop') so GIS tools can
 *  split the mixed-geometry collection back into two layers. */
export function buildFeedGeoJSON(input: FeedGeoJSONInput): FeedGeoJSONResult {
  const { routes, stops, shapes, trips, routeStops } = input;
  const shapeById = new Map(shapes.map((s) => [s.shape_id, s]));
  const features: Feature[] = [];

  // Routes → one LineString per (route, shape). A route can have several shapes
  // (directions / patterns); each becomes its own feature carrying the route's
  // attributes plus the shape_id, so direction-level geometry is preserved.
  let routesWithoutGeometry = 0;
  for (const route of routes) {
    const usableShapes = deriveRouteShapeIds(route.route_id, trips, routeStops, shapes)
      .map((id) => shapeById.get(id))
      .filter((s): s is Shape => !!s && s.points.length >= 2);
    if (usableShapes.length === 0) {
      routesWithoutGeometry++;
      continue;
    }
    for (const shape of usableShapes) {
      const coordinates = [...shape.points]
        .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
        .map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
      const geometry: LineString = { type: 'LineString', coordinates };
      const properties: GeoJsonProperties = {
        _layer: 'route',
        route_id: route.route_id,
        route_short_name: route.route_short_name || null,
        route_long_name: route.route_long_name || null,
        route_type: route.route_type,
        route_color: route.route_color ? `#${route.route_color}` : null,
        route_text_color: route.route_text_color ? `#${route.route_text_color}` : null,
        agency_id: route.agency_id || null,
        shape_id: shape.shape_id,
      };
      features.push({ type: 'Feature', geometry, properties });
    }
  }
  const routeFeatureCount = features.length;

  // Stops → Point features. Skip anything without finite coordinates so the
  // output never contains an invalid Point.
  for (const stop of stops) {
    if (!Number.isFinite(stop.stop_lat) || !Number.isFinite(stop.stop_lon)) continue;
    const geometry: Point = { type: 'Point', coordinates: [stop.stop_lon, stop.stop_lat] };
    const properties: GeoJsonProperties = {
      _layer: 'stop',
      stop_id: stop.stop_id,
      stop_code: stop.stop_code || null,
      stop_name: stop.stop_name || null,
      location_type: stop.location_type ?? 0,
      wheelchair_boarding: stop.wheelchair_boarding ?? 0,
      zone_id: stop.zone_id || null,
      parent_station: stop.parent_station || null,
    };
    features.push({ type: 'Feature', geometry, properties });
  }
  const stopFeatureCount = features.length - routeFeatureCount;

  return {
    geojson: { type: 'FeatureCollection', features },
    routeFeatureCount,
    stopFeatureCount,
    routesWithoutGeometry,
  };
}

/** True when the feed has any geometry to export (route shapes or stops). */
export function feedHasGeoJSONGeometry(input: FeedGeoJSONInput): boolean {
  return input.shapes.some((s) => s.points.length >= 2) || input.stops.length > 0;
}

/** Build the FeatureCollection and trigger a `<name>.geojson` download. */
export function exportFeedGeoJSON(input: FeedGeoJSONInput, fileName: string): FeedGeoJSONResult {
  const result = buildFeedGeoJSON(input);
  const blob = new Blob([JSON.stringify(result.geojson, null, 2)], {
    type: 'application/geo+json',
  });
  downloadBlob(blob, `${fileName}.geojson`);
  return result;
}
