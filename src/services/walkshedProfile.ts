/**
 * Walkshed demographic PROFILE — who is inside a stop's walk buffer, and who is
 * inside a whole route's walk buffer.
 *
 * This is a COUNTING feature, not a forecast. It tabulates the census blocks
 * whose centroid falls inside a walkshed and reports the people/households/jobs
 * in them, by category. There is deliberately NO ridership model here: no
 * coefficients, no elasticities, no predicted boardings. GTFS·X does not
 * synthesise ridership (docs/REQUIREMENTS.md), and nothing in this module may
 * start.
 *
 * ── Why census blocks (blockCoverage.ts) and not block groups (coverageAnalysis.ts)
 * The block-group path pins each block group to its PARENT TRACT's centroid and
 * smears it over a 0.5–3.0 mi disc (`computeBgRadii`). At the ¼-mi scale of a
 * single stop, two adjacent stops would get near-identical numbers — the disc
 * cannot resolve them. The prebuilt block layer is one point per census block
 * with exact integer attributes, so a ¼-mi buffer is an exact point-in-circle
 * tabulation. It is also the ONLY source of `jobs`.
 *
 * ── Route aggregation is a UNION, never a sum
 * Consecutive stops on a route have heavily overlapping walksheds. Summing the
 * per-stop counts would count the same household once per nearby stop and
 * wildly inflate "people served". `routeProfile()` therefore collects the set of
 * census blocks reachable from ANY stop on the route, dedupes that set by
 * `geoid`, and sums each block exactly once. `profileFromBlocks()` dedupes
 * defensively too, so no caller can double-count by accident.
 *
 * ── The categories OVERLAP and DO NOT SUM
 * One person can be counted in `lowIncome`, `zeroVehicleHouseholds`, `seniors`
 * and `highPropensityRiders` at the same time. Never add the categories
 * together into a "total served" — there is no such number here. The UI must say
 * this out loud; see PROFILE_CATEGORIES.kind / .basis, which the panels render.
 *
 * ── Counts vs. the one estimate
 * Every category is a straight count off the census blocks EXCEPT
 * `highPropensityRiders`, which is a modelled composite (renters + zero-vehicle
 * households + adults 18–24, scaled by an ad-hoc ×0.6 dedup factor in the
 * offline pipeline). It overlaps its own components and is an ESTIMATE. It is
 * flagged `kind: 'estimate'` so the UI can label it differently, and it is
 * never presented as a count.
 *
 * ── Residence vs. workplace
 * `jobs` is counted at the WORKPLACE (LODES). Every other category is counted
 * where people LIVE (ACS/decennial). They are different universes: never add
 * jobs to population.
 */
import distance from '@turf/distance';
import { point } from '@turf/helpers';
import {
  bboxFromStops,
  isInUS,
  loadBlocksInBbox,
  type BlockPoint,
  type Bbox,
} from './blockCoverage';
import type { Route, RouteStop, Stop } from '../types/gtfs';

/* ──────────────────────────── categories ──────────────────────────── */

export type ProfileCountKey =
  | 'population'
  | 'households'
  | 'workers'
  | 'minority'
  | 'lowIncome'
  | 'zeroVehicleHouseholds'
  | 'seniors'
  | 'youth'
  | 'jobs'
  | 'highPropensityRiders';

/** Denominators carried alongside the counts so a share can be computed AFTER
 *  summing (never average pre-computed per-block shares). */
export type ProfileUniverseKey =
  | 'population'
  | 'raceUniverse'
  | 'povertyUniverse'
  | 'occupiedHouseholds';

export interface ProfileCategory {
  key: ProfileCountKey;
  label: string;
  /**
   * 'count'    — a straight tabulation of exact census-block values.
   * 'estimate' — a modelled composite. Only `highPropensityRiders`. Must never
   *              be labelled as a count in the UI.
   */
  kind: 'count' | 'estimate';
  /**
   * 'residence' — counted where people live.
   * 'workplace' — counted at the job site (LODES). A different universe from
   *               every residence-based category; never add the two.
   */
  basis: 'residence' | 'workplace';
  /** Denominator for the share, or null when the category has no meaningful one. */
  universe: ProfileUniverseKey | null;
  /** One-line definition, shown as the ⓘ tooltip. */
  note: string;
}

