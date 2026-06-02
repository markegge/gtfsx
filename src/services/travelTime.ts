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
import nearestPointOnLine from '@turf/nearest-point-on-line';
import distance from '@turf/distance';
import { lineString, point } from '@turf/helpers';

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
 * Pure projection step (exported for testing): given a matched path, its
 * per-segment durations, and the stops, returns cumulative seconds at each stop.
 */
export function cumulativeTravelAtStops(
  coords: LngLat[],
  durations: number[],
  stopCoords: LngLat[],
): number[] {
  // Cumulative distance (km) and duration (s) at each matched vertex.
  const cumDist: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cumDist.push(cumDist[i - 1] + distance(coords[i - 1], coords[i], { units: 'kilometers' }));
  }
  const cumDur: number[] = [0];
  for (let i = 0; i < durations.length; i++) cumDur.push(cumDur[i] + durations[i]);

  const line = lineString(coords);
  return stopCoords.map((sc) => {
    const npl = nearestPointOnLine(line, point(sc), { units: 'kilometers' });
    const loc = npl.properties.location ?? 0; // km along the line
    let idx = npl.properties.index ?? 0;       // segment index
    if (idx >= durations.length) idx = Math.max(0, durations.length - 1);
    const segStart = cumDist[idx] ?? 0;
    const segEnd = cumDist[idx + 1] ?? segStart;
    const frac = segEnd > segStart ? Math.min(1, Math.max(0, (loc - segStart) / (segEnd - segStart))) : 0;
    return (cumDur[idx] ?? 0) + frac * (durations[idx] ?? 0);
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
    const seg = Math.max(0, cumTravelSec[i] - cumTravelSec[i - 1]) * opts.speedFactor;
    const arrival = Math.round(out[i - 1].departureSec + seg);
    const isLast = i === cumTravelSec.length - 1;
    out.push({ arrivalSec: arrival, departureSec: isLast ? arrival : arrival + opts.dwellSec });
  }
  return out;
}
