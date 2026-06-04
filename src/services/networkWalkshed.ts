/**
 * Street-network walksheds via the Mapbox Isochrone API (walking profile).
 *
 * The default Coverage analysis models each stop's walkshed as a straight-line
 * (¼–½ mi) circle. This module replaces those circles with actual walking-time
 * isochrones — the area you can reach on foot within N minutes following the
 * street network — which is a far more honest picture of who a stop serves
 * (rivers, freeways, and missing sidewalks all cut the real walkshed well below
 * the crow-flies circle). It is a PAID-tier capability (see the
 * `network_walksheds` feature key); free users keep the straight-line buffer.
 *
 * Pipeline:
 *   1. For each distinct stop coordinate (rounded, deduped), call the Isochrone
 *      API for the requested walk-time and keep the returned polygon.
 *   2. Union every stop polygon into one (multi)polygon walkshed.
 *   3. Apportion each Census block group's population by how much of its modeled
 *      circle falls inside that walkshed, then feed the fractions into the SAME
 *      `coverageFromFractions` the straight-line path uses — so every demographic
 *      number is computed identically and just reflects the tighter geometry.
 *
 * Cost / rate-limit notes (Mapbox Isochrone API):
 *   - One API request PER DISTINCT STOP COORDINATE per analysis. We dedupe by
 *     rounded coordinate and cache results in-memory for the session, but a feed
 *     with many unique stops can still issue hundreds of requests.
 *   - Mapbox's default Isochrone rate limit is ~300 requests/minute; the free
 *     monthly allowance is limited. We CAP the number of requests per analysis
 *     (MAX_ISOCHRONE_REQUESTS) and surface a clear message rather than silently
 *     truncating the walkshed when a feed exceeds the cap.
 *   - On any API error/timeout we fall back to the straight-line buffer and tell
 *     the caller via the returned status so the UI can show a notice.
 */
import union from '@turf/union';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point, featureCollection } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { Stop } from '../types/gtfs';
import type { BlockGroupData } from './demographics';
import {
  coverageFromFractions,
  computeBgRadii,
  BG_RADIUS_MILES,
  type CoverageResult,
} from './coverageAnalysis';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

/** Coordinate rounding for dedupe + cache key. ~3 decimals ≈ 110m, plenty for
 *  walkshed-scale geometry and collapses near-coincident stops (e.g. opposite
 *  sides of one intersection) onto a single isochrone request. */
const COORD_PRECISION = 3;

/** Cap isochrone API calls per analysis. Above this we refuse rather than
 *  silently truncating. Tuned to stay well under Mapbox's ~300/min limit while
 *  covering most small/medium agency feeds after coordinate dedupe. */
export const MAX_ISOCHRONE_REQUESTS = 200;

/** Per-request timeout (ms) before we treat the isochrone call as failed. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * How finely we sample each block group's modeled circle to estimate the
 * fraction inside the (irregular) walkshed polygon. The straight-line path has
 * a closed-form circle-circle overlap; an isochrone is an arbitrary polygon, so
 * we Monte-Carlo / grid sample the BG circle instead. 1 center + 2 rings × 8
 * spokes = 17 points → fraction granularity of ~1/17, smoothed by ring weights.
 */
const SAMPLE_RINGS = [
  { r: 0.0, n: 1 },
  { r: 0.5, n: 8 },
  { r: 1.0, n: 8 },
];

/** Default walk-time minutes mirroring the straight-line distance choices.
 *  ~3 mph walking → ¼ mi ≈ 5 min, ½ mi ≈ 10 min. */
export const WALK_MINUTES_FOR_DISTANCE: Record<string, number> = {
  '0.25': 5,
  '0.5': 10,
};

export type WalkMinutes = 5 | 10 | 15;

export const WALK_MINUTE_OPTIONS: { minutes: WalkMinutes; label: string }[] = [
  { minutes: 5, label: '5 min walk (≈ ¼ mi)' },
  { minutes: 10, label: '10 min walk (≈ ½ mi)' },
  { minutes: 15, label: '15 min walk (≈ ¾ mi)' },
];

export type WalkshedStatus = 'ok' | 'capped' | 'error' | 'empty';

