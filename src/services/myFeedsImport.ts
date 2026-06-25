// "My feeds" import source — lists EVERY feed project the signed-in account can
// access (personal + each org) and resolves a selected one — published OR not —
// so the existing ImportDialog route/stop picker + merge pipeline can ingest it.
//
// v2 (this file): drops the published-only restriction. Instead of fetching a
// feed's published GTFS zip, we read its live working state (the same in-progress
// edit the editor loads on open) via fetchWorkingState and reshape it into the
// transient ImportData the picker already understands. One code path covers
// published and draft feeds, and it's always the latest data. Crucially this is
// a PURE transform — it never touches the editor store, so importing another
// project never clobbers or switches away from the project you have open.

import { backfillRouteStopShapeIds } from './routeStopMigration';
import { fetchWorkingState, listProjects, type ProjectSummary } from './projectsApi';
import type { ImportData } from './gtfsImport';
import type { RouteStop, Trip } from '../types/gtfs';

export interface MyFeedItem {
  id: string;
  slug: string;
  name: string;
  /**
   * Whether the feed has a live canonical publication. Purely informational now
   * (shown as a published/draft label) — every feed is importable regardless,
   * since we import from the working state, not the published zip.
   */
  published: boolean;
  /** Last-edited timestamp (working state, falling back to project updatedAt). */
  updatedAt: number;
  thumbnailUrl: string | null;
}

/** Shape a raw project summary into the importer's feed-list item. */
export function toMyFeedItem(p: ProjectSummary): MyFeedItem {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    published: p.published === true,
    updatedAt: p.workingStateUpdatedAt ?? p.updatedAt,
    thumbnailUrl: p.thumbnailUrl ?? null,
  };
}

/**
 * List the feeds in one workspace for the importer. `scope` is 'personal' or
 * 'org:<id>' (the same scope string MyFeedsSource derives from activeWorkspace),
 * so the server returns only feeds the caller can access — org-scoping is
 * enforced server-side. Both published and draft feeds are returned. Archived
 * feeds are excluded (importer default).
 */
export async function listMyFeeds(scope: string): Promise<MyFeedItem[]> {
  const res = await listProjects({ scope });
  return res.projects.map(toMyFeedItem);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Reshape a project's working-state snapshot (the JSON blob the editor saves /
 * loads) into the transient ImportData the ImportDialog route/stop picker +
 * mergeImportIntoStore pipeline consume. The snapshot's keys are the same entity
 * slices the editor persists, so this is a direct field map — missing keys
 * default to empty arrays (a partial/old blob can't leak undefined into the
 * picker), and `warnings` is empty because nothing was parsed.
 *
 * routeStops get the same shape_id backfill the editor's own load path applies
 * (backfillRouteStopShapeIds), so a feed saved before per-shape keying still
 * lines its stops up under the right route in the picker/merge.
 *
 * This does NOT mutate the editor store — the result is a throwaway structure
 * handed to the picker, keeping the currently-open project untouched.
 */
export function workingStateToImportData(snapshot: Record<string, unknown>): ImportData {
  const trips = asArray<Trip>(snapshot.trips);
  const routeStops = backfillRouteStopShapeIds(asArray<RouteStop>(snapshot.routeStops), trips);
  return {
    agencies: asArray(snapshot.agencies),
    calendars: asArray(snapshot.calendars),
    calendarDates: asArray(snapshot.calendarDates),
    routes: asArray(snapshot.routes),
    shapes: asArray(snapshot.shapes),
    stops: asArray(snapshot.stops),
    trips,
    stopTimes: asArray(snapshot.stopTimes),
    feedInfo: (snapshot.feedInfo ?? null) as ImportData['feedInfo'],
    routeStops,
    fareAttributes: asArray(snapshot.fareAttributes),
    fareRules: asArray(snapshot.fareRules),
    transfers: asArray(snapshot.transfers),
    frequencies: asArray(snapshot.frequencies),
    levels: asArray(snapshot.levels),
    pathways: asArray(snapshot.pathways),
    fareAreas: asArray(snapshot.fareAreas),
    stopAreas: asArray(snapshot.stopAreas),
    fareNetworks: asArray(snapshot.fareNetworks),
    routeNetworks: asArray(snapshot.routeNetworks),
    timeframes: asArray(snapshot.timeframes),
    riderCategories: asArray(snapshot.riderCategories),
    fareMedia: asArray(snapshot.fareMedia),
    fareProducts: asArray(snapshot.fareProducts),
    fareLegRules: asArray(snapshot.fareLegRules),
    fareTransferRules: asArray(snapshot.fareTransferRules),
    flexZones: asArray(snapshot.flexZones),
    warnings: [],
  };
}

/**
 * Resolve a chosen feed (by project id) to the transient ImportData the picker
 * ingests, by fetching its working state. Org-scoping is enforced server-side on
 * the /working-state route, so this only succeeds for feeds the caller can
 * access. A brand-new project with no working state yet resolves to empty data.
 */
export async function resolveMyFeedImportData(projectId: string): Promise<ImportData> {
  const { snapshot } = await fetchWorkingState(projectId);
  return workingStateToImportData(snapshot ?? {});
}
