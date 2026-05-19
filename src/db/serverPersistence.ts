import { useStore } from '../store';
import {
  fetchWorkingState,
  saveWorkingState,
  ConflictError,
} from '../services/projectsApi';

// Editor state that round-trips through the server snapshot. Notably excludes
// projectId and projectName: those are project-level metadata served by
// /api/projects/:id and re-applied by ServerEditorRoute on load. Including
// them in the snapshot caused the displayed name to diverge from the
// canonical project.name and re-marked dirty after reload.
const DATA_KEYS = [
  'agencies',
  'calendars',
  'calendarDates',
  'routes',
  'routeStops',
  'stops',
  'trips',
  'stopTimes',
  'shapes',
  'feedInfo',
  'fareAttributes',
  'fareRules',
  'fareAreas',
  'stopAreas',
  'fareNetworks',
  'routeNetworks',
  'timeframes',
  'riderCategories',
  'fareMedia',
  'fareProducts',
  'fareLegRules',
  'fareTransferRules',
  'flexZones',
] as const;

type DataKey = (typeof DATA_KEYS)[number];

const versionCache = new Map<string, number>();

export function getCurrentWorkingStateVersion(projectId: string): number {
  return versionCache.get(projectId) ?? 0;
}

export function setCurrentWorkingStateVersion(projectId: string, version: number) {
  versionCache.set(projectId, version);
  useStore.getState().setWorkingStateVersion(version);
}

export function buildSnapshot(): Record<string, unknown> {
  const state = useStore.getState() as unknown as Record<string, unknown>;
  const snapshot: Record<string, unknown> = {};
  for (const key of DATA_KEYS) {
    snapshot[key] = state[key];
  }
  return snapshot;
}

export function applySnapshotToStore(snapshot: Record<string, unknown>) {
  const state = useStore.getState();

  // Reset UI selection / editing state (mirrors loadImportIntoStore behaviour).
  state.selectRoute(null);
  state.selectStop(null);
  state.selectTrip(null);
  state.setDrawingRouteId(null);
  state.setEditingRouteId(null);
  state.setEditingShapeId(null);
  state.setEditingFlexZoneId(null);
  state.setMapMode('select');
  useStore.setState((s) => {
    s.hiddenRouteIds = [];
    s.hiddenShapeIds = [];
  });
  state.setValidationMessages([]);
  state.setCoverageData(null);
  state.setCoverageError(null);

  const g = (k: DataKey) => snapshot[k];
  if (Array.isArray(g('agencies'))) state.setAgencies(g('agencies') as never);
  if (Array.isArray(g('calendars'))) state.setCalendars(g('calendars') as never);
  if (Array.isArray(g('calendarDates'))) state.setCalendarDates(g('calendarDates') as never);
  if (Array.isArray(g('routes'))) state.setRoutes(g('routes') as never);
  if (Array.isArray(g('routeStops'))) state.setRouteStops(g('routeStops') as never);
  if (Array.isArray(g('stops'))) state.setStops(g('stops') as never);
  if (Array.isArray(g('trips'))) state.setTrips(g('trips') as never);
  if (Array.isArray(g('stopTimes'))) state.setStopTimes(g('stopTimes') as never);
  if (Array.isArray(g('shapes'))) state.setShapes(g('shapes') as never);
  if (g('feedInfo') !== undefined) state.setFeedInfo(g('feedInfo') as never);
  if (Array.isArray(g('fareAttributes'))) state.setFareAttributes(g('fareAttributes') as never);
  if (Array.isArray(g('fareRules'))) state.setFareRules(g('fareRules') as never);
  if (Array.isArray(g('fareAreas'))) state.setFareAreas(g('fareAreas') as never);
  if (Array.isArray(g('stopAreas'))) state.setStopAreas(g('stopAreas') as never);
  if (Array.isArray(g('fareNetworks'))) state.setFareNetworks(g('fareNetworks') as never);
  if (Array.isArray(g('routeNetworks'))) state.setRouteNetworks(g('routeNetworks') as never);
  if (Array.isArray(g('timeframes'))) state.setTimeframes(g('timeframes') as never);
  if (Array.isArray(g('riderCategories'))) state.setRiderCategories(g('riderCategories') as never);
  if (Array.isArray(g('fareMedia'))) state.setFareMedia(g('fareMedia') as never);
  if (Array.isArray(g('fareProducts'))) state.setFareProducts(g('fareProducts') as never);
  if (Array.isArray(g('fareLegRules'))) state.setFareLegRules(g('fareLegRules') as never);
  if (Array.isArray(g('fareTransferRules'))) state.setFareTransferRules(g('fareTransferRules') as never);
  if (Array.isArray(g('flexZones'))) state.setFlexZones(g('flexZones') as never);

  state.markSaved();
}

export async function loadProjectFromServer(projectId: string): Promise<void> {
  const { snapshot, version } = await fetchWorkingState(projectId);
  setCurrentWorkingStateVersion(projectId, version);
  if (snapshot) {
    applySnapshotToStore(snapshot);
  } else {
    // Brand-new project with no working state yet — still mark clean so any
    // metadata setters that ran beforehand don't leave the editor "dirty".
    useStore.getState().markSaved();
  }
}

/**
 * One-shot save of the current store state to the server. Throws on network
 * failure or unexpected error; on If-Match conflict, dispatches the
 * `gb:working-state-conflict` event (so the existing ConflictDialog handles
 * resolution) and resolves without throwing.
 */
export async function saveProjectNow(projectId: string): Promise<void> {
  const snapshot = buildSnapshot();
  const ifMatch = getCurrentWorkingStateVersion(projectId);
  try {
    const { workingStateVersion } = await saveWorkingState(projectId, snapshot, ifMatch);
    setCurrentWorkingStateVersion(projectId, workingStateVersion);
    useStore.getState().markSaved();
  } catch (err) {
    if (err instanceof ConflictError) {
      window.dispatchEvent(
        new CustomEvent('gb:working-state-conflict', {
          detail: { projectId, currentVersion: err.currentVersion },
        }),
      );
      return;
    }
    throw err;
  }
}

/**
 * Used by the conflict dialog's "Keep mine" path: refresh the cached
 * If-Match version to the server's latest, then save again so the user's
 * local state overwrites the remote.
 */
export async function forceSaveWithLatest(projectId: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'GET',
    credentials: 'include',
    headers: { 'X-GB-Client': 'web' },
  });
  if (res.ok) {
    const body = (await res.json()) as { workingStateVersion: number };
    setCurrentWorkingStateVersion(projectId, body.workingStateVersion);
  }
  await saveProjectNow(projectId);
}
