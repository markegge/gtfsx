/**
 * EXACT census-block-level Coverage tabulation (nationwide: 50 states + DC).
 *
 * The default Coverage path (coverageAnalysis.ts) pins each ACS block group to
 * its parent tract's centroid and apportions population via overlapping discs —
 * effectively tract-resolution geometry. Instead we load a FlatGeobuf of one
 * POINT per census block (built by demand-dots/coverage-pipeline/, served from
 * R2 at /_coverage/us.fgb) carrying EXACT integer attributes, and tabulate the
 * blocks whose centroid falls inside the transit walkshed. That gives precise
 * population / jobs / equity counts instead of an apportioned estimate, and adds
 * block-level LODES jobs (which the disc method could not provide).
 *
 * Region gating lives with the caller: US feeds (50 states + DC) use this path;
 * territories / non-US feeds keep the unchanged block-group/disc method.
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import union from '@turf/union';
import { point, featureCollection } from '@turf/helpers';
import { geojson as fgbGeojson } from 'flatgeobuf';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { Stop } from '../types/gtfs';
import type { CoverageResult } from './coverageAnalysis';

/**
 * FIPS codes for the 50 states + DC — the geographies in the nationwide
 * `coverage/us.fgb` layer (the offline build excludes territories by default).
 * A feed in any of these uses the exact block layer; anything else (territories,
 * outside the US) falls back to the block-group estimate.
 */
const US_STATE_FIPS = new Set([
  '01', '02', '04', '05', '06', '08', '09', '10', '11', '12', '13', '15', '16',
  '17', '18', '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29',
  '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42',
  '44', '45', '46', '47', '48', '49', '50', '51', '53', '54', '55', '56',
]);

/**
 * The block region key for a state FIPS, or null when no block-level layer
 * exists. Nationwide: the single `us` layer covers all 50 states + DC.
 */
export function regionForState(stateFips: string): string | null {
  return US_STATE_FIPS.has(stateFips) ? 'us' : null;
}

/**
 * Coarse bounds for the 50 states (contiguous US + Alaska + Hawaii) — a cheap
 * gate for the per-stop jobs fetch when a FIPS lookup isn't handy. The .fgb
 * bbox query is exact, so this only avoids fetching the layer for stops clearly
 * outside the US.
 */
export function isInUS(lat: number, lon: number): boolean {
  if (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66.5) return true; // CONUS
  if (lat >= 51 && lat <= 72 && lon >= -180 && lon <= -129) return true; // Alaska
  if (lat >= 18 && lat <= 23 && lon >= -161 && lon <= -154) return true; // Hawaii
  return false;
}

/**
 * One census block: its internal-point centroid plus the EXACT .fgb attributes.
 *
 * ── Two kinds of number live on this record, and they must not be blurred ─────
 *
 * COUNTS — a straight ACS table lookup, apportioned to the block:
 *     pop, workers, minority, lowinc, senior, youth, carless, disability   (people)
 *     hh, occ_hh, zeroveh_hh                                           (households)
 *     race_pop, pov_univ                                              (denominators)
 *     jobs                                        (a WORKPLACE universe — LODES)
 *
 * ESTIMATES — PUMS-derived statistical UNIONS, de-duplicated:
 *     prop_all   ridership propensity = carless ∪ low-income
 *     need_all   transit need         = carless ∪ low-income ∪ senior ∪ disability
 *
 * The ACS publishes marginals at block group and no joint distribution below
 * PUMA, so "how many DISTINCT people are carless OR low-income" cannot be read
 * off a table — it is estimated (independence backbone × a PUMA correction
 * measured from PUMS person records, Fréchet-clamped) by the same Python module
 * that builds the demand-dot tiles (demand-dots/puma_union.py). The map UI badges
 * the composite "estimate" and each segment "ACS count"; the coverage and
 * walkshed UI do the same, and nothing here may present a union as a headcount.
 *
 * The columns satisfy, on every block, BY CONSTRUCTION:
 *     carless, lowinc, senior, disability  ≤  need_all  ≤  pop
 *     carless, lowinc                      ≤  prop_all  ≤  need_all
 * so a segment can never out-number the union containing it.
 *
 * THE CATEGORIES OVERLAP. One person can be carless AND low-income AND a senior.
 * Never sum them — there is no honest total.
 *
 * `carless` is PEOPLE (zero-vehicle households × the PUMA's measured zero-vehicle
 * household size, ~1.8). `zeroveh_hh` is the raw HOUSEHOLD count and is the Title
 * VI equity numerator. They are different units; do not swap them.
 *
 * The old `riders` column (renters ∪ carless ∪ adults 18–24, × an invented 0.6)
 * is GONE from the layer — a different, abandoned model.
 */
