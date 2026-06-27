// Store-mutating GTFS import helpers. The pure parser (importGtfsZip,
// inspectGtfsZip) lives in gtfsParse.ts so it can run in a Web Worker; we
// re-export it here so existing import sites keep importing from one place.
import { useStore } from '../store';
import { loadingFeed } from '../store/history';
import type { AdvancedFeature } from '../store/featuresSlice';
import {
  importGtfsZip,
  inspectGtfsZip,
  LARGE_FEED_BYTES,
  type ImportData,
  type ImportProgress,
  type ImportWorkerResponse,
} from './gtfsParse';

export { importGtfsZip, inspectGtfsZip, LARGE_FEED_BYTES };
export type { ImportData, ImportProgress };

/** Parse a GTFS zip in a Web Worker so the main thread stays responsive on
 * large feeds. Falls back to the main-thread parse if Workers are unavailable.
 * Progress callbacks fire on phase changes (and every ~250k stop_times rows). */
export function parseGtfsInWorker(
  file: File,
  onProgress?: ImportProgress,
): Promise<ImportData> {
  if (typeof Worker === 'undefined') {
    return importGtfsZip(file, onProgress);
  }
  return new Promise<ImportData>((resolve, reject) => {
    const worker = new Worker(new URL('./gtfsImport.worker.ts', import.meta.url), {
      type: 'module',
    });
    const done = (fn: () => void) => { worker.terminate(); fn(); };
    worker.onmessage = (e: MessageEvent<ImportWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress?.({ phase: msg.phase, rows: msg.rows });
      else if (msg.type === 'result') done(() => resolve(msg.data));
      else if (msg.type === 'error') done(() => reject(new Error(msg.message)));
    };
    worker.onerror = (e) => done(() => reject(new Error(e.message || 'Import worker failed')));
    worker.postMessage({ file });
  });
}

export function loadImportIntoStore(data: Awaited<ReturnType<typeof importGtfsZip>>) {
  // Loading a different feed must not be undoable across the boundary (#49):
  // suppress history capture during the bulk load, then reset both stacks.
  loadingFeed(() => applyImportToStore(data));
}

function applyImportToStore(data: Awaited<ReturnType<typeof importGtfsZip>>) {
  const store = useStore.getState();
  // Reset UI selection / editing / visibility state so stale references to
  // routes/stops/shapes from the previous project don't linger across a
  // "Replace project" import. Map mode returns to 'select' and any in-flight
  // drawing or editing is cancelled. This makes a replace-import behave
  // identically to loading a feed into a fresh project.
  store.selectRoute(null);
  store.selectStop(null);
  store.selectTrip(null);
  store.setDrawingRouteId(null);
  store.setEditingRouteId(null);
  store.setEditingShapeId(null);
  store.setEditingFlexZoneId(null);
  store.setMapMode('select');
  // Drop any hidden-route / hidden-shape lists — the ids belong to routes
  // and shapes that no longer exist.
  useStore.setState((s) => {
    s.hiddenRouteIds = [];
    s.hiddenShapeIds = [];
  });
  // Clear derived analytics so the Coverage / Validation panels don't
  // display stale numbers from the previous feed.
  store.setValidationMessages([]);
  store.setCoverageData(null);
  store.setCoverageError(null);

  store.setAgencies(data.agencies);
  store.setCalendars(data.calendars);
  store.setCalendarDates(data.calendarDates);
  store.setRoutes(data.routes);
  store.setShapes(data.shapes);
  store.setStops(data.stops);
  store.setTrips(data.trips);
  store.setStopTimes(data.stopTimes);
  store.setFeedInfo(data.feedInfo);
  store.setRouteStops(data.routeStops);
  store.setFareAttributes(data.fareAttributes);
  store.setFareRules(data.fareRules);
  store.setTransfers(data.transfers);
  store.setFrequencies(data.frequencies);
  store.setLevels(data.levels);
  store.setPathways(data.pathways);
  store.setFareAreas(data.fareAreas);
  store.setStopAreas(data.stopAreas);
  store.setFareNetworks(data.fareNetworks);
  store.setRouteNetworks(data.routeNetworks);
  store.setTimeframes(data.timeframes);
  store.setRiderCategories(data.riderCategories);
  store.setFareMedia(data.fareMedia);
  store.setFareProducts(data.fareProducts);
  store.setFareLegRules(data.fareLegRules);
  store.setFareTransferRules(data.fareTransferRules);
  store.setFlexZones(data.flexZones);

  // Seed per-feed feature settings from what the imported feed contains, so its
  // advanced sections (frequencies, stations, transfers) show up — "the feed
  // contains the file" enables the feature. demandResponse is left unset so it
  // stays on by default. Blocks is intentionally NOT seeded: block_id is too
  // niche to auto-surface a nav section, so it stays off until the user opts in
  // (the data is preserved and still exports regardless).
  const fs: Partial<Record<AdvancedFeature, boolean>> = {};
  if (data.transfers.length) fs.transfers = true;
  if (data.frequencies.length) fs.frequencies = true;
  if (data.levels.length || data.pathways.length) fs.stations = true;
  // Fares v2: auto-on when the imported feed already carries any v2 file, so
  // its authoring tabs surface without the user hunting for the toggle.
  if (
    data.fareAreas.length || data.stopAreas.length ||
    data.fareNetworks.length || data.routeNetworks.length ||
    data.timeframes.length || data.riderCategories.length ||
    data.fareMedia.length || data.fareProducts.length ||
    data.fareLegRules.length || data.fareTransferRules.length
  ) {
    fs.faresV2 = true;
  }
  store.setFeatureSettings(fs);

  // A freshly imported feed starts with nothing dismissed — validation
  // dismissals are per-feed, so the new feed surfaces every applicable rule.
  store.setDismissedValidations([]);
}

