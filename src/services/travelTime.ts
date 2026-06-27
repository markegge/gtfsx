/**
 * Travel-time estimation for drawn routes.
 *
 * Uses the same Mapbox Map Matching API that powers snap-to-road, but asks for
 * duration annotations so we get the road-network travel time along the path
 * the user drew. Each stop is projected onto the matched path; the cumulative
 * driving time at each stop gives stop-to-stop travel times, which `layoutStopTimes`
 * turns into arrival/departure times (plus a per-stop dwell and a bus-vs-car
 * speed factor, since Mapbox's `driving` profile is car free-flow).
 *
 * See docs/REQUIREMENTS — "Estimate travel times" — and snapToRoad.ts.
 */
import distance from '@turf/distance';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
// Map Matching allows 100 coords/request. Downsample below that (keeping first
// + last) so the whole shape fits one call — fidelity is plenty for timing.
const MAX_MATCH_COORDS = 95;

export type LngLat = [number, number];

function downsample(coords: LngLat[], max: number): LngLat[] {
  if (coords.length <= max) return coords;
  const step = (coords.length - 1) / (max - 1);
  const out: LngLat[] = [];
  for (let i = 0; i < max; i++) out.push(coords[Math.round(i * step)]);
  out[out.length - 1] = coords[coords.length - 1];
  return out;
}

interface MatchResult {
  coords: LngLat[];
  durations: number[]; // seconds, one per segment of `coords`
}

async function matchWithDurations(coords: LngLat[]): Promise<MatchResult | null> {
  const input = downsample(coords, MAX_MATCH_COORDS);
  if (input.length < 2) return null;
  const coordString = input.map((c) => `${c[0]},${c[1]}`).join(';');
  const url = `https://api.mapbox.com/matching/v5/mapbox/driving/${coordString}`
    + `?access_token=${MAPBOX_TOKEN}&geometries=geojson&overview=full&annotations=duration`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.code !== 'Ok' || !data.matchings?.length) return null;
  const m = data.matchings[0];
  const matchedCoords = (m.geometry?.coordinates ?? []) as LngLat[];
  // No explicit waypoints → one leg covering the whole match; concat per-segment durations.
  const durations: number[] = (m.legs ?? []).flatMap(
    (l: { annotation?: { duration?: number[] } }) => l.annotation?.duration ?? [],
  );
  if (matchedCoords.length < 2 || durations.length < 1) return null;
  return { coords: matchedCoords, durations };
}

/**
 * Cumulative driving seconds (car free-flow) from the first stop to each stop,
 * measured along the matched road path. `stopCoords` must be in route order.
 * Returns null if the path can't be matched (caller can fall back).
 */
export async function estimateStopTravelSeconds(
  shapeCoords: LngLat[],
  stopCoords: LngLat[],
): Promise<number[] | null> {
  if (shapeCoords.length < 2 || stopCoords.length === 0) return null;
  const matched = await matchWithDurations(shapeCoords);
  if (!matched) return null;
  return cumulativeTravelAtStops(matched.coords, matched.durations, stopCoords);
}

/**
 * Fraction (0..1) of the closest point on segment a→b to point p, using a
 * local equirectangular projection around `a`. Clamped to the segment.
 */
function projectFraction(a: LngLat, b: LngLat, p: LngLat): number {
  const kx = Math.cos((a[1] * Math.PI) / 180); // longitude-degree scale at this latitude
  const ax = a[0] * kx, ay = a[1];
  const dx = b[0] * kx - ax, dy = b[1] - ay;
  const segSq = dx * dx + dy * dy;
  if (segSq === 0) return 0;
  const t = ((p[0] * kx - ax) * dx + (p[1] - ay) * dy) / segSq;
  return Math.min(1, Math.max(0, t));
}

function lerp(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Cumulative driving seconds at a given along-line location (km). */
function durationAtLocation(
  loc: number,
  cumDist: number[],
  cumDur: number[],
  durations: number[],
): number {
  const lastV = cumDist.length - 1;
  if (lastV < 1 || loc <= 0) return cumDur[0] ?? 0;
  if (loc >= cumDist[lastV]) return cumDur[Math.min(cumDur.length - 1, lastV)] ?? 0;
  let idx = 0;
  for (let i = 0; i < lastV; i++) {
    if (loc >= cumDist[i] && loc <= cumDist[i + 1]) { idx = i; break; }
  }
  if (idx >= durations.length) idx = Math.max(0, durations.length - 1);
  const segStart = cumDist[idx] ?? 0;
  const segEnd = cumDist[idx + 1] ?? segStart;
  const frac = segEnd > segStart ? Math.min(1, Math.max(0, (loc - segStart) / (segEnd - segStart))) : 0;
  return (cumDur[idx] ?? 0) + frac * (durations[idx] ?? 0);
}

/**
 * Pure projection step (exported for testing): given a matched path, its
 * per-segment durations, and the stops *in input/sequence order*, returns
 * cumulative seconds at each stop.
 *
 * Projection honors sequence order: each stop is matched to the nearest point
 * on the line *at or after* the previous stop's along-line location (a running
 * "min location" that only advances). So a stop physically near the shape's
 * start but placed late in the sequence resolves to a LATER along-line position
 * (a late time) rather than an early one, an out-and-back shape resolves a
 * midpoint stop to the correct pass, and the returned cumulative seconds are
 * NON-DECREASING in input order. (The old code projected each stop onto the
 * GLOBAL nearest point independently, which ignored sequence order.)
 */
export function cumulativeTravelAtStops(
  coords: LngLat[],
  durations: number[],
  stopCoords: LngLat[],
): number[] {
  if (coords.length < 2) return stopCoords.map(() => 0);

  // Cumulative distance (km) and duration (s) at each matched vertex.
  const cumDist: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(cumDist[i - 1] + distance(coords[i - 1], coords[i], { units: 'kilometers' }));
  }
  const cumDur: number[] = [0];
  for (let i = 0; i < durations.length; i++) cumDur.push(cumDur[i] + durations[i]);
  const totalLen = cumDist[cumDist.length - 1];

  let minLoc = 0; // km along the line; only advances forward across stops
  return stopCoords.map((sc) => {
    let bestDist = Infinity;
    let bestLoc = minLoc; // default if nothing qualifies: clamp to running min
    let found = false;
    for (let i = 0; i < coords.length - 1; i++) {
      const segStartLoc = cumDist[i];
      const segEndLoc = cumDist[i + 1];
      if (segEndLoc <= minLoc) continue; // segment is entirely before the running min
      const segLen = segEndLoc - segStartLoc;
      let t = projectFraction(coords[i], coords[i + 1], sc);
      let loc = segStartLoc + t * segLen;
      if (loc < minLoc) {
        // Closest point on this segment falls before the running min → clamp to
        // the start of this segment's still-qualifying portion.
        loc = minLoc;
        t = segLen > 0 ? (minLoc - segStartLoc) / segLen : 0;
      }
      const d = distance(sc, lerp(coords[i], coords[i + 1], t), { units: 'kilometers' });
      if (d < bestDist) {
        bestDist = d;
        bestLoc = loc;
        found = true;
      }
    }
    if (!found) bestLoc = Math.max(minLoc, totalLen); // only the line's end qualifies
    minLoc = bestLoc; // advance the running min so later stops can't go backward
    return durationAtLocation(bestLoc, cumDist, cumDur, durations);
  });
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
