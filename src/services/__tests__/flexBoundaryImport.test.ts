// Importing an agency's existing service-area boundary (GeoJSON) as a flex
// zone. The parser is the gate between an arbitrary file and FlexZone.geojson:
// it must merge every polygon into the ONE feature the exporter writes to
// locations.geojson, and reject everything that file format forbids.
import { describe, expect, it } from 'vitest';
import { parseBoundaryGeoJson } from '../../components/flex/flexHelpers';

const SQUARE: GeoJSON.Position[][] = [[
  [-111.05, 45.66],
  [-111.0, 45.66],
  [-111.0, 45.70],
  [-111.05, 45.70],
  [-111.05, 45.66],
]];

const SQUARE_EAST: GeoJSON.Position[][] = [[
  [-110.95, 45.66],
  [-110.90, 45.66],
  [-110.90, 45.70],
  [-110.95, 45.70],
  [-110.95, 45.66],
]];

function polygonFeature(
  coordinates: GeoJSON.Position[][],
  properties: Record<string, unknown> = {},
): GeoJSON.Feature {
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates } };
}

function collection(features: GeoJSON.Feature[]): string {
  return JSON.stringify({ type: 'FeatureCollection', features });
}

describe('parseBoundaryGeoJson — accepted shapes', () => {
  it('accepts a FeatureCollection with one Polygon', () => {
    const result = parseBoundaryGeoJson(collection([polygonFeature(SQUARE)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygonCount).toBe(1);
    expect(result.geojson.features).toHaveLength(1);
    expect(result.geojson.features[0].geometry).toEqual({ type: 'Polygon', coordinates: SQUARE });
  });

  it('merges several Polygon features into a single MultiPolygon feature', () => {
    // One zone = one location_id = one locations.geojson Feature (gtfsExport's
    // zonePolygons), so sibling polygons must fold into one MultiPolygon.
    const result = parseBoundaryGeoJson(
      collection([polygonFeature(SQUARE), polygonFeature(SQUARE_EAST)]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygonCount).toBe(2);
    expect(result.geojson.features).toHaveLength(1);
    expect(result.geojson.features[0].geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [SQUARE, SQUARE_EAST],
    });
  });

  it('accepts a bare Feature', () => {
    const result = parseBoundaryGeoJson(JSON.stringify(polygonFeature(SQUARE)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.geojson.features[0].geometry).toEqual({ type: 'Polygon', coordinates: SQUARE });
  });

  it('accepts a bare Geometry', () => {
    const result = parseBoundaryGeoJson(JSON.stringify({ type: 'Polygon', coordinates: SQUARE }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygonCount).toBe(1);
    expect(result.geojson.features[0].geometry).toEqual({ type: 'Polygon', coordinates: SQUARE });
  });

  it('accepts a MultiPolygon and keeps every part', () => {
    const result = parseBoundaryGeoJson(
      JSON.stringify({
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiPolygon', coordinates: [SQUARE, SQUARE_EAST] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygonCount).toBe(2);
    expect(result.geojson.features[0].geometry).toEqual({
      type: 'MultiPolygon',
      coordinates: [SQUARE, SQUARE_EAST],
    });
  });

  it('merges a Polygon and a MultiPolygon across features', () => {
    const result = parseBoundaryGeoJson(
      collection([
        polygonFeature(SQUARE),
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'MultiPolygon', coordinates: [SQUARE_EAST] },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.polygonCount).toBe(2);
    expect(result.geojson.features[0].geometry.type).toBe('MultiPolygon');
  });
});

describe('parseBoundaryGeoJson — naming', () => {
  it("seeds the name from the feature's properties.name", () => {
    const result = parseBoundaryGeoJson(
      collection([polygonFeature(SQUARE, { name: 'Northside Dial-a-Ride' })]),
      'whatever.geojson',
    );
    expect(result.ok && result.name).toBe('Northside Dial-a-Ride');
  });

  it('falls back to properties.stop_name', () => {
    const result = parseBoundaryGeoJson(
      collection([polygonFeature(SQUARE, { stop_name: 'Zone A' })]),
    );
    expect(result.ok && result.name).toBe('Zone A');
  });

  it('falls back to the filename without extension', () => {
    const result = parseBoundaryGeoJson(collection([polygonFeature(SQUARE)]), 'bozeman-service-area.geojson');
    expect(result.ok && result.name).toBe('bozeman-service-area');
  });

  it('returns a null name when the file offers nothing usable', () => {
    const result = parseBoundaryGeoJson(collection([polygonFeature(SQUARE)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.name).toBeNull();
  });

  it('carries a source description through as stop_desc (the only extra property the spec allows)', () => {
    const result = parseBoundaryGeoJson(
      collection([polygonFeature(SQUARE, { name: 'Zone A', stop_desc: 'Curb-to-curb' })]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.geojson.features[0].properties).toEqual({ stop_desc: 'Curb-to-curb' });
  });
});

describe('parseBoundaryGeoJson — rejections', () => {
  it('rejects a Point', () => {
    const result = parseBoundaryGeoJson(
      JSON.stringify({ type: 'Point', coordinates: [-111.03, 45.68] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Point');
    expect(result.error).toContain('Polygon and MultiPolygon');
  });

  it('rejects a LineString', () => {
    const result = parseBoundaryGeoJson(
      collection([
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [[-111.05, 45.66], [-111.0, 45.70]] },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('LineString');
  });

  it('rejects a GeometryCollection', () => {
    const result = parseBoundaryGeoJson(
      JSON.stringify({
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', coordinates: SQUARE }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('GeometryCollection');
  });

  it('rejects malformed JSON', () => {
    const result = parseBoundaryGeoJson('{ "type": "FeatureCollection", features: [');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('valid JSON');
  });

  it('rejects an empty FeatureCollection', () => {
    const result = parseBoundaryGeoJson(collection([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('empty');
  });

  it('rejects a FeatureCollection with no polygon features', () => {
    const result = parseBoundaryGeoJson(
      collection([{ type: 'Feature', properties: {}, geometry: null as unknown as GeoJSON.Geometry }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No polygon features');
  });

  it('rejects projected (non-WGS84) coordinates', () => {
    // UTM zone 12N easting/northing for Bozeman — a very common export mistake.
    const utm: GeoJSON.Position[][] = [[
      [496000, 5058000],
      [500000, 5058000],
      [500000, 5062000],
      [496000, 5062000],
      [496000, 5058000],
    ]];
    const result = parseBoundaryGeoJson(collection([polygonFeature(utm)]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("don't look like WGS84");
  });

  it('rejects out-of-range latitude even when longitude is plausible', () => {
    const bad: GeoJSON.Position[][] = [[
      [-111.05, 95.0],
      [-111.0, 95.0],
      [-111.0, 96.0],
      [-111.05, 95.0],
    ]];
    const result = parseBoundaryGeoJson(collection([polygonFeature(bad)]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('WGS84');
  });

  it('rejects a Polygon with malformed coordinates', () => {
    const result = parseBoundaryGeoJson(
      JSON.stringify({ type: 'Polygon', coordinates: [[[-111.05, 45.66], [-111.0, 45.66]]] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('malformed');
  });

  it('rejects a non-GeoJSON JSON document', () => {
    const result = parseBoundaryGeoJson(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not GeoJSON');
  });
});