/**
 * The categories the block layer can actually support, in display order.
 * OVERLAPPING BY CONSTRUCTION — see the module header. Do not sum them.
 */
export const PROFILE_CATEGORIES: readonly ProfileCategory[] = [
  {
    key: 'population',
    label: 'Residents',
    kind: 'count',
    basis: 'residence',
    universe: null,
    note: 'Everyone living in the census blocks whose center falls inside the walkshed. Exact block-level count.',
  },
  {
    key: 'households',
    label: 'Households',
    kind: 'count',
    basis: 'residence',
    universe: null,
    note: 'Occupied households (ACS B25044) in the same blocks. Households, not people — do not add to Residents.',
  },
  {
    key: 'workers',
    label: 'Workers (resident)',
    kind: 'count',
    basis: 'residence',
    universe: 'population',
    note: 'Employed residents counted where they LIVE (ACS means-of-transportation-to-work universe). Not the same thing as Jobs.',
  },
  {
    key: 'jobs',
    label: 'Jobs (workplace)',
    kind: 'count',
    basis: 'workplace',
    universe: null,
    note: 'Jobs located inside the walkshed, counted at the WORKPLACE (LODES). A different universe from every residence-based row — never add it to Residents.',
  },
  {
    key: 'minority',
    label: 'Minority residents',
    kind: 'count',
    basis: 'residence',
    universe: 'raceUniverse',
    note: 'Residents who are not non-Hispanic White alone. Share is of the race/ethnicity universe in the same blocks.',
  },
  {
    key: 'lowIncome',
    label: 'Low-income residents',
    kind: 'count',
    basis: 'residence',
    universe: 'povertyUniverse',
    note: 'Residents under 200% of the federal poverty level. Share is of the poverty universe (people for whom poverty status is determined).',
  },
  {
    key: 'zeroVehicleHouseholds',
    label: 'Zero-vehicle households',
    kind: 'count',
    basis: 'residence',
    universe: 'occupiedHouseholds',
    note: 'Occupied households with no vehicle available. Households, not people. Share is of occupied households.',
  },
  {
    key: 'seniors',
    label: 'Residents 65+',
    kind: 'count',
    basis: 'residence',
    universe: 'population',
    note: 'Residents aged 65 and over. Overlaps every other residence-based row.',
  },
  {
    key: 'youth',
    label: 'Residents under 18',
    kind: 'count',
    basis: 'residence',
    universe: 'population',
    note: 'Residents under 18. Overlaps every other residence-based row.',
  },
  {
    key: 'highPropensityRiders',
    label: 'High-propensity residents',
    kind: 'estimate',
    basis: 'residence',
    universe: 'population',
    note:
      'ESTIMATE, not a count. A modelled composite of renters, people in zero-vehicle households, ' +
      'and adults 18–24, scaled by an ad-hoc ×0.6 factor to blunt (not eliminate) double-counting ' +
      'between those three groups. It overlaps its own components. It is NOT a ridership forecast — ' +
      'it says nothing about how many of these people will board.',
  },
] as const;

/**
 * KNOWN GAP — categories the prebuilt block layer does not yet carry.
 *
 * TODO(coverage-layer): `renter` (renter-occupied households) and `age_18_24`
 * are NOT attributes of the `us.fgb` block layer, even though the offline
 * high-propensity model consumes them upstream. They arrive here only when the
 * coverage layer is regenerated with those two columns (demand-dots/
 * coverage-pipeline/). Until then we deliberately DO NOT report them:
 * back-filling either one from ACS block groups would silently mix a
 * tract-smeared estimate into an exact block-level tabulation, and the two
 * numbers would not be comparable. Report what exists; say what doesn't.
 */
