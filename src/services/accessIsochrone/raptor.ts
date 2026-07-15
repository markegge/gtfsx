// RAPTOR (Round-Based Public Transit Routing) — earliest-arrival labels over an
// in-memory GTFS feed. Replaces the stub; signatures are compatible with ./types.ts.

import type { RaptorFeedInput, RaptorIndex, RaptorOptions, RaptorSource, SecondsOfDay } from './types';
import { gtfsTimeToSeconds } from '../../utils/time';

// ─────────────────────────────── Internal types ───────────────────────────────

interface PatternTrip {
  arrivals: number[];   // arrival seconds at each stop position in the pattern
  departures: number[]; // departure seconds at each stop position in the pattern
}

interface RaptorPattern {
  stopIds: string[];    // ordered stop ids (defines the pattern)
  trips: PatternTrip[]; // instances of this pattern, sorted by departure at stop 0
}

/**
 * Extended routing index returned by buildRaptorIndex. The public contract
 * (RaptorIndex) only exposes stopIds; runRaptor casts back to this for the
 * internal fields. Extra fields are allowed by the RaptorIndex contract.
 */
interface InternalRaptorIndex {
  readonly stopIds: readonly string[];
  readonly patterns: readonly RaptorPattern[];
  /** stop_id → every (patternIdx, stopIdx) where this stop appears */
  readonly stopToPatterns: ReadonlyMap<
    string,
    ReadonlyArray<{ patternIdx: number; stopIdx: number }>
  >;
}

// ───────────────────────── buildRaptorIndex ───────────────────────────────────

/**
 * Preprocess a GTFS feed slice into an immutable RAPTOR routing index for the
 * set of service_ids active on the chosen day.
 *
 * Steps:
 *   1. Filter trips to active service_ids.
 *   2. Group stop_times per trip, sorted by stop_sequence.
 *   3. Expand frequency-based trips into synthetic instances (one per headway
 *      step within [start_time, end_time)), each shifted from the template.
 *   4. Group all instances into route *patterns* (same ordered stop-id sequence
 *      = one RAPTOR pattern); sort each pattern's trips by departure at stop 0.
 *   5. Build an inverted stop → patterns index for O(1) route look-up.
 */
export function buildRaptorIndex(feed: RaptorFeedInput, serviceIds: Set<string>): RaptorIndex {
  // 1. Active trip ids
  const activeTripIds = new Set<string>();
  for (const t of feed.trips) {
    if (serviceIds.has(t.service_id)) activeTripIds.add(t.trip_id);
  }

  // 2. Collect stop_times per active trip, sorted by stop_sequence
  type RawSt = (typeof feed.stopTimes)[0];
  const stopTimesByTrip = new Map<string, RawSt[]>();
  for (const st of feed.stopTimes) {
    if (!activeTripIds.has(st.trip_id)) continue;
    let arr = stopTimesByTrip.get(st.trip_id);
    if (!arr) { arr = []; stopTimesByTrip.set(st.trip_id, arr); }
    arr.push(st);
  }
  for (const arr of stopTimesByTrip.values()) {
    arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  }

  // 3. Collect frequency windows per active trip
  type RawFreq = NonNullable<(typeof feed.frequencies)>[0];
  const freqByTrip = new Map<string, RawFreq[]>();
  for (const f of feed.frequencies ?? []) {
    if (!activeTripIds.has(f.trip_id) || f.headway_secs <= 0) continue;
    let arr = freqByTrip.get(f.trip_id);
    if (!arr) { arr = []; freqByTrip.set(f.trip_id, arr); }
    arr.push(f);
  }

  // 4. Build expanded trip instances
  interface TripInstance {
    stopIds: string[];
    arrivals: number[];
    departures: number[];
  }
  const instances: TripInstance[] = [];

  for (const [tripId, sts] of stopTimesByTrip) {
    const stopIds = sts.map((st) => st.stop_id);
    // Prefer arrival_time for arrival, departure_time for departure; fall back to the other.
    const baseArr = sts.map((st) =>
      gtfsTimeToSeconds(st.arrival_time || st.departure_time),
    );
    const baseDep = sts.map((st) =>
      gtfsTimeToSeconds(st.departure_time || st.arrival_time),
    );

    const freqs = freqByTrip.get(tripId);
    if (freqs && freqs.length > 0) {
      // Frequency-based: generate one instance per headway step in each window.
      const templateFirstDep = baseDep[0] ?? 0;
      for (const freq of freqs) {
        const startSec = gtfsTimeToSeconds(freq.start_time);
        const endSec = gtfsTimeToSeconds(freq.end_time);
        for (let firstDep = startSec; firstDep < endSec; firstDep += freq.headway_secs) {
          const offset = firstDep - templateFirstDep;
          instances.push({
            stopIds,
            arrivals: baseArr.map((t) => t + offset),
            departures: baseDep.map((t) => t + offset),
          });
        }
      }
    } else {
      // Regular (non-frequency) trip.
      instances.push({ stopIds, arrivals: baseArr, departures: baseDep });
    }
  }

  // 5. Group instances into patterns by their stop-id sequence
  const patternKeyToIdx = new Map<string, number>();
  const patterns: RaptorPattern[] = [];

  for (const inst of instances) {
    // Use NUL separator — stop_ids won't contain NUL.
    const key = inst.stopIds.join('\0');
    let pIdx = patternKeyToIdx.get(key);
    if (pIdx === undefined) {
      pIdx = patterns.length;
      patternKeyToIdx.set(key, pIdx);
      patterns.push({ stopIds: inst.stopIds, trips: [] });
    }
    patterns[pIdx].trips.push({ arrivals: inst.arrivals, departures: inst.departures });
  }

  // Sort each pattern's trips by departure time at the first stop.
  for (const p of patterns) {
    p.trips.sort((a, b) => a.departures[0] - b.departures[0]);
  }

  // 6. Build inverted index: stop_id → [(patternIdx, stopIdx)]
  const stopToPatterns = new Map<string, Array<{ patternIdx: number; stopIdx: number }>>();
  for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
    const { stopIds } = patterns[pIdx];
    for (let sIdx = 0; sIdx < stopIds.length; sIdx++) {
      const sid = stopIds[sIdx];
      let arr = stopToPatterns.get(sid);
      if (!arr) { arr = []; stopToPatterns.set(sid, arr); }
      arr.push({ patternIdx: pIdx, stopIdx: sIdx });
    }
  }

  const idx: InternalRaptorIndex = {
    stopIds: [...stopToPatterns.keys()],
    patterns,
    stopToPatterns,
  };
  // Cast through unknown: InternalRaptorIndex is structurally a superset of
  // RaptorIndex (it adds internal-only fields), which is explicitly allowed
  // by the contract comment in types.ts.
  return idx as unknown as RaptorIndex;
}

