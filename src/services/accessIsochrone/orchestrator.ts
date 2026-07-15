// Access-isochrone orchestrator: access (walk) → RAPTOR (transit) → egress
// (walk union) → ACS opportunity apportionment. Replaces the stub; the
// exported signature of runAccessIsochrone is identical to the stub.

import union from '@turf/union';
import buffer from '@turf/buffer';
import { point, featureCollection } from '@turf/helpers';
import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { Stop } from '../../types/gtfs';
import type { BlockGroupData } from '../demographics';
import { walkshedForStops, coverageFromWalkshed } from '../networkWalkshed';
import type {
  AccessIsochroneParams,
  AccessIsochroneResult,
  AccessRing,
  LngLat,
  RaptorFeedInput,
  RaptorSource,
} from './types';
import { buildRaptorIndex, runRaptor } from './raptor';

/** The feed slice the analysis needs (RAPTOR input fields). */
export type AccessFeedInput = RaptorFeedInput;

// ──────────────────────────── Constants ───────────────────────────────────────

/** Walking speed assumed for both access and egress legs (80 m/min ≈ 1.33 m/s). */
const WALK_SPEED_M_PER_MIN = 80;

// ─────────────────────────── Private helpers ──────────────────────────────────

type WalkshedPolygon = Feature<Polygon | MultiPolygon>;

/**
 * Haversine distance in metres between an origin point and a feed stop.
 * Accurate to <0.1% for distances under 1000 km.
 */