export interface BlockPoint {
  lon: number;
  lat: number;
  geoid: string;
  pop: number;
  hh: number;
  workers: number;
  minority: number;
  race_pop: number;
  lowinc: number;
  pov_univ: number;
  zeroveh_hh: number;
  occ_hh: number;
  senior: number;
  youth: number;
  /** COUNT — people in zero-vehicle households (ACS B25044 × PUMS household size). */
  carless: number;
  /** COUNT — civilian adults 18+ living with a disability (ACS C21007). */
  disability: number;
  /** ESTIMATE — ridership propensity: carless ∪ low-income, de-duplicated. */
  prop_all: number;
  /** ESTIMATE — transit need: + seniors + disability, de-duplicated. */
  need_all: number;
  jobs: number;
}

/**
 * A CoverageResult computed from exact blocks. Adds the numbers that ONLY the
 * exact block layer can supply: jobs, the covered/total block tallies, the two
 * union ESTIMATES, and the two segments the live-ACS path does not fetch.
 *
 * These live here and not on `CoverageResult` on purpose. The block-group path is
 * tract-centroid-smeared, and a de-duplicated propensity number computed on top of
 * that geometry would carry more apportionment error than the model error it
 * quotes. Where there is no block layer, the UI says the estimate is unavailable
 * rather than substituting a worse one.
 */
export interface BlockCoverageResult extends CoverageResult {
  totalJobs: number;
  blocksCovered: number;
  blocksTotal: number;
  /** ESTIMATE — ridership propensity (carless ∪ low-income), de-duplicated. */
  propensityAll: number;
  /** ESTIMATE — transit need (+ seniors + disability), de-duplicated. */
  needAll: number;
  /** COUNT — people in zero-vehicle households. Not the same as zeroVehicleHouseholds. */
  carlessPop: number;
  /** COUNT — civilian adults 18+ living with a disability (ACS C21007). */
  disabilityPop: number;
}

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bounding box of a set of stops, padded by `padDeg` degrees (~0.02° ≈ 1.4 mi)
 * so blocks just outside the outermost stops — but still inside their ½-mi
 * walkshed — are loaded. Returns null for an empty stop set.
 */
export function bboxFromStops(stops: Stop[], padDeg = 0.02): Bbox | null {
  if (stops.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stops) {
    if (s.stop_lon < minX) minX = s.stop_lon;
    if (s.stop_lon > maxX) maxX = s.stop_lon;
    if (s.stop_lat < minY) minY = s.stop_lat;
    if (s.stop_lat > maxY) maxY = s.stop_lat;
  }
  return {
    minX: minX - padDeg,
    minY: minY - padDeg,
    maxX: maxX + padDeg,
    maxY: maxY + padDeg,
  };
}

/** Same-origin URL of a region's block FlatGeobuf. */
function coverageUrl(region: string): string {
  const path = `/_coverage/${region}.fgb`;
  // Absolute when a window origin exists (browser); the bare path otherwise.
  return typeof window !== 'undefined' && window.location?.origin
    ? `${window.location.origin}${path}`
    : path;
}

/** Numeric .fgb columns, in schema order. Must match ATTR_KEYS + `jobs` in
 *  demand-dots/coverage-pipeline/build_coverage_blocks.py. */
