/**
 * Spatial metrics for the A2 variant-compare modal — the Demographics /
 * Coverage / Equity side of the comparison.
 *
 * The operational metrics (revenue hours, cost, peak vehicles) are pure,
 * cheap, in-memory computations over a variant's trips/calendars and come from
 * the cost engine via feedDiff. THESE are the expensive half: they tabulate the
 * exact census-block layer inside a variant's stop walksheds, which means a
 * spatially-indexed HTTP Range read of the nationwide FlatGeobuf
 * (blockCoverage.ts → walkshedProfile.analyzeWalkshedProfiles). So the results
 * are CACHED per variant for the session — see the cache section below.
 *
 * All three spatial numbers come from ONE walkshed profile of the variant's
 * whole stop set (`analyzeWalkshedProfiles(...).system` — the union over every
 * stop, each census block counted once):
 *   Demographics — residents within a walk of any stop (population), + households + jobs
 *   Coverage     — census blocks reachable from any stop (spatial reach)
 *   Equity       — transit-need population served (needAll = carless ∪ low-income ∪
 *                  senior ∪ disability, de-duplicated ESTIMATE) + the four Title VI
 *                  segments (carless / low-income / seniors / disability)
 *
 * Availability mirrors the walkshed profile exactly: US feeds (50 states + DC)
 * only; anything else, or a stale/missing block layer, throws (WalkshedProfile
 * Error / CoverageLayerSchemaError / a fetch error) and the modal shows an
 * "unavailable for this feed" note rather than a fabricated zero.
 */
import type { Bbox, BlockPoint } from './blockCoverage';
import { loadBlocksInBbox } from './blockCoverage';
import { analyzeWalkshedProfiles, type WalkshedProfileInput } from './walkshedProfile';

/** The one bundle of spatial numbers a variant contributes to the comparison. */
export interface SpatialMetrics {
  /** Demographics — residents within a walk of any stop (ACS count). */
  population: number;
  households: number;
  /** Jobs at the WORKPLACE (LODES) — a different universe; never add to residents. */
  jobs: number;
  /** Coverage — distinct census blocks reachable from any stop (each counted once). */
  blocksCovered: number;
  stopCount: number;
  /** Equity — transit need: de-duplicated union of the four segments. ESTIMATE, not a count. */
  needAll: number;
  /** Ridership propensity: carless ∪ low-income, de-duplicated. ESTIMATE, not a count. */
  propensityAll: number;
  carless: number;
  lowIncome: number;
  seniors: number;
  disability: number;
}

/** The feed slices the spatial metrics depend on — a subset of a FeedState. */
export type SpatialInput = WalkshedProfileInput;

export type LoadBlocksFn = (region: string, bbox: Bbox) => Promise<BlockPoint[]>;

/**
 * Compute the spatial bundle for one variant's stop set. Wraps the tested
 * walkshed-profile run and keeps only its system-level union. `loadBlocks` is
 * injectable so the network layer can be faked at the seam (as the coverage
 * tests do). Throws on an unsupported feed / missing layer — the caller decides
 * how to surface that; failures are never cached.
 */
export async function computeSpatialMetrics(
  input: SpatialInput,
  loadBlocks: LoadBlocksFn = loadBlocksInBbox,
): Promise<SpatialMetrics> {
  const { system } = await analyzeWalkshedProfiles(input, loadBlocks);
  const c = system.counts;
  return {
    population: c.population,
    households: c.households,
    jobs: c.jobs,
    blocksCovered: system.blocksCounted,
    stopCount: system.stopCount,
    needAll: c.needAll,
    propensityAll: c.propensityAll,
    carless: c.carless,
    lowIncome: c.lowIncome,
    seniors: c.seniors,
    disability: c.disability,
  };
}

/* ──────────────────────────── fingerprint ──────────────────────────── */

/** FNV-1a 32-bit hash of a short string. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Cheap, order-independent fingerprint of the ONLY inputs that change the
 * spatial answer: each stop's position and its resolved walk buffer (½ mi if
 * served by any tram / light-rail route, else ¼ mi — mirrors bufferMilesForStop,
 * but resolved in one pass rather than O(stops × routeStops)).
 *
 * Rearranging the stop / routeStop arrays, or editing anything that ISN'T a stop
 * (retiming a trip, renaming a route, changing a fare), leaves this constant —
 * so those edits keep the cached metrics, which is correct: coverage doesn't
 * depend on them. A stop moving / being added / removed, or a route flipping to
 * or from tram, changes it — which is exactly when the cache must invalidate.
 */
