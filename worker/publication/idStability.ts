// ID-stability check (BE-88). When a project has registered GTFS-Realtime
// feed URLs, publishing a new static version that removes an agency_id,
// route_id, stop_id, or trip_id referenced by the RT producer will make the
// RT feed reference stale/missing IDs. We diff the old vs. new state JSON
// and surface a 409 rt_breakage the user can acknowledge and proceed.
//
// The same diff also powers the agency_id-churn gate (C2). Both gates live in
// `assertIdStable()` below — the SINGLE evaluation used by every path that can
// flip the publication pointer:
//
//   • POST /api/projects/:id/publish            (immediate, via performPublish)
//   • POST /api/projects/:id/publish/schedule   (at SCHEDULE time, so the user
//                                                acknowledges while present)
//   • the */15 cron                             (at FIRE time, via performPublish,
//                                                replaying the persisted acks)
//
// Keeping it in one function is what makes the schedule-time 409 and the
// fire-time 409 provably identical.

import { ungzip } from './ungzip';
import type { Env } from '../env';
import { getFeedBlob } from '../projects/r2';
import { rtBreakage, agencyIdChurn } from '../util/errors';

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

// ─── The gates ──────────────────────────────────────────────────────────────

export interface IdStabilityGateInput {
  projectId: string;
  /** The snapshot about to become the publication. */
  snapshot: { id: string; state_r2_key: string };
  /** Currently-published row for the project (null if never published). */
  existingPublication: { snapshot_id: string } | null;
  /** Acknowledges the rt_breakage warning (BE-88). */
  ignoreRtBreakage?: boolean;
  /** Acknowledges the agency_id-churn warning (C2). */
  ignoreAgencyChurn?: boolean;
}

/**
 * Run both ID-stability gates against the currently-published snapshot. Throws
 * a 409 `rt_breakage` or 409 `agency_id_churn` ApiError the caller acknowledges
 * with the matching ignore flag; returns silently when clean or fully acked.
 *
 * Both gates read the SAME diff (published state − candidate state), so we load
 * and diff at most once:
 *
 *   1. rt_breakage (BE-88) — the harder gate, and therefore checked first.
 *      Only applies when the project has externally-hosted (managed=0) RT
 *      feeds: dropping an agency/route/stop/trip id out from under someone
 *      else's RT producer breaks it. Any removed id trips it.
 *
 *   2. agency_id_churn (C2) — applies to EVERY project, RT or not. FTA's
 *      enhanced P-50 form crosswalks a published feed to its NTD ID by
 *      agency_id, so removing/renaming an agency_id quietly breaks the NTD
 *      crosswalk (and any consumer keyed on agency_id). Only the `agencies`
 *      slice of the diff matters here.
 *
 * Both are advisory: the caller acknowledges and retries with the matching
 * ignore flag. Both are skipped on a first publish and on a re-publish of the
 * already-published snapshot (nothing can have changed).
 */
export async function assertIdStable(env: Env, input: IdStabilityGateInput): Promise<void> {
  const { projectId, snapshot, existingPublication } = input;
  const ignoreRtBreakage = input.ignoreRtBreakage ?? false;
  const ignoreAgencyChurn = input.ignoreAgencyChurn ?? false;

  const snapshotChanged = !!existingPublication && existingPublication.snapshot_id !== snapshot.id;
  if (!existingPublication || !snapshotChanged) return;
  if (ignoreRtBreakage && ignoreAgencyChurn) return;

  const rtCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM project_rt_feed WHERE project_id = ? AND managed = 0`,
  )
    .bind(projectId)
    .first<{ n: number }>();
  const rtGateApplies = (rtCount?.n ?? 0) > 0 && !ignoreRtBreakage;
  const churnGateApplies = !ignoreAgencyChurn;
  if (!rtGateApplies && !churnGateApplies) return;

  const prior = await env.DB.prepare(
    `SELECT state_r2_key FROM feed_snapshot WHERE id = ? AND project_id = ?`,
  )
    .bind(existingPublication.snapshot_id, projectId)
    .first<{ state_r2_key: string }>();
  if (!prior) return;

  const removed = await diffRemovedIds(env, prior.state_r2_key, snapshot.state_r2_key);
  if (rtGateApplies && !isEmpty(removed)) {
    throw rtBreakage({
      removed: {
        agencies: removed.agencies,
        routes: removed.routes,
        stops: removed.stops,
        trips: removed.trips,
      },
    });
  }
  if (churnGateApplies && removed.agencies.length > 0) {
    throw agencyIdChurn({ removed: { agencies: removed.agencies } });
  }
}
