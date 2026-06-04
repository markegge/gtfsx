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
import type { Stop, Frequency } from '../types/gtfs';
import type { BlockGroupData } from './demographics';
import { gtfsTimeToSeconds } from '../utils/time';
import { representativeDay, type FeedSlice } from './stopAnalysis';
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

/** Walk-time selection. `'auto'` derives each stop's walk-time from that stop's
 *  service frequency (see {@link minutesForHeadway}); the numeric modes apply
 *  one walk-time uniformly to every stop. */
export type WalkMode = 'auto' | WalkMinutes;

/** The two walk-times the Auto rule chooses between, and their distance labels.
 *  Frequent stops earn the bigger ½-mi shed; infrequent stops the ¼-mi shed. */
export const AUTO_FREQUENT_MINUTES: WalkMinutes = 10;
export const AUTO_INFREQUENT_MINUTES: WalkMinutes = 5;

/** Headway (minutes) at/under which a stop counts as "frequent service" for the
 *  Auto walk-time rule. The transit-industry convention treats service every
 *  15 minutes or better as "frequent" (riders can show up without a schedule),
 *  so a stop with headway ≤ 15 min gets the 10-min / ½-mi walkshed and anything
 *  less frequent (or with too few departures to measure a headway) gets the
 *  5-min / ¼-mi walkshed. */
export const FREQUENT_HEADWAY_MAX_MIN = 15;

/**
 * The Auto-mode walk-time (minutes) for a stop given its representative-day
 * average headway in minutes (null = unknown / too few departures to measure).
 *
 *   headway ≤ 15 min  → 10-min / ½-mi  walkshed   (frequent service)
 *   otherwise / null  →  5-min / ¼-mi  walkshed
 *
 * Pure + exported so the classification rule is unit-tested directly.
 */
export function minutesForHeadway(headwayMin: number | null): WalkMinutes {
  return headwayMin != null && headwayMin <= FREQUENT_HEADWAY_MAX_MIN
    ? AUTO_FREQUENT_MINUTES
    : AUTO_INFREQUENT_MINUTES;
}

/**
 * Per-stop average headway (minutes) on the representative service day, used by
 * Auto mode to size each stop's walkshed. Computed from stop_times/trips:
 *
 *   - Restrict to trips active on the representative day (busiest weekday, via
 *     {@link representativeDay} — the same day the Stop Analysis panel uses).
 *   - Collect each active trip's departure time at the stop. A trip listed in
 *     `frequencies.txt` is frequency-based: it represents one departure every
 *     `headway_secs` between `start_time` and `end_time`, so we expand it into
 *     that many departures at the stop (honoring the `frequenciesSlice`).
 *   - Average headway = service span (last − first departure) ÷ (departures − 1).
 *     A single departure has no measurable headway → null (treated as
 *     infrequent). Returned in minutes.
 *
 * This is intentionally a whole-day average rather than peak/off-peak windows
 * (which `computeServiceIntensity` already exposes but can return null when a
 * stop has no departures inside the fixed peak band) — Auto just needs a robust
 * frequent-vs-infrequent signal for every served stop.
 */
export function stopHeadwaysMin(feed: FeedSlice): Map<string, number> {
  const serviceIds = representativeDay(feed).serviceIds;
  const activeTripIds = new Set(
    feed.trips.filter((t) => !serviceIds.size || serviceIds.has(t.service_id)).map((t) => t.trip_id),
  );

  // trip_id → frequency windows (a trip may have several non-overlapping ones).
  const freqByTrip = new Map<string, Frequency[]>();
  for (const f of feed.frequencies ?? []) {
    if (!f.headway_secs || f.headway_secs <= 0) continue;
    let arr = freqByTrip.get(f.trip_id);
    if (!arr) { arr = []; freqByTrip.set(f.trip_id, arr); }
    arr.push(f);
  }

  // stop_id → expanded departure times (seconds) across all active trips.
  const depsByStop = new Map<string, number[]>();
  for (const st of feed.stopTimes) {
    if (!activeTripIds.has(st.trip_id)) continue;
    const baseTime = st.departure_time || st.arrival_time;
    if (!baseTime) continue;
    const baseSec = gtfsTimeToSeconds(baseTime);

    let arr = depsByStop.get(st.stop_id);
    if (!arr) { arr = []; depsByStop.set(st.stop_id, arr); }

    const windows = freqByTrip.get(st.trip_id);
    if (windows) {
      // Frequency-based: emit one departure per headway in each window. The
      // stop_times time is the trip's reference start, so offset each window's
      // departures by the same per-window cadence beginning at start_time.
      for (const w of windows) {
        const start = gtfsTimeToSeconds(w.start_time);
        const end = gtfsTimeToSeconds(w.end_time);
        for (let t = start; t < end; t += w.headway_secs) arr.push(t);
      }
    } else {
      arr.push(baseSec);
    }
  }

  const out = new Map<string, number>();
  for (const [stopId, depsRaw] of depsByStop) {
    if (depsRaw.length < 2) continue; // one departure → no measurable headway
    const deps = depsRaw;
    const first = Math.min(...deps);
    const last = Math.max(...deps);
    const spanSec = last - first;
    if (spanSec <= 0) continue;
    out.set(stopId, spanSec / (deps.length - 1) / 60);
  }
  return out;
}