export const MISSING_CATEGORIES: readonly { label: string; field: string }[] = [
  { label: 'Renter households', field: 'renter' },
  { label: 'Adults 18–24', field: 'age_18_24' },
] as const;

/* ──────────────────────────── the profile ──────────────────────────── */

export interface WalkshedProfile {
  /** Category counts. OVERLAPPING — never sum across keys. */
  counts: Record<ProfileCountKey, number>;
  /** Denominators, summed over the same blocks, for share-of-universe display. */
  universes: Record<ProfileUniverseKey, number>;
  /** Distinct census blocks counted. Each block contributes AT MOST ONCE. */
  blocksCounted: number;
  /** Straight-line walk buffer applied to each stop, in miles. */
  bufferMiles: number;
  /** Stops whose walksheds were unioned into this profile. */
  stopCount: number;
}

function zeroCounts(): Record<ProfileCountKey, number> {
  return {
    population: 0,
    households: 0,
    workers: 0,
    minority: 0,
    lowIncome: 0,
    zeroVehicleHouseholds: 0,
    seniors: 0,
    youth: 0,
    jobs: 0,
    highPropensityRiders: 0,
  };
}

function zeroUniverses(): Record<ProfileUniverseKey, number> {
  return { population: 0, raceUniverse: 0, povertyUniverse: 0, occupiedHouseholds: 0 };
}

export function emptyProfile(bufferMiles: number, stopCount = 0): WalkshedProfile {
  return {
    counts: zeroCounts(),
    universes: zeroUniverses(),
    blocksCounted: 0,
    bufferMiles,
    stopCount,
  };
}

/**
 * Sum a set of census blocks into a profile.
 *
 * DEDUPES BY `geoid` — the single guarantee the whole feature rests on. Callers
 * may hand this the concatenation of several overlapping stop walksheds; each
 * distinct block still contributes exactly once.
 */
export function profileFromBlocks(
  blocks: readonly BlockPoint[],
  bufferMiles: number,
  stopCount = 0,
): WalkshedProfile {
  const counts = zeroCounts();
  const universes = zeroUniverses();
  const seen = new Set<string>();

  for (const b of blocks) {
    if (seen.has(b.geoid)) continue; // union semantics: once per block, never twice
    seen.add(b.geoid);

    counts.population += b.pop;
    counts.households += b.hh;
    counts.workers += b.workers;
    counts.minority += b.minority;
    counts.lowIncome += b.lowinc;
    counts.zeroVehicleHouseholds += b.zeroveh_hh;
    counts.seniors += b.senior;
    counts.youth += b.youth;
    counts.jobs += b.jobs;
    counts.highPropensityRiders += b.riders;

    universes.population += b.pop;
    universes.raceUniverse += b.race_pop;
    universes.povertyUniverse += b.pov_univ;
    universes.occupiedHouseholds += b.occ_hh;
  }

  return { counts, universes, blocksCounted: seen.size, bufferMiles, stopCount };
}

/**
 * Share of a category within its own universe, in [0,1]; null when the category
 * has no universe (jobs, households, residents) or the denominator is zero, so
 * the UI renders "—" rather than a misleading 0%.
 */
export function categoryShare(profile: WalkshedProfile, category: ProfileCategory): number | null {
  if (!category.universe) return null;
  const denom = profile.universes[category.universe];
  if (denom <= 0) return null;
  return profile.counts[category.key] / denom;
}

/* ──────────────────────────── buffers ──────────────────────────── */

/** Light-rail / tram walkshed. */
export const RAIL_BUFFER_MILES = 0.5;
/** Everything else (bus, ferry, heavy rail, …). */
export const DEFAULT_BUFFER_MILES = 0.25;

/**
 * Walk buffer for a route, mirroring `getBufferForRoute` (coverageAnalysis.ts):
 * ½ mi for light rail / tram (route_type 0), ¼ mi for everything else.
 */
