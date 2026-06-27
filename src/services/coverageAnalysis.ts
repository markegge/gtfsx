import distance from '@turf/distance';
import buffer from '@turf/buffer';
import { point, featureCollection } from '@turf/helpers';
import type { BlockGroupData } from './demographics';
import type { Stop } from '../types/gtfs';
import type { AppStore } from '../store';

export interface CoverageResult {
  totalPopulation: number;
  totalHouseholds: number;
  totalWorkers: number;
  /** Apportioned high-propensity riders (see BlockGroupData.highPropensityRiders). */
  totalHighPropensityRiders: number;
  // Apportioned demographic counts (numerators + denominators kept separate
  // so shares can be computed after summing — never average pre-computed
  // per-block-group shares). See demographicShares() below.
  minorityPop: number;
  totalRacePop: number;
  lowIncomePop: number;
  povertyUniverse: number;
  zeroVehicleHouseholds: number;
  occupiedHouseholds: number;
  seniorPop: number;
  youthPop: number;
  coveredBlockGroupIds: string[];
  bufferMiles: number;
  /** geoid → apportionment fraction [0,1] for each covered block group */
  fractions: Map<string, number>;
}

/**
 * The four equity shares the demographic overlay surfaces, each in [0,1].
 * `null` when the denominator is zero (no data in the coverage area), so the
 * UI can render "—" rather than a misleading 0%.
 */
export interface DemographicShares {
  minority: number | null;
  lowIncome: number | null;
  zeroVehicle: number | null;
  senior: number | null;
  youth: number | null;
}

function share(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Baseline / minimum radius of the circle a census unit is modelled as for
 * apportionment. US block groups average ~1,500 people and ~0.3–0.6 sq mi in
 * urban/suburban areas (radius ~0.3–0.45 mi); 0.5 is a conservative default.
 *
 * This is the FLOOR. The effective radius is adaptive — see computeBgRadii.
 * A fixed 0.5 mi badly underestimates the spatial extent of large suburban /
 * rural tracts (we only have tract centroids, not polygons), which left a
 * "dead zone": a ¼-mi stop buffer captured nothing beyond 0.75 mi from the
 * nearest centroid, so ~18% of stops in the demo feed reported 0 population at
 * ¼ mi while ½ mi worked. Growing the radius where centroids are sparse closes
 * that gap without changing dense urban cores (which stay clamped at 0.5).
 */
export const BG_RADIUS_MILES = 0.5;
/** Upper clamp so an isolated rural tract doesn't spread over the whole map. */
export const BG_RADIUS_MAX_MILES = 3.0;

/**
 * Effective per-census-unit circle radius for apportionment. Block groups
 * inherit their parent tract's centroid, so many share one coordinate; we work
 * on the distinct centroids (tracts) to keep this O(tracts²), then map back.
 *
 * Radius = the great-circle distance to the nearest *other* centroid, clamped
 * to [BG_RADIUS_MILES, BG_RADIUS_MAX_MILES]. Using the full spacing (rather
 * than half) makes each tract's disc reach its neighbours' centroids, so the
 * discs overlap and tile with no gaps — a stop anywhere between centroids
 * always overlaps at least one. Verified to eliminate the ¼-mi dead zone
 * (0 of 166 stops report 0 pop at ¼ mi on the demo feed, vs 30 before) while
 * leaving dense urban cores at the 0.5-mi floor. Half-spacing left ~23 gaps.
 */
export function computeBgRadii(blockGroups: BlockGroupData[]): Map<string, number> {
  const coordKey = (bg: { lat: number; lon: number }) => `${bg.lat},${bg.lon}`;
  const uniq = new Map<string, { lat: number; lon: number }>();
  for (const bg of blockGroups) {
    const k = coordKey(bg);
    if (!uniq.has(k)) uniq.set(k, { lat: bg.lat, lon: bg.lon });
  }
  const pts = [...uniq.entries()].map(([k, c]) => ({ k, pt: point([c.lon, c.lat]) }));

  const radiusByKey = new Map<string, number>();
  for (let i = 0; i < pts.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const d = distance(pts[i].pt, pts[j].pt, { units: 'miles' });
      if (d < nearest) nearest = d;
    }
    const r = nearest === Infinity
      ? BG_RADIUS_MILES
      : Math.min(BG_RADIUS_MAX_MILES, Math.max(BG_RADIUS_MILES, nearest));
    radiusByKey.set(pts[i].k, r);
  }

  const radii = new Map<string, number>();
  for (const bg of blockGroups) radii.set(bg.geoid, radiusByKey.get(coordKey(bg)) ?? BG_RADIUS_MILES);
  return radii;
}

/**
 * Fraction of a circle of radius bgRadius (block group) that overlaps with a
 * circle of radius bufferMiles (stop walksheds) whose center is `d` miles away.
 * Uses the standard lens / circle-circle intersection area formula.
 */