const NUM_FIELDS: (keyof BlockPoint)[] = [
  'pop', 'hh', 'workers',
  'minority', 'race_pop', 'lowinc', 'pov_univ',
  'zeroveh_hh', 'occ_hh', 'senior', 'youth',
  'carless', 'disability', 'prop_all', 'need_all', 'jobs',
];

/**
 * Columns that exist ONLY in the current (post-union) layer schema. Their absence
 * means the served .fgb predates the two-group model.
 *
 * WHY THIS GUARD EXISTS — a deploy-ordering trap with no error surface.
 * ────────────────────────────────────────────────────────────────────
 * The layer is a 1.6 GB artifact in R2, regenerated by a separate, deliberate,
 * hours-long run. The client and the layer therefore ship independently, and if
 * this code goes out first it will ask an OLD .fgb for `prop_all`, get
 * `undefined`, coerce it to 0 via `Number(undefined) || 0`, and render
 * "Ridership propensity: 0" — a confident, specific, wrong number, with nothing
 * logged anywhere.
 *
 * Zero is the worst possible failure mode here: it is indistinguishable from a
 * real answer. So a stale layer is treated as NO layer. The caller's existing
 * fallback then reports straight ACS counts from the block-group path and says
 * the estimate is unavailable, which is true.
 */
const REQUIRED_UNION_FIELDS = ['prop_all', 'need_all', 'carless', 'disability'] as const;

/** Thrown when the served coverage layer predates the two-group union schema. */
export class CoverageLayerSchemaError extends Error {}

/**
 * Stream the blocks intersecting `bbox` from the region's FlatGeobuf via the
 * FlatGeobuf HTTP client (spatially-indexed Range requests, so only the
 * relevant features are fetched). Returns the block points inside the bbox.
 *
 * Throws CoverageLayerSchemaError if the layer is on the old schema — see
 * REQUIRED_UNION_FIELDS. Callers already fall back to the block-group estimate on
 * any load failure, so a stale layer degrades to "counts only, no estimate"
 * rather than to a fabricated zero.
 */
export async function loadBlocksInBbox(region: string, bbox: Bbox): Promise<BlockPoint[]> {
  const url = coverageUrl(region);
  const rect = { minX: bbox.minX, minY: bbox.minY, maxX: bbox.maxX, maxY: bbox.maxY };
  const out: BlockPoint[] = [];
  let schemaChecked = false;
  // deserialize(url, rect) yields one GeoJSON Feature (Point) per matching block.
  const iter = fgbGeojson.deserialize(url, rect) as AsyncGenerator<Feature>;
  for await (const feat of iter) {
    const geom = feat.geometry;
    if (!geom || geom.type !== 'Point') continue;
    const [lon, lat] = geom.coordinates as [number, number];
    const props = (feat.properties ?? {}) as Record<string, unknown>;

    // Check once, on the first real feature: every block in a layer carries the
    // same columns, so one is a complete test of the schema.
    if (!schemaChecked) {
      schemaChecked = true;
      const missing = REQUIRED_UNION_FIELDS.filter((f) => !(f in props));
      if (missing.length > 0) {
        throw new CoverageLayerSchemaError(
          `The census-block coverage layer is on an older schema (missing: ${missing.join(', ')}). ` +
            'It predates the ridership-propensity / transit-need model and must be regenerated ' +
            '(demand-dots/coverage-pipeline/build_us.py) before block-level analysis can run.',
        );
      }
    }
    const bp: BlockPoint = {
      lon, lat,
      geoid: String(props.geoid ?? ''),
      pop: 0, hh: 0, workers: 0,
      minority: 0, race_pop: 0, lowinc: 0, pov_univ: 0,
      zeroveh_hh: 0, occ_hh: 0, senior: 0, youth: 0,
      carless: 0, disability: 0, prop_all: 0, need_all: 0, jobs: 0,
    };
    for (const f of NUM_FIELDS) {
      const v = props[f];
      (bp[f] as number) = typeof v === 'number' ? v : Number(v) || 0;
    }
    out.push(bp);
  }
  return out;
}

