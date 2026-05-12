import { db } from './dexie';
import { useStore } from '../store';

const DATA_KEYS = [
  'agencies', 'calendars', 'calendarDates', 'routes', 'routeStops',
  'stops', 'trips', 'stopTimes', 'shapes', 'feedInfo',
  'fareAttributes', 'fareRules',
  'projectId', 'projectName',
] as const;

// localStorage key for the most recently autosaved anonymous projectId.
// EditorRoute reads this on mount so refresh / reopen restores the draft —
// otherwise the random projectId the store initializes with on each load
// would never match the autosaved row in IndexedDB and the data would
// silently orphan.
export const LAST_PROJECT_KEY = 'gtfs:lastProjectId';

export async function saveProject() {
  const state = useStore.getState();
  const snapshot: Record<string, any> = {};
  for (const key of DATA_KEYS) {
    snapshot[key] = state[key];
  }

  await db.projects.put({
    id: state.projectId,
    name: state.projectName,
    lastModified: Date.now(),
  });

  await db.projectData.put({
    projectId: state.projectId,
    storeSnapshot: JSON.stringify(snapshot),
  });

  // Remember which anonymous draft this tab was editing so the next page
  // load (refresh, browser restart, or just reopening the tab) reloads
  // the same project from IndexedDB instead of a fresh empty one.
  try {
    localStorage.setItem(LAST_PROJECT_KEY, state.projectId);
  } catch {
    // Storage quota / private mode — losing the pointer just means the
    // refreshed tab won't auto-restore; the draft is still in IndexedDB.
  }

  // The user-visible "Saved / Unsaved changes" indicator tracks BACKEND save
  // state, not the local IndexedDB cache — anonymous users have nothing
  // backed up in the cloud even after autosave completes. Server-backed save
  // markSaved happens in serverPersistence.saveProjectNow. We just log the
  // local-cache write so devs can confirm IDB autosave is healthy from the
  // console without polluting the UI.
  console.debug(
    '[idb-autosave] Saved snapshot',
    { projectId: state.projectId, t: new Date().toISOString() },
  );
}

export async function loadProject(projectId: string) {
  const data = await db.projectData.get(projectId);
  if (!data) return false;

  const snapshot = JSON.parse(data.storeSnapshot);
  const state = useStore.getState();

  if (snapshot.agencies) state.setAgencies(snapshot.agencies);
  if (snapshot.calendars) state.setCalendars(snapshot.calendars);
  if (snapshot.calendarDates) state.setCalendarDates(snapshot.calendarDates);
  if (snapshot.routes) state.setRoutes(snapshot.routes);
  if (snapshot.routeStops) state.setRouteStops(snapshot.routeStops);
  if (snapshot.stops) state.setStops(snapshot.stops);
  if (snapshot.trips) state.setTrips(snapshot.trips);
  if (snapshot.stopTimes) state.setStopTimes(snapshot.stopTimes);
  if (snapshot.shapes) state.setShapes(snapshot.shapes);
  if (snapshot.feedInfo !== undefined) state.setFeedInfo(snapshot.feedInfo);
  if (snapshot.fareAttributes) state.setFareAttributes(snapshot.fareAttributes);
  if (snapshot.fareRules) state.setFareRules(snapshot.fareRules);
  if (snapshot.projectName) state.setProjectName(snapshot.projectName);
  if (snapshot.projectId) state.setProjectId(snapshot.projectId);

  state.markSaved();
  return true;
}

export async function listProjects() {
  return await db.projects.toArray();
}

// Auto-save setup
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function setupAutoSave() {
  return useStore.subscribe((state, prevState) => {
    // Check if any data changed (not just UI state)
    const dataChanged = DATA_KEYS.some((key) => state[key] !== prevState[key]);
    if (!dataChanged) return;

    state.markDirty();
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveProject().catch(console.error);
    }, 1000);
  });
}