export function circleOverlapFraction(d: number, bufferMiles: number, bgRadius: number): number {
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
/**
 * Sum apportioned demographic counts over a fractions map into a CoverageResult.
 * Shared by calculateCoverage (one buffer over a stop set) and the system-level
 * summary in CoveragePanel (max fraction per block group across per-route
 * buffers) so the per-field summation lives in exactly one place.
 */
export function coverageFromFractions(
  fractions: Map<string, number>,
  blockGroups: BlockGroupData[],
  bufferMiles: number,
): CoverageResult {
  const bgMap = new Map(blockGroups.map((bg) => [bg.geoid, bg]));
  let totalPopulation = 0, totalHouseholds = 0, totalWorkers = 0;
  let totalHighPropensityRiders = 0;
  let minorityPop = 0, totalRacePop = 0;
  let lowIncomePop = 0, povertyUniverse = 0;
  let zeroVehicleHouseholds = 0, occupiedHouseholds = 0;
  let seniorPop = 0, youthPop = 0;

  for (const [geoid, f] of fractions) {
    const bg = bgMap.get(geoid);
    if (!bg || !f) continue;
    totalPopulation       += f * bg.population;
    totalHouseholds       += f * bg.households;
    totalWorkers          += f * bg.workers;
    totalHighPropensityRiders += f * bg.highPropensityRiders;
    minorityPop           += f * bg.minorityPop;
    totalRacePop          += f * bg.totalRacePop;
    lowIncomePop          += f * bg.lowIncomePop;
    povertyUniverse       += f * bg.povertyUniverse;
    zeroVehicleHouseholds += f * bg.zeroVehicleHouseholds;
    occupiedHouseholds    += f * bg.occupiedHouseholds;
    seniorPop             += f * bg.seniorPop;
    youthPop              += f * bg.youthPop;
  }

  return {
    totalPopulation:       Math.round(totalPopulation),
    totalHouseholds:       Math.round(totalHouseholds),
    totalWorkers:          Math.round(totalWorkers),
    totalHighPropensityRiders: Math.round(totalHighPropensityRiders),
    minorityPop:           Math.round(minorityPop),
    totalRacePop:          Math.round(totalRacePop),
    lowIncomePop:          Math.round(lowIncomePop),
    povertyUniverse:       Math.round(povertyUniverse),
    zeroVehicleHouseholds: Math.round(zeroVehicleHouseholds),
    occupiedHouseholds:    Math.round(occupiedHouseholds),
    seniorPop:             Math.round(seniorPop),
    youthPop:              Math.round(youthPop),
    coveredBlockGroupIds:  [...fractions.keys()],
    bufferMiles,
    fractions,
  };
}

export function calculateCoverage(
  stops: Stop[],
  blockGroups: BlockGroupData[],
  bufferMiles: number,
): CoverageResult {
  const stopPoints = stops.map((s) => point([s.stop_lon, s.stop_lat]));
  const radii = computeBgRadii(blockGroups);
  const fractions = new Map<string, number>();

  for (const bg of blockGroups) {
    const bgPoint = point([bg.lon, bg.lat]);
    let minDist = Infinity;
    for (const sp of stopPoints) {
      const d = distance(bgPoint, sp, { units: 'miles' });
      if (d < minDist) minDist = d;
    }
    const fraction = circleOverlapFraction(minDist, bufferMiles, radii.get(bg.geoid) ?? BG_RADIUS_MILES);
    if (fraction > 0) fractions.set(bg.geoid, fraction);
  }

  return coverageFromFractions(fractions, blockGroups, bufferMiles);
}

/**
 * Demographic shares for a coverage area, computed from the apportioned
 * numerators and denominators (so they're area-weighted, not an average of
 * per-block-group rates). Senior / youth use total population as the base.
 */
export function demographicShares(r: CoverageResult): DemographicShares {
  return {
    minority:    share(r.minorityPop, r.totalRacePop),
    lowIncome:   share(r.lowIncomePop, r.povertyUniverse),
    zeroVehicle: share(r.zeroVehicleHouseholds, r.occupiedHouseholds),
    senior:      share(r.seniorPop, r.totalPopulation),
    youth:       share(r.youthPop, r.totalPopulation),
  };
}

/**
 * Service-area baseline shares: the same five shares computed over EVERY block
 * group in the fetched county (unweighted), giving the denominator for the
 * coverage-vs-baseline equity ratio. No extra Census fetch — we already pull
 * the whole county to run the coverage apportionment.
 */
export function baselineShares(blockGroups: BlockGroupData[]): DemographicShares {
  const t = blockGroups.reduce(
    (a, bg) => {
      a.minorityPop += bg.minorityPop;
      a.totalRacePop += bg.totalRacePop;
      a.lowIncomePop += bg.lowIncomePop;
      a.povertyUniverse += bg.povertyUniverse;
      a.zeroVehicleHouseholds += bg.zeroVehicleHouseholds;
      a.occupiedHouseholds += bg.occupiedHouseholds;
      a.seniorPop += bg.seniorPop;
      a.youthPop += bg.youthPop;
      a.population += bg.population;
      return a;
    },
    {
      minorityPop: 0, totalRacePop: 0, lowIncomePop: 0, povertyUniverse: 0,
      zeroVehicleHouseholds: 0, occupiedHouseholds: 0, seniorPop: 0, youthPop: 0, population: 0,
    },
  );
  return {
    minority:    share(t.minorityPop, t.totalRacePop),
    lowIncome:   share(t.lowIncomePop, t.povertyUniverse),
    zeroVehicle: share(t.zeroVehicleHouseholds, t.occupiedHouseholds),
    senior:      share(t.seniorPop, t.population),
    youth:       share(t.youthPop, t.population),
  };
}

/**
 * Get coverage for a specific route's stops.
 * Uses a 0.5 mi buffer for light rail / tram (route_type 0); 0.25 mi for all
 * other route types (bus, rail, ferry, etc.).
 */
export function getBufferForRoute(
  routeId: string,
  state: AppStore,
  blockGroups: BlockGroupData[],
): CoverageResult {
  const route = state.routes.find((r) => r.route_id === routeId);
  const bufferMiles = route?.route_type === 0 ? 0.5 : 0.25;

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
