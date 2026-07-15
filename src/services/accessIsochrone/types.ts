// Transit Access Isochrones (#40) — shared type contract.
//
// "From a given origin, what can a rider reach on the network in N minutes?"
// The analysis combines a walking ACCESS leg (origin → boardable stops), a
// schedule-based TRANSIT leg (RAPTOR over the in-memory GTFS feed), and a
// walking EGRESS leg (reached stop → final reachable area), then apportions
// ACS opportunities (population / jobs / equity) inside each time-budget ring.
//
// This module holds only types. The RAPTOR engine lives in ./raptor.ts and the
// end-to-end orchestrator in ./orchestrator.ts.

import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { Stop } from '../../types/gtfs';
import type { CoverageResult } from '../coverageAnalysis';
import type { WalkMinutes } from '../networkWalkshed';

export type LngLat = { lon: number; lat: number };

/** Seconds since midnight. GTFS clock times can exceed 86400 (past-midnight
 *  trips), so this is not bounded to a day. */
export type SecondsOfDay = number;

// ───────────────────────── Analysis (public) ─────────────────────────

export interface AccessIsochroneParams {
  origin: LngLat;
  /** Ascending minutes thresholds — one filled contour ring each, e.g. [15,30,45]. */
  budgetsMin: number[];
  /** Departure clock time, seconds since midnight (e.g. 8:00 AM = 28800). */
  departureSec: number;
  /** Calendar service_ids active on the chosen service day (from
   *  representativeDay(feed) or a day picker). */
  serviceIds: string[];
  /** Walk-time budget for both the access (origin→stop) and egress
   *  (stop→destination) legs. */
  walkMinutes: WalkMinutes;
  /** Use straight-line walk circles instead of Mapbox isochrones (no API calls).
   *  Default true for the access leg; egress honours this too. */
  straightLineWalk?: boolean;
  /** Max RAPTOR rounds (transfers + 1). Default 4. */
  maxRounds?: number;
}

export interface AccessRing {
  budgetMin: number;
  /** Unioned reachable-area polygon for this budget (egress walk around every
   *  stop transit-reached within the budget). null when empty/error. */
  polygon: Feature<Polygon | MultiPolygon> | null;
  /** Opportunities within the polygon — population, workers/jobs, equity shares.
   *  null when there is no polygon or no ACS data loaded. */
  coverage: CoverageResult | null;
  /** Stop ids transit-reachable within this budget. */
  reachedStopIds: string[];
}

export type AccessStatus = 'ok' | 'empty' | 'error' | 'capped';

export interface AccessIsochroneResult {
  status: AccessStatus;
  origin: LngLat;
  /** One per requested budget, ascending. */
  rings: AccessRing[];
  /** Stops boardable on foot from the origin (the access leg). */
  boardableStopIds: string[];
  /** Distinct stops transit-reached within the largest budget. */
  reachedStopCount: number;
  /** Mapbox isochrone requests spent (0 in straight-line mode). */
  isochroneRequests: number;
  /** Human-readable detail for the UI notice (set on capped/error/empty). */
  message?: string;
}

// ───────────────────────── RAPTOR core (./raptor.ts) ─────────────────────────

/** A boardable stop reachable on foot from the origin, with the clock time the
 *  rider arrives at it (departure + access walk). RAPTOR seeds these. */
export interface RaptorSource {
  stopId: string;
  arrivalSec: SecondsOfDay;
}

export interface RaptorOptions {
  /** Max rounds (transfers + 1). Default 4. */
  maxRounds?: number;
  /** Minimum transfer time added when boarding after alighting, seconds. Default 0. */
  minTransferSec?: number;
  /** Prune labels later than this arrival time (seconds of day). Optional. */
  cutoffSec?: SecondsOfDay;
}

/** The minimal feed shape RAPTOR needs. The orchestrator passes the store's
 *  arrays (which structurally satisfy this). */
export interface RaptorFeedInput {
  stops: Pick<Stop, 'stop_id' | 'stop_lat' | 'stop_lon' | 'parent_station'>[];
  trips: { trip_id: string; route_id: string; service_id: string }[];
  stopTimes: {
    trip_id: string;
    stop_id: string;
    stop_sequence: number;
    arrival_time: string;
    departure_time: string;
  }[];
  frequencies?: { trip_id: string; start_time: string; end_time: string; headway_secs: number }[];
}

/** Opaque, preprocessed routing index. raptor.ts returns a richer object that
 *  structurally satisfies this; callers only read stopIds. */
export interface RaptorIndex {
  readonly stopIds: readonly string[];
}