/**
 * Merge selected routes (and their associated stops, trips, stop times, shapes,
 * calendars, and route-stop associations) from an imported feed into the
 * existing project. Agency info and fares are NOT imported.
 * If any IDs conflict with existing ones, a numeric prefix is applied to all
 * imported IDs to guarantee uniqueness.
 */
export function mergeImportIntoStore(
  data: Awaited<ReturnType<typeof importGtfsZip>>,
  selectedRouteIds: Set<string>,
) {
  const store = useStore.getState();

  // Determine whether we need a prefix to avoid ID collisions
  const existingRouteIds = new Set(store.routes.map((r) => r.route_id));
  const existingStopIds  = new Set(store.stops.map((s) => s.stop_id));
  const existingTripIds  = new Set(store.trips.map((t) => t.trip_id));
  const existingShapeIds = new Set(store.shapes.map((s) => s.shape_id));

  const hasConflict =
    data.routes.some((r) => existingRouteIds.has(r.route_id)) ||
    data.stops.some((s)  => existingStopIds.has(s.stop_id))   ||
    data.trips.some((t)  => existingTripIds.has(t.trip_id))   ||
    data.shapes.some((s) => existingShapeIds.has(s.shape_id));

  let prefix = '';
  if (hasConflict) {
    for (let i = 2; i <= 99; i++) {
      const p = `i${i}_`;
      if (!data.routes.some((r) => existingRouteIds.has(p + r.route_id))) {
        prefix = p;
        break;
      }
    }
    if (!prefix) prefix = `imp${Date.now()}_`;
  }

  const pfx = (id: string) => (prefix ? prefix + id : id);

  // Build calendar service_id remap: match imported calendars to existing ones
  // by day-of-week pattern (the 7 boolean fields)
  const calendarDayKey = (c: { monday: number; tuesday: number; wednesday: number; thursday: number; friday: number; saturday: number; sunday: number }) =>
    `${c.monday}${c.tuesday}${c.wednesday}${c.thursday}${c.friday}${c.saturday}${c.sunday}`;

  const existingCalByPattern = new Map<string, string>();
  for (const c of store.calendars) {
    existingCalByPattern.set(calendarDayKey(c), c.service_id);
  }

  const serviceIdRemap = new Map<string, string>();
  for (const c of data.calendars) {
    const pattern = calendarDayKey(c);
    const existingId = existingCalByPattern.get(pattern);
    if (existingId) {
      serviceIdRemap.set(c.service_id, existingId);
    }
  }

  const remapServiceId = (id: string) => serviceIdRemap.get(id) ?? id;

  // Build stop remap: match imported stops to existing stops by name + location
  const stopIdRemap = new Map<string, string>();
  for (const importedStop of data.stops) {
    for (const existingStop of store.stops) {
      const sameName = existingStop.stop_name === importedStop.stop_name;
      const sameLat = Math.abs(existingStop.stop_lat - importedStop.stop_lat) < 0.0001;
      const sameLon = Math.abs(existingStop.stop_lon - importedStop.stop_lon) < 0.0001;
      if (sameName && sameLat && sameLon) {
        stopIdRemap.set(importedStop.stop_id, existingStop.stop_id);
        break;
      }
    }
  }

  const remapStopId = (id: string) => stopIdRemap.get(id) ?? pfx(id);

  // Narrow to selected routes and their dependent data
  const selectedRoutes    = data.routes.filter((r) => selectedRouteIds.has(r.route_id));
  const selRouteGtfsIds   = new Set(selectedRoutes.map((r) => r.route_id));

  const selectedTrips     = data.trips.filter((t) => selRouteGtfsIds.has(t.route_id));
  const selTripGtfsIds    = new Set(selectedTrips.map((t) => t.trip_id));

  const selectedStopTimes = data.stopTimes.filter((st) => selTripGtfsIds.has(st.trip_id));

  const neededStopIds = new Set([
    ...selectedStopTimes.map((st) => st.stop_id),
    ...data.routeStops.filter((rs) => selRouteGtfsIds.has(rs.route_id)).map((rs) => rs.stop_id),
  ]);
  // Only import stops that aren't remapped to existing ones
  const selectedStops = data.stops.filter(
    (s) => neededStopIds.has(s.stop_id) && !stopIdRemap.has(s.stop_id)
  );

  const neededShapeIds = new Set(
    selectedTrips.map((t) => t.shape_id).filter(Boolean) as string[],
  );
  const selectedShapes     = data.shapes.filter((s) => neededShapeIds.has(s.shape_id));
  const selectedRouteStops = data.routeStops.filter((rs) => selRouteGtfsIds.has(rs.route_id));

  // Append routes
  for (const route of selectedRoutes) {
    store.addRoute({ ...route, route_id: pfx(route.route_id) });
  }

  // Append stops that aren't matched to existing ones
  const storeAfterRoutes  = useStore.getState();
  const existingStopIdsNow = new Set(storeAfterRoutes.stops.map((s) => s.stop_id));
  for (const stop of selectedStops) {
    const newId = pfx(stop.stop_id);
    if (!existingStopIdsNow.has(newId)) {
      storeAfterRoutes.addStop({ ...stop, stop_id: newId });
    }
  }

  // Append trips (remap service_id to existing calendar if pattern matches)
  for (const trip of selectedTrips) {
    store.addTrip({
      ...trip,
      trip_id:  pfx(trip.trip_id),
      route_id: pfx(trip.route_id),
      service_id: remapServiceId(trip.service_id),
      shape_id: trip.shape_id ? pfx(trip.shape_id) : undefined,
    });
  }

  // Append stop times (batch to avoid many individual Immer drafts)
  const s1 = useStore.getState();
  s1.setStopTimes([
    ...s1.stopTimes,
    ...selectedStopTimes.map((st) => ({
      ...st,
      trip_id: pfx(st.trip_id),
      stop_id: remapStopId(st.stop_id),
    })),
  ]);

  // Append shapes
  for (const shape of selectedShapes) {
    store.addShape({ ...shape, shape_id: pfx(shape.shape_id) });
  }

  // Append route-stop associations (batch). shape_id MUST be prefixed to match
  // the imported trips' + shapes' prefixed shape_id — otherwise the timetable's
  // orderedStops (which filters routeStops by the trips' shape_id) finds nothing
  // and shows "Add stops to this route first" despite the trips existing.
  const s2 = useStore.getState();
  s2.setRouteStops([
    ...s2.routeStops,
    ...selectedRouteStops.map((rs) => ({
      ...rs,
      route_id: pfx(rs.route_id),
      stop_id:  remapStopId(rs.stop_id),
      shape_id: rs.shape_id ? pfx(rs.shape_id) : rs.shape_id,
    })),
  ]);

  // Append calendars referenced by selected trips that weren't remapped
  const neededServiceIds = new Set(selectedTrips.map((t) => t.service_id));
  const s3 = useStore.getState();
  const currentCalendarIds = new Set(s3.calendars.map((c) => c.service_id));
  const calendarsToAdd = data.calendars.filter(
    (c) =>
      neededServiceIds.has(c.service_id) &&
      !currentCalendarIds.has(c.service_id) &&
      !serviceIdRemap.has(c.service_id),
  );
  if (calendarsToAdd.length > 0) {
    s3.setCalendars([...s3.calendars, ...calendarsToAdd]);
  }

  // Append calendar_dates for newly added calendars
  const addedServiceIds = new Set(calendarsToAdd.map((c) => c.service_id));
  if (addedServiceIds.size > 0) {
    const calDatesToAdd = data.calendarDates.filter(
      (cd) => addedServiceIds.has(cd.service_id),
    );
    if (calDatesToAdd.length > 0) {
      const s4 = useStore.getState();
      s4.setCalendarDates([...s4.calendarDates, ...calDatesToAdd]);
    }
  }
}