// ───────────────────────────── runRaptor ──────────────────────────────────────

/**
 * Standard RAPTOR earliest-arrival algorithm.
 *
 * Each round extends the journey by one transit leg (one more boarding). Up to
 * `maxRounds` rounds are run, giving maxRounds transit legs / (maxRounds − 1)
 * transfers. To prevent same-round chaining (using arrivals set within the
 * current round to board another trip), boarding decisions are made against a
 * snapshot of τ taken at the start of each round.
 */
export function runRaptor(
  index: RaptorIndex,
  sources: RaptorSource[],
  opts?: RaptorOptions,
): Map<string, SecondsOfDay> {
  const internal = index as unknown as InternalRaptorIndex;
  const { patterns, stopToPatterns } = internal;

  const maxRounds = opts?.maxRounds ?? 4;
  const minTransferSec = opts?.minTransferSec ?? 0;
  const cutoffSec = opts?.cutoffSec ?? Infinity;

  // τ[stopId] = best (earliest) known arrival time across all rounds so far.
  const tau = new Map<string, number>();

  // Seed from walking-access sources.
  let marked = new Set<string>();
  for (const src of sources) {
    if (src.arrivalSec > cutoffSec) continue;
    const cur = tau.get(src.stopId);
    if (cur === undefined || src.arrivalSec < cur) {
      tau.set(src.stopId, src.arrivalSec);
      marked.add(src.stopId);
    }
  }

  for (let round = 0; round < maxRounds && marked.size > 0; round++) {
    // Snapshot τ at the start of this round. Boarding decisions use tauPrev to
    // prevent chaining two legs in the same round.
    const tauPrev = new Map<string, number>(tau);
    const newMarked = new Set<string>();

    // Collect route patterns that touch any marked stop. For each such pattern,
    // track the earliest stop index where we may begin scanning.
    const routeBoarding = new Map<number, number>(); // patternIdx → earliest stopIdx
    for (const stopId of marked) {
      for (const { patternIdx, stopIdx } of stopToPatterns.get(stopId) ?? []) {
        const cur = routeBoarding.get(patternIdx);
        if (cur === undefined || stopIdx < cur) routeBoarding.set(patternIdx, stopIdx);
      }
    }

    // Scan each route from its earliest boarding stop.
    for (const [pIdx, startStopIdx] of routeBoarding) {
      const pattern = patterns[pIdx];
      let currentTrip: PatternTrip | null = null;

      for (let sIdx = startStopIdx; sIdx < pattern.stopIds.length; sIdx++) {
        const stopId = pattern.stopIds[sIdx];

        // Propagate: relax τ[stop] using the current trip's arrival.
        if (currentTrip !== null) {
          const arrival = currentTrip.arrivals[sIdx];
          if (arrival <= cutoffSec) {
            const curBest = tau.get(stopId) ?? Infinity;
            if (arrival < curBest) {
              tau.set(stopId, arrival);
              newMarked.add(stopId);
            }
          }
        }

        // Board / upgrade: can we catch an earlier-departing trip at this stop?
        const tauHere = tauPrev.get(stopId);
        if (tauHere !== undefined) {
          const boardTime = tauHere + minTransferSec;
          const candidate = findEarliestTrip(pattern.trips, sIdx, boardTime);
          if (candidate !== null) {
            // Only upgrade if this trip departs earlier at sIdx than our current trip.
            if (
              currentTrip === null ||
              candidate.departures[sIdx] < currentTrip.departures[sIdx]
            ) {
              currentTrip = candidate;
            }
          }
        }
      }
    }

    marked = newMarked;
  }

  // Return only reachable stops (finite arrival ≤ cutoffSec).
  const result = new Map<string, SecondsOfDay>();
  for (const [stopId, t] of tau) {
    if (t <= cutoffSec) result.set(stopId, t);
  }
  return result;
}

// ──────────────────────────── helpers ────────────────────────────────────────

/**
 * Find the earliest trip in `trips` where departure at `stopIdx` ≥ boardTime.
 * Linear scan — correct for any departure ordering; fast enough for real feeds
 * (patterns typically have < 200 trips and this is O(n) per stop per round).
 */
function findEarliestTrip(
  trips: PatternTrip[],
  stopIdx: number,
  boardTime: number,
): PatternTrip | null {
  let best: PatternTrip | null = null;
  let bestDep = Infinity;
  for (const trip of trips) {
    const dep = trip.departures[stopIdx];
    if (dep >= boardTime && dep < bestDep) {
      best = trip;
      bestDep = dep;
    }
  }
  return best;
}
