import { describe, it, expect } from 'vitest';
import { buildFeedGeoJSON, feedHasGeoJSONGeometry, type FeedGeoJSONInput } from '../geojsonExport';
import type { Route, Shape, Stop, Trip } from '../../types/gtfs';

function route(over: Partial<Route> = {}): Route {
  return {
    route_id: 'R1',
    agency_id: 'A1',
    route_short_name: '1',
    route_long_name: 'Main Line',
    route_type: 3,
    route_color: 'FF0000',
    route_text_color: 'FFFFFF',
    ...over,
  };
}

function shape(id: string, pts: [number, number][]): Shape {
  return {
    shape_id: id,
    points: pts.map(([lat, lon], i) => ({
      shape_pt_lat: lat,
      shape_pt_lon: lon,
      shape_pt_sequence: i + 1,
      shape_dist_traveled: 0,
    })),
  };
}

function stop(over: Partial<Stop> = {}): Stop {
  return {
    stop_id: 'S1',
    stop_name: 'First & Main',
    stop_lat: 45.1,
    stop_lon: -111.2,
    location_type: 0,
    wheelchair_boarding: 0,
    ...over,
  };
}

function trip(over: Partial<Trip> = {}): Trip {
  return { trip_id: 'T1', route_id: 'R1', service_id: 'WK', direction_id: 0, shape_id: 'sh1', ...over };
}

const base: FeedGeoJSONInput = { routes: [], stops: [], shapes: [], trips: [], routeStops: [] };

describe('buildFeedGeoJSON', () => {
  it('emits a LineString per route shape with route attributes', () => {
    const input: FeedGeoJSONInput = {
      ...base,
      routes: [route()],
      shapes: [shape('sh1', [[45.0, -111.0], [45.1, -111.1]])],
      trips: [trip()],
    };
    const { geojson, routeFeatureCount, stopFeatureCount } = buildFeedGeoJSON(input);
    expect(routeFeatureCount).toBe(1);
    expect(stopFeatureCount).toBe(0);
    const f = geojson.features[0];
    expect(f.geometry.type).toBe('LineString');
    // GeoJSON is [lon, lat]
    expect((f.geometry as { coordinates: number[][] }).coordinates).toEqual([
      [-111.0, 45.0],
      [-111.1, 45.1],
    ]);
    expect(f.properties?._layer).toBe('route');
    expect(f.properties?.route_id).toBe('R1');
    expect(f.properties?.route_color).toBe('#FF0000');
    expect(f.properties?.shape_id).toBe('sh1');
  });

  it('orders shape points by sequence regardless of array order', () => {
    const s = shape('sh1', [[45.0, -111.0], [45.1, -111.1], [45.2, -111.2]]);
    // Scramble the array but keep sequence numbers intact.
    s.points = [s.points[2], s.points[0], s.points[1]];
    const { geojson } = buildFeedGeoJSON({
      ...base,
      routes: [route()],
      shapes: [s],
      trips: [trip()],
    });
    expect((geojson.features[0].geometry as { coordinates: number[][] }).coordinates).toEqual([
      [-111.0, 45.0],
      [-111.1, 45.1],
      [-111.2, 45.2],
    ]);
  });

  it('emits a Point per stop and skips invalid coordinates', () => {
    const { geojson, stopFeatureCount } = buildFeedGeoJSON({
      ...base,
      stops: [stop(), stop({ stop_id: 'S2', stop_lat: NaN, stop_lon: -111 })],
    });
    expect(stopFeatureCount).toBe(1);
    const f = geojson.features[0];
    expect(f.geometry.type).toBe('Point');
    expect((f.geometry as { coordinates: number[] }).coordinates).toEqual([-111.2, 45.1]);
    expect(f.properties?._layer).toBe('stop');
    expect(f.properties?.stop_id).toBe('S1');
  });

  it('counts routes with no usable geometry', () => {
    const { routeFeatureCount, routesWithoutGeometry } = buildFeedGeoJSON({
      ...base,
      routes: [route(), route({ route_id: 'R2' })],
      // Only R1 has a shape (via its trip); R2 has none.
      shapes: [shape('sh1', [[45, -111], [45.1, -111.1]])],
      trips: [trip()],
    });
    expect(routeFeatureCount).toBe(1);
    expect(routesWithoutGeometry).toBe(1);
  });

  it('includes freshly drawn shapes linked only by _route_id', () => {
    const draft = shape('draft1', [[45, -111], [45.1, -111.1]]);
    draft._route_id = 'R1';
    const { routeFeatureCount } = buildFeedGeoJSON({
      ...base,
      routes: [route()],
      shapes: [draft],
    });
    expect(routeFeatureCount).toBe(1);
  });

  it('drops shapes with fewer than two points', () => {
    const { routeFeatureCount, routesWithoutGeometry } = buildFeedGeoJSON({
      ...base,
      routes: [route()],
      shapes: [shape('sh1', [[45, -111]])],
      trips: [trip()],
    });
    expect(routeFeatureCount).toBe(0);
    expect(routesWithoutGeometry).toBe(1);
  });
});

describe('feedHasGeoJSONGeometry', () => {
  it('is false for an empty feed', () => {
    expect(feedHasGeoJSONGeometry(base)).toBe(false);
  });
  it('is true with stops only', () => {
    expect(feedHasGeoJSONGeometry({ ...base, stops: [stop()] })).toBe(true);
  });
  it('is true with a drawable shape only', () => {
    expect(feedHasGeoJSONGeometry({ ...base, shapes: [shape('sh1', [[45, -111], [45.1, -111.1]])] })).toBe(true);
  });
});