function haversineMeters(
  origin: LngLat,
  stop: { stop_lat: number; stop_lon: number },
): number {
  const R = 6_371_000; // Earth mean radius in metres
  const lat1 = (origin.lat * Math.PI) / 180;
  const lat2 = (stop.stop_lat * Math.PI) / 180;
  const dLat = ((stop.stop_lat - origin.lat) * Math.PI) / 180;
  const dLon = ((stop.stop_lon - origin.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Union straight-line walk circles (using @turf/buffer to approximate circles)
 * around a set of stop coordinates. Returns null when `coords` is empty or
 * every buffer call fails.
 */
function straightLinePolygon(
  coords: ReadonlyArray<{ lat: number; lon: number }>,
  radiusMeters: number,
): WalkshedPolygon | null {
  const radiusKm = radiusMeters / 1000;
  let poly: WalkshedPolygon | null = null;
  for (const { lat, lon } of coords) {
    const circle = buffer(point([lon, lat]), radiusKm, { units: 'kilometers' });
    if (!circle) continue;
    const circleFeat = circle as WalkshedPolygon;
    if (poly === null) {
      poly = circleFeat;
    } else {
      try {
        const merged = union(featureCollection([poly, circleFeat]));
        if (merged) poly = merged as WalkshedPolygon;
      } catch {
        // keep existing poly if turf fails to merge
      }
    }
  }
  return poly;
}

// ──────────────────────────── Public API ──────────────────────────────────────

/**
 * Run the full access-isochrone analysis for one origin + parameter set.
 *
 * Pipeline:
 *   1. ACCESS  — straight-line walk from origin; seed RAPTOR with boardable stops.
 *   2. TRANSIT — RAPTOR earliest-arrival over active trips.
 *   3. EGRESS  — for each budget ring, union walk circles around reached stops.
 *   4. COVERAGE— apportion ACS demographics inside each polygon (when blockGroups
 *                provided and polygon is non-null).
 *
 * Never throws — errors are caught and returned as status 'error'.
 */
export async function runAccessIsochrone(
  params: AccessIsochroneParams,
  feed: AccessFeedInput,
  blockGroups: BlockGroupData[],
): Promise<AccessIsochroneResult> {
  try {
    const straightLine = params.straightLineWalk !== false; // default true
    const sortedBudgets = [...params.budgetsMin].sort((a, b) => a - b);
    const maxBudgetSec = Math.max(...sortedBudgets) * 60;
    const walkRadiusM = params.walkMinutes * WALK_SPEED_M_PER_MIN;

    // Coordinate lookup: stop_id → {lat, lon}
    const stopCoordById = new Map(
      feed.stops.map((s) => [s.stop_id, { lat: s.stop_lat, lon: s.stop_lon }]),
    );

    // ─── 1. ACCESS LEG ────────────────────────────────────────────────────────
    // A stop is boardable if straight-line distance from origin ≤ walkRadius.
    const sources: RaptorSource[] = [];
    const boardableStopIds: string[] = [];

    for (const stop of feed.stops) {
      const distM = haversineMeters(params.origin, stop);
      if (distM <= walkRadiusM) {
        const walkSec = (distM / WALK_SPEED_M_PER_MIN) * 60; // seconds of walk
        sources.push({ stopId: stop.stop_id, arrivalSec: params.departureSec + walkSec });
        boardableStopIds.push(stop.stop_id);
      }
    }

    // ─── 2. TRANSIT (RAPTOR) ─────────────────────────────────────────────────
    const idx = buildRaptorIndex(feed, new Set(params.serviceIds));
    const arrivals = runRaptor(idx, sources, {
      maxRounds: params.maxRounds ?? 4,
      cutoffSec: params.departureSec + maxBudgetSec,
    });

    // ─── 3. RINGS ────────────────────────────────────────────────────────────
    // Straight-line mode makes no Mapbox isochrone calls; network mode reuses the
    // walkshed session cache, which doesn't surface a per-call count here.
    const isochroneRequests = 0;
    const rings: AccessRing[] = [];

    for (const budgetMin of sortedBudgets) {
      const budgetCutoff = params.departureSec + budgetMin * 60;
      const reachedStopIds: string[] = [];

      for (const [stopId, arrSec] of arrivals) {
        if (arrSec <= budgetCutoff) reachedStopIds.push(stopId);
      }

      let polygon: WalkshedPolygon | null = null;

      if (reachedStopIds.length > 0) {
        if (straightLine) {
          // Straight-line mode: buffer each reached stop and union the circles.
          const coords = reachedStopIds
            .map((id) => stopCoordById.get(id))
            .filter((c): c is { lat: number; lon: number } => c !== undefined);
          polygon = straightLinePolygon(coords, walkRadiusM);
        } else {
          // Network mode: Mapbox isochrone walkshed (paid tier).
          // feed.stops is Pick<Stop, ...> but walkshedForStops only uses lat/lon/id.
          const stopList = reachedStopIds
            .map((id) => feed.stops.find((s) => s.stop_id === id))
            .filter((s): s is (typeof feed.stops)[0] => s !== undefined);
          const wsResult = await walkshedForStops(
            stopList as unknown as Stop[],
            params.walkMinutes,
          );
          polygon = wsResult;
          // isochroneRequests: walkshedForStops re-uses session cache; the count
          // isn't directly returned here. Approximation: 0 for capped/error paths.
        }
      }

      const coverage =
        polygon !== null && blockGroups.length > 0
          ? coverageFromWalkshed(polygon, blockGroups, 0.25)
          : null;

      rings.push({ budgetMin, polygon, coverage, reachedStopIds });
    }

    // ─── 4. RESULT ───────────────────────────────────────────────────────────
    const allReached = new Set<string>();
    for (const ring of rings) {
      for (const id of ring.reachedStopIds) allReached.add(id);
    }

    if (boardableStopIds.length === 0) {
      return {
        status: 'empty',
        origin: params.origin,
        rings,
        boardableStopIds,
        reachedStopCount: 0,
        isochroneRequests,
        message: 'No transit stops within walking distance of the origin.',
      };
    }

    if (allReached.size === 0) {
      return {
        status: 'empty',
        origin: params.origin,
        rings,
        boardableStopIds,
        reachedStopCount: 0,
        isochroneRequests,
        message: 'No stops reachable via transit within the time budget.',
      };
    }

    return {
      status: 'ok',
      origin: params.origin,
      rings,
      boardableStopIds,
      reachedStopCount: allReached.size,
      isochroneRequests,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown error in access-isochrone analysis.';
    return {
      status: 'error',
      origin: params.origin,
      rings: [...params.budgetsMin]
        .sort((a, b) => a - b)
        .map((budgetMin) => ({ budgetMin, polygon: null, coverage: null, reachedStopIds: [] })),
      boardableStopIds: [],
      reachedStopCount: 0,
      isochroneRequests: 0,
      message,
    };
  }
}