export function bufferMilesForRouteType(routeType: number | undefined): number {
  return routeType === 0 ? RAIL_BUFFER_MILES : DEFAULT_BUFFER_MILES;
}

/**
 * Walk buffer for a single stop: ½ mi when ANY route serving it is light rail /
 * tram, else ¼ mi. Matches what the stop Coverage sub-panel already does.
 * Route membership comes from the denormalized `routeStops` table — never a
 * join through stop_times.
 */
export function bufferMilesForStop(
  stopId: string,
  routeStops: readonly RouteStop[],
  routes: readonly Route[],
): number {
  const routeById = new Map(routes.map((r) => [r.route_id, r]));
  for (const rs of routeStops) {
    if (rs.stop_id !== stopId) continue;
    if (routeById.get(rs.route_id)?.route_type === 0) return RAIL_BUFFER_MILES;
  }
  return DEFAULT_BUFFER_MILES;
}

/** Miles → the "1/4 mi" / "1/2 mi" label the coverage UI already uses. */
export function bufferLabel(miles: number): string {
  if (miles === RAIL_BUFFER_MILES) return '1/2 mi';
  if (miles === DEFAULT_BUFFER_MILES) return '1/4 mi';
  return `${miles} mi`;
}

/** Stops served by a route, from the denormalized routeStops table. */
export function stopsOnRoute(
  routeId: string,
  routeStops: readonly RouteStop[],
  stops: readonly Stop[],
): Stop[] {
  const ids = new Set(routeStops.filter((rs) => rs.route_id === routeId).map((rs) => rs.stop_id));
  return stops.filter((s) => ids.has(s.stop_id));
}

/* ──────────────────────────── spatial index ──────────────────────────── */

/** Degrees of latitude per mile (mean Earth radius). */
const DEG_LAT_PER_MILE = 1 / 69.0;
/** Grid cell size, degrees. ~0.7 mi at mid-latitudes: a ¼-mi query touches
 *  a 2×2 or 3×3 cell block, so the candidate set stays small. */
const DEFAULT_CELL_DEG = 0.01;

/**
 * Uniform grid over the loaded blocks. A whole-feed bbox can hold tens of
 * thousands of blocks, and a naive per-stop scan is O(stops × blocks) with a
 * great-circle call in the inner loop. The grid cuts each stop's candidate set
 * to the handful of cells its buffer touches.
 */
export interface BlockIndex {
  blocks: readonly BlockPoint[];
  cellDeg: number;
  /** "x:y" cell key → indices into `blocks`. */
  cells: Map<string, number[]>;
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

export function buildBlockIndex(
  blocks: readonly BlockPoint[],
  cellDeg = DEFAULT_CELL_DEG,
): BlockIndex {
  const cells = new Map<string, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const k = cellKey(Math.floor(b.lon / cellDeg), Math.floor(b.lat / cellDeg));
    const bucket = cells.get(k);
    if (bucket) bucket.push(i);
    else cells.set(k, [i]);
  }
  return { blocks, cellDeg, cells };
}

/**
 * Census blocks whose centroid lies within `radiusMiles` of (lon, lat).
 *
 * A straight-line walk buffer IS a circle, so this is an exact point-in-circle
 * test (great-circle distance) rather than a turf `buffer()` polygon +
 * point-in-polygon — same semantics, more precise (no 64-segment polygon
 * approximation) and far cheaper. The grid is only a candidate filter; every
 * candidate still gets the exact distance test.
 */
