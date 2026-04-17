import { useStore } from '../store';
import {
  fetchWorkingState,
  saveWorkingState,
  ConflictError,
} from '../services/projectsApi';

// Mirrors DATA_KEYS in ./persistence.ts, plus flex zones which are part of
// the editor state and should round-trip through the server snapshot.
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
  'flexZones',
  'projectId',
  'projectName',
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

function buildSnapshot(): Record<string, unknown> {
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
  if (Array.isArray(g('flexZones'))) state.setFlexZones(g('flexZones') as never);
  if (typeof g('projectName') === 'string') state.setProjectName(g('projectName') as string);
  if (typeof g('projectId') === 'string') state.setProjectId(g('projectId') as string);

  state.markSaved();
}

export async function loadProjectFromServer(projectId: string): Promise<void> {
  const { snapshot, version } = await fetchWorkingState(projectId);
  setCurrentWorkingStateVersion(projectId, version);
  if (snapshot) applySnapshotToStore(snapshot);
}

export interface ServerAutoSaveHandle {
  unsubscribe: () => void;
  /** Flush any pending debounced save immediately. */
  flush: () => Promise<void>;
  /** Force a save against the server's latest version (for conflict-resolve "keep mine"). */
  forceSaveWithLatest: () => Promise<void>;
}

const DEBOUNCE_MS = 5000;

export function setupServerAutoSave(projectId: string): ServerAutoSaveHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let saving = false;
  let pending = false;
  let disposed = false;

  const doSave = async (): Promise<void> => {
    if (disposed) return;
    if (saving) {
      pending = true;
      return;
    }
    saving = true;
    try {
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
        } else {
          console.error('Working-state save failed', err);
        }
      }
    } finally {
      saving = false;
      if (pending && !disposed) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void doSave();
    }, DEBOUNCE_MS);
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await doSave();
  };

  const onBlur = () => {
    if (timer || saving || useStore.getState().isDirty) {
      void flush();
    }
  };

  const unsubStore = useStore.subscribe((state, prev) => {
    if (disposed) return;
    // Only fire on data changes — use the same DATA_KEYS comparison as local
    // persistence so UI-only changes (sidebar, selection) don't cause a save.
    const s = state as unknown as Record<string, unknown>;
    const p = prev as unknown as Record<string, unknown>;
    const changed = DATA_KEYS.some((key) => s[key] !== p[key]);
    if (!changed) return;
    state.markDirty();
    schedule();
  });

  window.addEventListener('blur', onBlur);

  const forceSaveWithLatest = async () => {
    // Fetch the server's current version, update our cache, then save.
    // Don't clobber the store with the server snapshot — intent is to
    // overwrite the remote with the local state.
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-GB-Client': 'web' },
    });
    if (res.ok) {
      const body = (await res.json()) as { workingStateVersion: number };
      setCurrentWorkingStateVersion(projectId, body.workingStateVersion);
    }
    await flush();
  };

  return {
    unsubscribe: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubStore();
      window.removeEventListener('blur', onBlur);
    },
    flush,
    forceSaveWithLatest,
  };
}