/**
 * Resolve each stop's Auto-mode walk-time (minutes) from its headway. Stops
 * with no measured headway fall through {@link minutesForHeadway} to the
 * infrequent (5-min) default. Returns a stop_id → minutes lookup.
 */
export function autoMinutesByStop(feed: FeedSlice): Map<string, WalkMinutes> {
  const headways = stopHeadwaysMin(feed);
  const out = new Map<string, WalkMinutes>();
  for (const s of feed.stops) {
    out.set(s.stop_id, minutesForHeadway(headways.get(s.stop_id) ?? null));
  }
  return out;
}

export const WALK_MINUTE_OPTIONS: { minutes: WalkMinutes; label: string }[] = [
  { minutes: 5, label: '5 min walk (≈ ¼ mi)' },
  { minutes: 10, label: '10 min walk (≈ ½ mi)' },
  { minutes: 15, label: '15 min walk (≈ ¾ mi)' },
];

/** Picker options: Auto (the default) above the fixed walk-times. */
export const WALK_MODE_OPTIONS: { value: WalkMode; label: string }[] = [
  { value: 'auto', label: 'Auto (by frequency)' },
  ...WALK_MINUTE_OPTIONS.map((o) => ({ value: o.minutes as WalkMode, label: o.label })),
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

/** A fixed walk-time for every stop, or a per-stop resolver (Auto mode). */
export type MinutesResolver = number | ((stop: Stop) => number);

function resolveMinutes(resolver: MinutesResolver, stop: Stop): number {
  return typeof resolver === 'function' ? resolver(stop) : resolver;
}

/**
 * Build a unioned street-network walkshed for a set of stops.
 *
 * - `minutes` may be a single walk-time applied to every stop, or a resolver
 *   `(stop) => minutes` so Auto mode can size each stop's isochrone by its own
 *   service frequency (frequent → 10 min, else 5 min). One isochrone request is
 *   issued per distinct (rounded-coordinate, walk-time) pair — the same cache
 *   key the session cache already uses — so two stops at one location asking for
 *   different walk-times each get their own (correct) isochrone.
 * - Caps the number of API calls; returns status 'capped' (no truncation) when
 *   a feed needs more than MAX_ISOCHRONE_REQUESTS distinct isochrones.
 * - Returns status 'error' (with the polygon null) if any request fails, so the
 *   caller can fall back to the straight-line buffer with a notice.
 */
export async function buildNetworkWalkshed(
  stops: Stop[],
  minutes: MinutesResolver,
): Promise<NetworkWalkshedResult> {
  // Distinct (rounded coordinate, walk-time) pairs — Auto can ask for different
  // walk-times at the same location, so the walk-time is part of the dedupe key.
  const distinct = new Map<string, { lon: number; lat: number; minutes: number }>();
  for (const s of stops) {
    const m = resolveMinutes(minutes, s);
    const k = cacheKey(s.stop_lon, s.stop_lat, m);
    if (!distinct.has(k)) distinct.set(k, { lon: s.stop_lon, lat: s.stop_lat, minutes: m });
  }
  const coords = [...distinct.values()];

  if (coords.length === 0) {
    return { status: 'empty', polygon: null, requestCount: 0, neededRequests: 0 };
  }

  // Count how many of those actually need a (non-cached) request.
  const uncached = coords.filter(
    (c) => !isochroneCache.has(cacheKey(c.lon, c.lat, c.minutes)),
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
      const wasCached = isochroneCache.has(cacheKey(c.lon, c.lat, c.minutes));
      const iso = await fetchIsochrone(c.lon, c.lat, c.minutes);
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
  minutes: MinutesResolver,
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