export interface NetworkWalkshedResult {
  status: WalkshedStatus;
  /** Unioned walkshed polygon (null on error/empty/capped). */
  polygon: Feature<Polygon | MultiPolygon> | null;
  /** Distinct stop coordinates that required an isochrone request. */
  requestCount: number;
  /** How many requests would have been needed (for the capped message). */
  neededRequests: number;
  /** Human-readable detail for the UI notice (set on capped/error). */
  message?: string;
}

type WalkshedPolygon = Feature<Polygon | MultiPolygon>;

// Session cache: rounded-coord + minutes → polygon (or null when the API had no
// reachable area for that point). Keeps re-analysis and per-route reuse cheap.
const isochroneCache = new Map<string, WalkshedPolygon | null>();

function roundCoord(n: number): number {
  return Number(n.toFixed(COORD_PRECISION));
}

function cacheKey(lon: number, lat: number, minutes: number): string {
  return `${roundCoord(lon)},${roundCoord(lat)}@${minutes}`;
}

/** Exposed for tests — clears the in-memory isochrone cache. */
export function _clearIsochroneCache(): void {
  isochroneCache.clear();
}

/**
 * Fetch a single walking isochrone polygon for one stop coordinate.
 * Returns null when the API reports no reachable area; throws on HTTP/timeout
 * error so the batch caller can fall back.
 */
async function fetchIsochrone(
  lon: number,
  lat: number,
  minutes: number,
): Promise<WalkshedPolygon | null> {
  const key = cacheKey(lon, lat, minutes);
  if (isochroneCache.has(key)) return isochroneCache.get(key) ?? null;

  const url =
    `https://api.mapbox.com/isochrone/v1/mapbox/walking/${roundCoord(lon)},${roundCoord(lat)}` +
    `?contours_minutes=${minutes}&polygons=true&denoise=1&access_token=${MAPBOX_TOKEN}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let data: { features?: Feature[] };
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Isochrone API returned ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const feat = (data.features ?? []).find(
    (f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
  ) as WalkshedPolygon | undefined;
  const result = feat ?? null;
  isochroneCache.set(key, result);
  return result;
}

/**
 * Build a unioned street-network walkshed for a set of stops.
 *
 * - Dedupes stops by rounded coordinate (one isochrone per distinct location).
 * - Caps the number of API calls; returns status 'capped' (no truncation) when
 *   a feed needs more than MAX_ISOCHRONE_REQUESTS distinct isochrones.
 * - Returns status 'error' (with the polygon null) if any request fails, so the
 *   caller can fall back to the straight-line buffer with a notice.
 */
export async function buildNetworkWalkshed(
  stops: Stop[],
  minutes: number,
): Promise<NetworkWalkshedResult> {
  // Distinct rounded coordinates.
  const distinct = new Map<string, { lon: number; lat: number }>();
  for (const s of stops) {
    const k = `${roundCoord(s.stop_lon)},${roundCoord(s.stop_lat)}`;
    if (!distinct.has(k)) distinct.set(k, { lon: s.stop_lon, lat: s.stop_lat });
  }
  const coords = [...distinct.values()];

  if (coords.length === 0) {
    return { status: 'empty', polygon: null, requestCount: 0, neededRequests: 0 };
  }

  // Count how many of those actually need a (non-cached) request.
  const uncached = coords.filter(
    (c) => !isochroneCache.has(cacheKey(c.lon, c.lat, minutes)),
  );
  if (uncached.length > MAX_ISOCHRONE_REQUESTS) {
    return {
      status: 'capped',
      polygon: null,
      requestCount: 0,
      neededRequests: uncached.length,
      message:
        `Network walksheds need ${uncached.length} Mapbox isochrone requests for this feed, ` +
        `over the ${MAX_ISOCHRONE_REQUESTS} per-analysis cap. ` +
        `Showing the straight-line buffer instead. Hide some routes (analysis is scoped to ` +
        `visible routes) to bring the stop count down.`,
    };
  }

  let polygon: WalkshedPolygon | null = null;
  let requestCount = 0;
  try {
    for (const c of coords) {
      const wasCached = isochroneCache.has(cacheKey(c.lon, c.lat, minutes));
      const iso = await fetchIsochrone(c.lon, c.lat, minutes);
      if (!wasCached) requestCount++;
      if (!iso) continue;
      polygon = polygon ? unionTwo(polygon, iso) : iso;
    }
  } catch (err) {
    return {
      status: 'error',
      polygon: null,
      requestCount,
      neededRequests: coords.length,
      message:
        `Couldn't reach the Mapbox Isochrone API (${err instanceof Error ? err.message : 'network error'}). ` +
        `Showing the straight-line buffer instead.`,
    };
  }

  if (!polygon) {
    return { status: 'empty', polygon: null, requestCount, neededRequests: coords.length };
  }
  return { status: 'ok', polygon, requestCount, neededRequests: coords.length };
}

