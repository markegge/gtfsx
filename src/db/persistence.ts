import { db } from './dexie';
import { useStore } from '../store';

const DATA_KEYS = [
  'agencies', 'calendars', 'calendarDates', 'routes', 'routeStops',
  'stops', 'trips', 'stopTimes', 'shapes', 'feedInfo',
  'fareAttributes', 'fareRules',
  'projectId', 'projectName',
] as const;

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

  state.markSaved();
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
