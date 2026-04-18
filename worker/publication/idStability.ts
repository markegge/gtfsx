// ID-stability check (BE-88). When a project has registered GTFS-Realtime
// feed URLs, publishing a new static version that removes an agency_id,
// route_id, stop_id, or trip_id referenced by the RT producer will make the
// RT feed reference stale/missing IDs. We diff the old vs. new state JSON
// and surface a 409 rt_breakage the user can acknowledge and proceed.

import { ungzip } from './ungzip';
import type { Env } from '../env';
import { getFeedBlob } from '../projects/r2';

export interface RtBreakageReport {
  agencies: string[];
  routes: string[];
  stops: string[];
  trips: string[];
}

export function isEmpty(report: RtBreakageReport): boolean {
  return (
    report.agencies.length === 0 &&
    report.routes.length === 0 &&
    report.stops.length === 0 &&
    report.trips.length === 0
  );
}

interface FeedState {
  agencies?: Array<{ agency_id?: string }>;
  routes?: Array<{ route_id?: string }>;
  stops?: Array<{ stop_id?: string }>;
  trips?: Array<{ trip_id?: string }>;
}

function idsFrom<T>(rows: T[] | undefined, key: keyof T): string[] {
  if (!rows) return [];
  const out: string[] = [];
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[key as string];
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

async function loadState(env: Env, key: string): Promise<FeedState | null> {
  const obj = await getFeedBlob(env, key);
  if (!obj) return null;
  const text = await ungzip(obj.body);
  try {
    return JSON.parse(text) as FeedState;
  } catch {
    return null;
  }
}

export async function diffRemovedIds(
  env: Env,
  oldStateKey: string,
  newStateKey: string,
): Promise<RtBreakageReport> {
  const [oldState, newState] = await Promise.all([
    loadState(env, oldStateKey),
    loadState(env, newStateKey),
  ]);
  if (!oldState || !newState) {
    return { agencies: [], routes: [], stops: [], trips: [] };
  }
  const oldAgencies = new Set(idsFrom(oldState.agencies, 'agency_id'));
  const newAgencies = new Set(idsFrom(newState.agencies, 'agency_id'));
  const oldRoutes = new Set(idsFrom(oldState.routes, 'route_id'));
  const newRoutes = new Set(idsFrom(newState.routes, 'route_id'));
  const oldStops = new Set(idsFrom(oldState.stops, 'stop_id'));
  const newStops = new Set(idsFrom(newState.stops, 'stop_id'));
  const oldTrips = new Set(idsFrom(oldState.trips, 'trip_id'));
  const newTrips = new Set(idsFrom(newState.trips, 'trip_id'));
  return {
    agencies: [...oldAgencies].filter((x) => !newAgencies.has(x)),
    routes: [...oldRoutes].filter((x) => !newRoutes.has(x)),
    stops: [...oldStops].filter((x) => !newStops.has(x)),
    trips: [...oldTrips].filter((x) => !newTrips.has(x)),
  };
}