/**
 * Union a set of walkshed polygons (per-stop buffers or network isochrones)
 * into one (multi)polygon, ignoring any non-polygon / null-geometry features.
 * Returns null when there's nothing to union.
 */
export function unionWalkshedPolygons(
  features: Feature[],
): Feature<Polygon | MultiPolygon> | null {
  const polys = features.filter(
    (f): f is Feature<Polygon | MultiPolygon> =>
      f.geometry != null &&
      (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'),
  );
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0];
  try {
    return (union(featureCollection(polys)) as Feature<Polygon | MultiPolygon> | null) ?? null;
  } catch {
    // Degenerate geometry — fall back to a per-feature OR test by returning the
    // collection's first polygon is wrong, so signal "no union" and let the
    // caller test each feature individually.
    return null;
  }
}

/**
 * Tabulate the exact block attributes for every block whose centroid lies inside
 * the walkshed (counted once — union semantics, matching the current coverage
 * model). `walkshed` is the unioned walkshed polygon; when it could not be
 * unioned, pass `walkshedFeatures` so each block is tested against ANY feature.
 */
export function tabulateBlocks(
  blocks: BlockPoint[],
  walkshed: Feature<Polygon | MultiPolygon> | null,
  walkshedFeatures?: Feature[],
): BlockCoverageResult {
  const inside = (lon: number, lat: number): boolean => {
    const p = point([lon, lat]);
    if (walkshed) return booleanPointInPolygon(p, walkshed);
    if (walkshedFeatures) {
      for (const f of walkshedFeatures) {
        if (
          f.geometry != null &&
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') &&
          booleanPointInPolygon(p, f as Feature<Polygon | MultiPolygon>)
        ) {
          return true;
        }
      }
    }
    return false;
  };

  let pop = 0, hh = 0, workers = 0;
  let minority = 0, racePop = 0, lowinc = 0, povUniv = 0;
  let zeroVeh = 0, occHh = 0, senior = 0, youth = 0, jobs = 0;
  let carless = 0, disability = 0, propAll = 0, needAll = 0;
  const coveredIds: string[] = [];

  for (const b of blocks) {
    if (!inside(b.lon, b.lat)) continue;
    coveredIds.push(b.geoid);
    pop += b.pop;
    hh += b.hh;
    workers += b.workers;
    minority += b.minority;
    racePop += b.race_pop;
    lowinc += b.lowinc;
    povUniv += b.pov_univ;
    zeroVeh += b.zeroveh_hh;
    occHh += b.occ_hh;
    senior += b.senior;
    youth += b.youth;
    carless += b.carless;
    disability += b.disability;
    // Summing the per-block unions IS the right aggregation: each block's union
    // is the count of DISTINCT people in that block, and blocks are disjoint, so
    // the walkshed total is a sum of disjoint sets — no double-counting is
    // possible across blocks. (Deduplication only ever had to happen WITHIN a
    // geography, and the pipeline already did it there.)
    propAll += b.prop_all;
    needAll += b.need_all;
    jobs += b.jobs;
  }

  return {
    totalPopulation: pop,
    totalHouseholds: hh,
    totalWorkers: workers,
    minorityPop: minority,
    totalRacePop: racePop,
    lowIncomePop: lowinc,
    povertyUniverse: povUniv,
    zeroVehicleHouseholds: zeroVeh,
    occupiedHouseholds: occHh,
    seniorPop: senior,
    youthPop: youth,
    // CoverageResult bookkeeping: there are no per-block-group fractions in
    // block mode, so carry the covered block geoids and an empty fractions map.
    coveredBlockGroupIds: coveredIds,
    bufferMiles: 0.25,
    fractions: new Map<string, number>(),
    totalJobs: jobs,
    blocksCovered: coveredIds.length,
    blocksTotal: blocks.length,
    propensityAll: propAll,
    needAll,
    carlessPop: carless,
    disabilityPop: disability,
  };
}