/** Union two polygons, falling back to the first if turf can't merge them. */
function unionTwo(a: WalkshedPolygon, b: WalkshedPolygon): WalkshedPolygon {
  try {
    const merged = union(featureCollection([a, b]));
    return (merged as WalkshedPolygon | null) ?? a;
  } catch {
    return a;
  }
}

/**
 * Estimate the fraction of a block group's modeled circle (center `lon,lat`,
 * radius `radiusMiles`) that lies inside the walkshed polygon, by sampling a
 * small ring grid. Pure + exported for testing.
 */
export function circlePolygonOverlapFraction(
  lon: number,
  lat: number,
  radiusMiles: number,
  polygon: WalkshedPolygon,
): number {
  let weightInside = 0;
  let weightTotal = 0;
  const center = point([lon, lat]);
  // Center sample.
  for (const ring of SAMPLE_RINGS) {
    // Weight each ring by its annular area share so outer (larger) rings count
    // proportionally more — approximating an area integral over the disc.
    const ringWeight = ring.r === 0 ? 0.25 : ring.r; // center disc vs. ring radius
    const per = ringWeight / ring.n;
    for (let i = 0; i < ring.n; i++) {
      const theta = (2 * Math.PI * i) / ring.n;
      // Offset in miles → approximate degrees (lat: 1° ≈ 69 mi; lon scaled by cos lat).
      const dMiles = ring.r * radiusMiles;
      const dLat = (dMiles * Math.cos(theta)) / 69;
      const dLon = (dMiles * Math.sin(theta)) / (69 * Math.cos((lat * Math.PI) / 180) || 1);
      const p = ring.r === 0 ? center : point([lon + dLon, lat + dLat]);
      weightTotal += per;
      if (booleanPointInPolygon(p, polygon)) weightInside += per;
      if (ring.r === 0) break; // single center point
    }
  }
  return weightTotal > 0 ? weightInside / weightTotal : 0;
}

/**
 * Apportion coverage of a set of block groups against a network-walkshed
 * polygon, reusing the SAME `coverageFromFractions` summation the straight-line
 * path uses. `bufferMiles` is carried through only as the result's label.
 */
export function coverageFromWalkshed(
  polygon: WalkshedPolygon,
  blockGroups: BlockGroupData[],
  bufferMiles: number,
): CoverageResult {
  const radii = computeBgRadii(blockGroups);
  const fractions = new Map<string, number>();
  for (const bg of blockGroups) {
    const r = radii.get(bg.geoid) ?? BG_RADIUS_MILES;
    const f = circlePolygonOverlapFraction(bg.lon, bg.lat, r, polygon);
    if (f > 0) fractions.set(bg.geoid, f);
  }
  return coverageFromFractions(fractions, blockGroups, bufferMiles);
}

/**
 * Build a walkshed polygon restricted to one route's stops, for per-route
 * coverage. Reuses the session cache, so the stop isochrones fetched for the
 * system walkshed are reused here for free.
 */
export async function walkshedForStops(
  stops: Stop[],
  minutes: number,
): Promise<WalkshedPolygon | null> {
  const res = await buildNetworkWalkshed(stops, minutes);
  return res.polygon;
}

/** GeoJSON for map display: the walkshed polygon tagged for the coverage layer. */
export function walkshedGeoJSON(
  polygon: WalkshedPolygon | null,
  routeColor: string,
  routeId: string,
): GeoJSON.Feature[] {
  if (!polygon) return [];
  return [
    {
      ...polygon,
      properties: { ...(polygon.properties ?? {}), route_id: routeId, route_color: routeColor },
    },
  ];
}
