/**
 * Travel-time estimation for a trip's stops.
 *
 * Asks the Mapbox Directions API for the real road driving time between each
 * pair of CONSECUTIVE stops, in sequence order, and accumulates those per-leg
 * durations into cumulative seconds at each stop. `layoutStopTimes` then turns
 * those into arrival/departure times (plus a per-stop dwell and a bus-vs-car
 * speed factor, since Mapbox's `driving` profile is car free-flow).
 *
 * This is deliberately NOT shape-based: the previous implementation matched the
 * drawn shape and projected each stop onto it, which collapsed to zero travel
 * time whenever the stop SEQUENCE didn't follow the shape's path (e.g. an
 * airport→Walmart hop that the drawn line skips). Driving directly between the
 * stops in order gives the true stop-to-stop time regardless of the shape.
 *
 * See docs/REQUIREMENTS — "Estimate travel times".
 */
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// Mapbox Directions accepts at most 25 coordinates per request. We chunk longer
// stop lists into windows of up to 25 stops that OVERLAP by one stop, so each
// chunk boundary is shared: the leg out of a boundary stop belongs to the next
// chunk, and the legs stitch end-to-end with no gap or double-count.
const MAX_WAYPOINTS = 25;

export type LngLat = [number, number];

/**
 * Per-leg driving durations (seconds) for one chunk of ≤25 stops, in order:
 * `out[i]` = drive time from `chunk[i]` to `chunk[i+1]` (length = chunk.length-1).
 * Returns null on any fetch/HTTP/parse failure so the caller can fall back.
 */
async function fetchLegDurations(chunk: LngLat[]): Promise<number[] | null> {
  if (chunk.length < 2) return [];
  const coordString = chunk.map((c) => `${c[0]},${c[1]}`).join(';');
  // overview=false&steps=false keeps the response tiny; each leg between a pair
  // of waypoints carries its own `.duration`, which is exactly the per-leg time.
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordString}`
    + `?access_token=${MAPBOX_TOKEN}&overview=false&steps=false&annotations=duration`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data: { code?: string; routes?: { legs?: { duration?: number }[] }[] };
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data.code !== 'Ok' || !data.routes?.length) return null;
  const legs = data.routes[0].legs;
  // One leg per consecutive pair; bail if the shape of the response is off.
  if (!Array.isArray(legs) || legs.length !== chunk.length - 1) return null;
  const durations = legs.map((l) => l.duration);
  if (durations.some((d) => typeof d !== 'number' || !Number.isFinite(d))) return null;
  return durations as number[];
}

/**
 * Cumulative road driving seconds (car free-flow) at each stop, measured by
 * driving between CONSECUTIVE stops in sequence order. `cum[0]` is 0 and
 * `cum[i] = cum[i-1] + (drive time from stop i-1 to stop i)`, so the result is
 * non-decreasing only insofar as each leg duration is non-negative (it always
 * is). `stopCoords` must already be in route/stop_sequence order.
 *
 * Returns zeros for fewer than 2 stops, and null if any Directions request
 * fails (the caller surfaces the "couldn't match…" error and the user fills in
 * times manually).
 */
export async function estimateStopTravelByRoad(
  stopCoords: LngLat[],
): Promise<number[] | null> {
  if (stopCoords.length < 2) return stopCoords.map(() => 0);

  // Walk overlapping windows of ≤25 stops. Each window advances by
  // MAX_WAYPOINTS-1 stops so consecutive windows share their boundary stop; the
  // legs each window contributes never overlap (the boundary stop's outgoing
  // leg lives in the later window). Concatenated, they cover every consecutive
  // pair exactly once.
  const legDurations: number[] = [];
  for (let start = 0; start < stopCoords.length - 1; start += MAX_WAYPOINTS - 1) {
    const end = Math.min(start + MAX_WAYPOINTS, stopCoords.length); // exclusive
    const chunk = stopCoords.slice(start, end);
    const chunkLegs = await fetchLegDurations(chunk);
    if (!chunkLegs) return null;
    legDurations.push(...chunkLegs);
  }
  // legDurations now has exactly stopCoords.length - 1 entries.
  const cum: number[] = [0];
  for (const d of legDurations) cum.push(cum[cum.length - 1] + d);
  return cum;
}

export interface StopTiming { arrivalSec: number; departureSec: number; }

/**
 * Turn cumulative travel seconds into arrival/departure times. The first stop
 * departs at `startSec`; intermediate stops add `dwellSec`; the last stop gets
 * no dwell. `speedFactor` (>1) slows the car-based travel toward bus speeds.
 */
export function layoutStopTimes(
  cumTravelSec: number[],
  opts: { startSec: number; dwellSec: number; speedFactor: number },
): StopTiming[] {
  const out: StopTiming[] = [];
  for (let i = 0; i < cumTravelSec.length; i++) {
    if (i === 0) {
      out.push({ arrivalSec: opts.startSec, departureSec: opts.startSec });
      continue;
    }
    // Absolute difference so stops sequenced opposite the shape's drawn
    // direction (cumulative running high→low) still yield real travel times
    // rather than collapsing to zero.
    const seg = Math.abs(cumTravelSec[i] - cumTravelSec[i - 1]) * opts.speedFactor;
    const arrival = Math.round(out[i - 1].departureSec + seg);
    const isLast = i === cumTravelSec.length - 1;
    out.push({ arrivalSec: arrival, departureSec: isLast ? arrival : arrival + opts.dwellSec });
  }
  return out;
}
