import distance from '@turf/distance';
import buffer from '@turf/buffer';
import { point, featureCollection } from '@turf/helpers';
import type { BlockGroupData } from './demographics';
import type { Stop } from '../types/gtfs';
import type { AppStore } from '../store';
import { gtfsTimeToSeconds } from '../utils/time';

export interface CoverageResult {
  totalPopulation: number;
  totalHouseholds: number;
  totalWorkers: number;
  coveredBlockGroupIds: string[];
  bufferMiles: number;
  /** geoid → apportionment fraction [0,1] for each covered block group */
  fractions: Map<string, number>;
}

/**
 * Approximate radius of a census block group for apportionment.
 * US block groups average ~1,500 people and ~0.3–0.6 sq mi in urban/suburban
 * areas, corresponding to a radius of ~0.3–0.45 mi. Use 0.5 as a conservative
 * default that also accommodates suburban tracts whose centroid files we use.
 */
const BG_RADIUS_MILES = 0.5;

/**
 * Fraction of a circle of radius bgRadius (block group) that overlaps with a
 * circle of radius bufferMiles (stop walksheds) whose center is `d` miles away.
 * Uses the standard lens / circle-circle intersection area formula.
 */
function circleOverlapFraction(d: number, bufferMiles: number, bgRadius: number): number {
  if (d >= bufferMiles + bgRadius) return 0;   // circles don't overlap
  if (d + bgRadius <= bufferMiles) return 1;   // BG fully inside buffer
  if (d + bufferMiles <= bgRadius)             // buffer fully inside BG
    return (bufferMiles * bufferMiles) / (bgRadius * bgRadius);
  if (d === 0) return Math.min(1, (bufferMiles / bgRadius) ** 2);

  const r1 = bufferMiles, r2 = bgRadius;
  const cosA = (d * d + r1 * r1 - r2 * r2) / (2 * d * r1);
  const cosB = (d * d + r2 * r2 - r1 * r1) / (2 * d * r2);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const beta  = Math.acos(Math.max(-1, Math.min(1, cosB)));
  const area =
    r1 * r1 * (alpha - Math.sin(alpha) * Math.cos(alpha)) +
    r2 * r2 * (beta  - Math.sin(beta)  * Math.cos(beta));
  return Math.min(1, area / (Math.PI * r2 * r2));
}

/**
 * Compute apportioned coverage for a set of stops over a set of block groups.
 *
 * Rather than a binary centroid-in-buffer check, each block group is modelled
 * as a circle of radius BG_RADIUS_MILES. The fraction of that circle that
 * overlaps with any stop's walksheds is computed via the standard
 * circle-circle intersection formula, and population/households/workers are
 * scaled by that fraction before summing.
 */
export function calculateCoverage(
  stops: Stop[],
  blockGroups: BlockGroupData[],
  bufferMiles: number,
): CoverageResult {
  const stopPoints = stops.map((s) => point([s.stop_lon, s.stop_lat]));
  const fractions = new Map<string, number>();

  for (const bg of blockGroups) {
    const bgPoint = point([bg.lon, bg.lat]);
    let minDist = Infinity;
    for (const sp of stopPoints) {
      const d = distance(bgPoint, sp, { units: 'miles' });
      if (d < minDist) minDist = d;
    }
    const fraction = circleOverlapFraction(minDist, bufferMiles, BG_RADIUS_MILES);
    if (fraction > 0) fractions.set(bg.geoid, fraction);
  }

  let totalPopulation = 0, totalHouseholds = 0, totalWorkers = 0;
  for (const bg of blockGroups) {
    const f = fractions.get(bg.geoid);
    if (f) {
      totalPopulation += f * bg.population;
      totalHouseholds += f * bg.households;
      totalWorkers    += f * bg.workers;
    }
  }

  return {
    totalPopulation:     Math.round(totalPopulation),
    totalHouseholds:     Math.round(totalHouseholds),
    totalWorkers:        Math.round(totalWorkers),
    coveredBlockGroupIds: [...fractions.keys()],
    bufferMiles,
    fractions,
  };
}

/**
 * Calculate average headway in minutes for all trips on a given route.
 * Returns Infinity if there are fewer than 2 trips.
 */
function getAverageHeadway(routeId: string, state: AppStore): number {
  const routeTrips = state.trips.filter((t) => t.route_id === routeId);
  if (routeTrips.length < 2) return Infinity;

  // For each trip, find the earliest departure time
  const tripStartTimes: number[] = [];
  for (const trip of routeTrips) {
    const times = state.stopTimes
      .filter((st) => st.trip_id === trip.trip_id && st.departure_time)
      .map((st) => gtfsTimeToSeconds(st.departure_time));
    if (times.length > 0) {
      tripStartTimes.push(Math.min(...times));
    }
  }

  if (tripStartTimes.length < 2) return Infinity;

  tripStartTimes.sort((a, b) => a - b);

  let totalGap = 0;
  for (let i = 1; i < tripStartTimes.length; i++) {
    totalGap += tripStartTimes[i] - tripStartTimes[i - 1];
  }

  return totalGap / (tripStartTimes.length - 1) / 60; // convert seconds to minutes
}

/**
 * Get coverage for a specific route's stops.
 * Uses a 0.5 mi buffer for light rail (route_type 0) or routes with
 * average headway ≤ 15 minutes; 0.25 mi otherwise.
 */
export function getBufferForRoute(
  routeId: string,
  state: AppStore,
  blockGroups: BlockGroupData[],
): CoverageResult {
  const route = state.routes.find((r) => r.route_id === routeId);
  const isLightRail = route?.route_type === 0; // GTFS: 0 = tram/streetcar/light rail
  const avgHeadway = getAverageHeadway(routeId, state);
  const bufferMiles = (isLightRail || avgHeadway <= 15) ? 0.5 : 0.25;

  // Get stops that belong to this route
  const routeStopIds = new Set(
    state.routeStops
      .filter((rs) => rs.route_id === routeId)
      .map((rs) => rs.stop_id),
  );
  const routeStops = state.stops.filter((s) => routeStopIds.has(s.stop_id));

  return calculateCoverage(routeStops, blockGroups, bufferMiles);
}

/**
 * Generate GeoJSON buffer polygons around stops for map display.
 */
export function generateBufferGeoJSON(
  stops: Stop[],
  bufferMiles: number,
): GeoJSON.FeatureCollection {
  if (stops.length === 0) {
    return featureCollection([]) as GeoJSON.FeatureCollection;
  }

  const stopFeatures = stops.map((s) =>
    point([s.stop_lon, s.stop_lat], { stop_id: s.stop_id }),
  );

  const collection = featureCollection(stopFeatures);
  const buffered = buffer(collection, bufferMiles, { units: 'miles' });

  return (buffered ?? featureCollection([])) as GeoJSON.FeatureCollection;
}