export function blocksWithin(
  index: BlockIndex,
  lon: number,
  lat: number,
  radiusMiles: number,
): BlockPoint[] {
  const { cellDeg, cells, blocks } = index;
  const dLat = radiusMiles * DEG_LAT_PER_MILE;
  // Longitude degrees shrink with latitude; guard the pole/antipode degenerate case.
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const dLon = dLat / cosLat;

  const minCx = Math.floor((lon - dLon) / cellDeg);
  const maxCx = Math.floor((lon + dLon) / cellDeg);
  const minCy = Math.floor((lat - dLat) / cellDeg);
  const maxCy = Math.floor((lat + dLat) / cellDeg);

  const center = point([lon, lat]);
  const out: BlockPoint[] = [];
  for (let cx = minCx; cx <= maxCx; cx++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      const bucket = cells.get(cellKey(cx, cy));
      if (!bucket) continue;
      for (const i of bucket) {
        const b = blocks[i];
        // Cheap rectangular reject before the great-circle call.
        if (Math.abs(b.lat - lat) > dLat || Math.abs(b.lon - lon) > dLon) continue;
        if (distance(center, point([b.lon, b.lat]), { units: 'miles' }) <= radiusMiles) {
          out.push(b);
        }
      }
    }
  }
  return out;
}

/* ──────────────────────────── profiles ──────────────────────────── */

/** Demographic profile of ONE stop's walkshed. */
export function stopProfile(
  index: BlockIndex,
  stop: Stop,
  bufferMiles: number,
): WalkshedProfile {
  const blocks = blocksWithin(index, stop.stop_lon, stop.stop_lat, bufferMiles);
  return profileFromBlocks(blocks, bufferMiles, 1);
}

/**
 * Demographic profile of a whole set of stops' walksheds — a UNION, not a sum.
 *
 * Every census block reachable from ANY of the stops is counted EXACTLY ONCE,
 * no matter how many of the stops' buffers it falls in. This is the correctness
 * property the route-level number depends on: adjacent stops on a route overlap
 * heavily, and summing their per-stop profiles would count the same households
 * several times over.
 */
export function unionProfile(
  index: BlockIndex,
  stops: readonly Stop[],
  bufferMiles: number,
): WalkshedProfile {
  const byGeoid = new Map<string, BlockPoint>();
  for (const s of stops) {
    for (const b of blocksWithin(index, s.stop_lon, s.stop_lat, bufferMiles)) {
      if (!byGeoid.has(b.geoid)) byGeoid.set(b.geoid, b);
    }
  }
  return profileFromBlocks([...byGeoid.values()], bufferMiles, stops.length);
}

/** Route-level profile: the union of every stop on the route, at the route's
 *  own walk buffer (½ mi light rail, ¼ mi otherwise). */
export function routeProfile(
  index: BlockIndex,
  route: Route,
  routeStops: readonly RouteStop[],
  stops: readonly Stop[],
): WalkshedProfile {
  const onRoute = stopsOnRoute(route.route_id, routeStops, stops);
  return unionProfile(index, onRoute, bufferMilesForRouteType(route.route_type));
}

/* ──────────────────────────── feed-wide run ──────────────────────────── */

export interface WalkshedProfileInput {
  stops: readonly Stop[];
  routes: readonly Route[];
  routeStops: readonly RouteStop[];
}

export interface WalkshedProfileResult {
  /** stop_id → profile of that stop's own walkshed. */
  byStop: Record<string, WalkshedProfile>;
  /** route_id → UNION profile over all of the route's stops. */
  byRoute: Record<string, WalkshedProfile>;
  /**
   * Union over EVERY analysed stop — the system-wide "who is within a walk of
   * any stop" number. Also a union, so it is <= the sum of the route profiles
   * (routes overlap each other too).
   */
  system: WalkshedProfile;
  /** Census blocks pulled from the layer for the feed's bbox. */
  blocksLoaded: number;
  /** Wall-clock ms for the tabulation (excludes the network fetch). */
  tabulateMs: number;
}

export class WalkshedProfileError extends Error {}

/**
 * Load the census-block layer ONCE for the whole feed's bounding box, then
 * tabulate every stop and every route against the in-memory blocks.
 *
 * The block layer is fetched with a single spatially-indexed range read over
 * the feed bbox — NOT one HTTP request per stop, which does not scale past a
 * handful of stops.
 *
 * `loadBlocks` is injectable so tests can drive the tabulation without network.
 */
