// Membership test for the GTFS-Fares v2 Areas "select stops by polygon" lasso.
// stopsInPolygonTurf computes which stops fall inside a drawn polygon using
// @turf/boolean-point-in-polygon; the polygon is transient (never persisted),
// the returned stop ids are bulk-added to the target area's stop_areas.
import { describe, expect, it } from 'vitest';
import { stopsInPolygonTurf } from '../fareZoneHelpers';
import type { Stop } from '../../../types/gtfs';

function stop(id: string, lon: number, lat: number): Stop {
  return { stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon } as Stop;
}

// A unit square covering lon/lat [0,1] x [0,1].
const square: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};
const squareFeature: GeoJSON.Feature<GeoJSON.Polygon> = {
  type: 'Feature',
  properties: {},
  geometry: square,
};

describe('stopsInPolygonTurf', () => {
  it('returns only the stops whose [lon, lat] falls inside the polygon', () => {
    const stops = [
      stop('inside-a', 0.25, 0.25),
      stop('inside-b', 0.75, 0.5),
      stop('outside-east', 1.5, 0.5),
      stop('outside-south', 0.5, -0.5),
    ];
    const ids = stopsInPolygonTurf(stops, square).sort();
    expect(ids).toEqual(['inside-a', 'inside-b']);
  });

  it('accepts a Feature wrapper as well as a bare Polygon', () => {
    const stops = [stop('in', 0.5, 0.5), stop('out', 2, 2)];
    expect(stopsInPolygonTurf(stops, squareFeature)).toEqual(['in']);
  });

  it('returns an empty array for a degenerate (under-3-vertex) ring', () => {
    const bad: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] };
    expect(stopsInPolygonTurf([stop('s', 0.5, 0.5)], bad)).toEqual([]);
  });

  it('returns an empty array when no stops are inside', () => {
    expect(stopsInPolygonTurf([stop('far', 10, 10)], square)).toEqual([]);
  });

  it('respects polygon holes (a stop in the hole is excluded)', () => {
    // Outer 0..4 square with an inner hole 1..3.
    const withHole: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
      ],
    };
    const stops = [
      stop('ring', 0.5, 0.5), // in the outer ring, outside the hole → inside
      stop('hole', 2, 2),     // inside the hole → excluded
    ];
    expect(stopsInPolygonTurf(stops, withHole)).toEqual(['ring']);
  });
});