export function stopSetFingerprint(input: SpatialInput): string {
  const tramRouteIds = new Set(
    input.routes.filter((r) => r.route_type === 0).map((r) => r.route_id),
  );
  const tramStops = new Set<string>();
  if (tramRouteIds.size > 0) {
    for (const rs of input.routeStops) {
      if (tramRouteIds.has(rs.route_id)) tramStops.add(rs.stop_id);
    }
  }
  let acc = 0;
  let n = 0;
  for (const s of input.stops) {
    const buf = tramStops.has(s.stop_id) ? 0.5 : 0.25;
    // Order-independent: fold each stop's hash into a running 32-bit sum.
    acc = (acc + fnv1a(`${s.stop_id}|${s.stop_lat}|${s.stop_lon}|${buf}`)) >>> 0;
    n++;
  }
  return `${n}:${acc.toString(16)}`;
}

/* ──────────────────────────── session cache ────────────────────────────
 *
 * Session-scoped, keyed by variant id, each entry tagged with the stop-set
 * fingerprint it was computed under. On lookup the current fingerprint is
 * recomputed and compared:
 *
 *   - INACTIVE variants hold a FROZEN snapshot (variantSlice), so their stop set
 *     never changes → their fingerprint is constant → a permanent hit for the
 *     rest of the session. Re-opening the modal or flipping the pickers back to
 *     them costs nothing (no network).
 *   - The ACTIVE variant is read from the LIVE store (variants.variantFeedState),
 *     so its fingerprint tracks unsaved edits. A stop move / add / remove, or a
 *     tram-service change, shifts the fingerprint → miss → recompute. Any other
 *     edit leaves it unchanged → hit (correctly — the coverage didn't change).
 *
 * The cache lives here (module scope) rather than in a store slice for the same
 * reason variants themselves do: it is session-scoped, in-memory, and outside
 * the persisted working state.
 */

interface CacheEntry {
  fingerprint: string;
  metrics: SpatialMetrics;
}

const spatialCache = new Map<string, CacheEntry>();

/**
 * Cached spatial metrics for `variantId` IF present and still valid for the
 * current stop set (fingerprint match), else null. Synchronous — lets the modal
 * render a cache hit instantly with no computing spinner.
 */
export function peekVariantSpatialMetrics(
  variantId: string,
  input: SpatialInput,
): SpatialMetrics | null {
  const hit = spatialCache.get(variantId);
  return hit && hit.fingerprint === stopSetFingerprint(input) ? hit.metrics : null;
}

/**
 * Spatial metrics for a variant, memoized for the session. Returns the cached
 * bundle on a fingerprint match (no recompute, no network); otherwise computes,
 * caches, and returns. Failures are NOT cached, so a transient network error
 * can be retried on the next open.
 */
export async function getVariantSpatialMetrics(
  variantId: string,
  input: SpatialInput,
  loadBlocks: LoadBlocksFn = loadBlocksInBbox,
): Promise<SpatialMetrics> {
  const fingerprint = stopSetFingerprint(input);
  const hit = spatialCache.get(variantId);
  if (hit && hit.fingerprint === fingerprint) return hit.metrics;
  const metrics = await computeSpatialMetrics(input, loadBlocks);
  spatialCache.set(variantId, { fingerprint, metrics });
  return metrics;
}

/** Drop every cached bundle (tests; also safe to call on discardVariants). */
export function clearVariantSpatialCache(): void {
  spatialCache.clear();
}

/* ──────────────────────────── deltas ──────────────────────────── */

export type SpatialDelta = Record<keyof SpatialMetrics, number>;

/** Per-field B − A delta of two spatial bundles. Pure. */
export function spatialDelta(a: SpatialMetrics, b: SpatialMetrics): SpatialDelta {
  const out = {} as SpatialDelta;
  for (const k of Object.keys(a) as (keyof SpatialMetrics)[]) {
    out[k] = b[k] - a[k];
  }
  return out;
}