export async function analyzeWalkshedProfiles(
  input: WalkshedProfileInput,
  loadBlocks: (region: string, bbox: Bbox) => Promise<BlockPoint[]> = loadBlocksInBbox,
): Promise<WalkshedProfileResult> {
  const { stops, routes, routeStops } = input;
  if (stops.length === 0) {
    throw new WalkshedProfileError('No stops to analyse.');
  }

  // Region gate: the block layer covers the 50 states + DC. A feed outside it
  // has no exact block data, and we will not silently substitute a different
  // (block-group) methodology.
  const avgLat = stops.reduce((a, s) => a + s.stop_lat, 0) / stops.length;
  const avgLon = stops.reduce((a, s) => a + s.stop_lon, 0) / stops.length;
  if (!isInUS(avgLat, avgLon)) {
    throw new WalkshedProfileError(
      'Census-block demographics are only available for feeds in the United States (50 states + DC).',
    );
  }

  const bbox = bboxFromStops([...stops]);
  if (!bbox) throw new WalkshedProfileError('No stops to analyse.');

  const blocks = await loadBlocks('us', bbox);

  const t0 = Date.now();
  const index = buildBlockIndex(blocks);

  const byStop: Record<string, WalkshedProfile> = {};
  for (const s of stops) {
    byStop[s.stop_id] = stopProfile(index, s, bufferMilesForStop(s.stop_id, routeStops, routes));
  }

  const byRoute: Record<string, WalkshedProfile> = {};
  for (const r of routes) {
    byRoute[r.route_id] = routeProfile(index, r, routeStops, stops);
  }

  // System union. Stops can sit on routes with different buffers, so union each
  // stop at ITS OWN buffer rather than forcing one radius over the whole feed.
  const systemBlocks = new Map<string, BlockPoint>();
  for (const s of stops) {
    const r = bufferMilesForStop(s.stop_id, routeStops, routes);
    for (const b of blocksWithin(index, s.stop_lon, s.stop_lat, r)) {
      if (!systemBlocks.has(b.geoid)) systemBlocks.set(b.geoid, b);
    }
  }
  const anyRail = routes.some((r) => r.route_type === 0);
  const system = profileFromBlocks(
    [...systemBlocks.values()],
    anyRail ? RAIL_BUFFER_MILES : DEFAULT_BUFFER_MILES,
    stops.length,
  );

  return {
    byStop,
    byRoute,
    system,
    blocksLoaded: blocks.length,
    tabulateMs: Date.now() - t0,
  };
}

/* ──────────────────────────── CSV ──────────────────────────── */

/**
 * One CSV row per scope (System, then each route). Columns are the categories,
 * never a total — there is no honest total to print.
 */
export function buildProfileCsvRows(
  result: WalkshedProfileResult,
  routes: readonly Route[],
): Record<string, string | number>[] {
  const row = (scope: string, routeId: string, p: WalkshedProfile) => ({
    scope,
    route_id: routeId,
    geography: 'census block (exact, union — each block counted once)',
    buffer_miles: p.bufferMiles,
    stops: p.stopCount,
    blocks_counted: p.blocksCounted,
    residents: p.counts.population,
    households: p.counts.households,
    workers_resident: p.counts.workers,
    jobs_workplace: p.counts.jobs,
    minority_residents: p.counts.minority,
    low_income_residents: p.counts.lowIncome,
    zero_vehicle_households: p.counts.zeroVehicleHouseholds,
    residents_65_plus: p.counts.seniors,
    residents_under_18: p.counts.youth,
    high_propensity_residents_ESTIMATE: p.counts.highPropensityRiders,
  });

  const rows = [row('System (union of all stops)', '', result.system)];
  for (const r of routes) {
    const p = result.byRoute[r.route_id];
    if (!p) continue;
    rows.push(row(r.route_short_name || r.route_long_name || r.route_id, r.route_id, p));
  }
  return rows;
}
