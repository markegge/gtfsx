import simplify from '@turf/simplify';
import { lineString } from '@turf/helpers';
import length from '@turf/length';
import type { ShapePoint } from '../types/gtfs';

/**
 * Simplify a shape's points using the Ramer-Douglas-Peucker algorithm.
 * @param points The shape points to simplify
 * @param tolerance Tolerance in degrees (higher = fewer points). Default 0.0001 (~11m)
 * @returns Simplified points with recalculated sequences
 */
export function simplifyShapePoints(
  points: ShapePoint[],
  tolerance = 0.0001,
): ShapePoint[] {
  if (points.length <= 2) return points;

  const coords = points.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
  const line = lineString(coords);
  const simplified = simplify(line, { tolerance, highQuality: true });
  const newCoords = simplified.geometry.coordinates;

  // Recalculate distances
  const newPoints: ShapePoint[] = newCoords.map((c, i) => ({
    shape_pt_lat: c[1],
    shape_pt_lon: c[0],
    shape_pt_sequence: i,
    shape_dist_traveled: 0,
  }));

  // Calculate cumulative distances
  if (newPoints.length >= 2) {
    newPoints[0].shape_dist_traveled = 0;
    for (let i = 1; i < newPoints.length; i++) {
      const subCoords = newCoords.slice(0, i + 1);
      const subLine = lineString(subCoords);
      newPoints[i].shape_dist_traveled = length(subLine, { units: 'meters' });
    }
  }

  return newPoints;
}

/**
 * Pre-defined simplification levels with approximate descriptions.
 */
export const SIMPLIFY_LEVELS = [
  { label: 'Light', tolerance: 0.00005, description: '~5m precision' },
  { label: 'Medium', tolerance: 0.0002, description: '~20m precision' },
  { label: 'Heavy', tolerance: 0.0005, description: '~50m precision' },
] as const;
