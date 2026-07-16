import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { ensureDefaultCalendar } from '../../services/defaultCalendar';
import { useStopTimesIndex } from '../../hooks/useStopTimesIndex';
import { computeTimetablePatterns, isNoShapeBucket } from '../ui/shapePatterns';
import type { Stop, StopTime } from '../../types/gtfs';

/** A resolved scope for one timetable pane. The main pane's scope proxies the
 *  global `timetable*` store fields; the companion pane's is derived (same route
 *  + service, opposite direction / chosen pattern). */
export interface PaneScope {
  routeId: string | null;
  directionId: 0 | 1;
  serviceId: string | null;
  shapeId: string | null;
}

export interface OrderedStop {
  uid: string;
  seq: number;
  stop: Stop;
}

/** All read-derived data a timetable pane needs, computed from a scope. Extracted
 *  from the old monolithic TimetableGrid so the main and companion panes each
 *  derive independently. When `syncSelection` is true (main pane only) it also
 *  keeps the global shape/direction selection valid and auto-creates a calendar
 *  if the feed has none — the companion pane is fully derived and does neither. */
export function useTimetableData(scope: PaneScope, syncSelection: boolean) {
  const routes = useStore((s) => s.routes);
  const trips = useStore((s) => s.trips);
  const stops = useStore((s) => s.stops);
  const routeStops = useStore((s) => s.routeStops);
  const shapes = useStore((s) => s.shapes);
  const calendars = useStore((s) => s.calendars);
  const setSelectedShapeId = useStore((s) => s.setTimetableShapeId);
  const setDirectionId = useStore((s) => s.setTimetableDirectionId);
  const { byTrip: stopTimesByTrip } = useStopTimesIndex();

  const { routeId, directionId, serviceId, shapeId } = scope;
  const route = routes.find((r) => r.route_id === routeId);

  // Safety net: a feed with zero calendars gets a default one (main pane only).
  useEffect(() => {
    if (!syncSelection) return;
    if (calendars.length > 0) return;
    if (!routeId || routes.length === 0) return;
    ensureDefaultCalendar();
  }, [syncSelection, calendars.length, routeId, routes.length]);

  const activeServiceId = useMemo(() => {
    if (serviceId && calendars.some((c) => c.service_id === serviceId)) return serviceId;
    return calendars[0]?.service_id || null;
  }, [serviceId, calendars]);

  const patterns = useMemo(
    () => computeTimetablePatterns(routeId, trips, routeStops, shapes),
    [routeId, trips, routeStops, shapes],
  );

  // Main pane: keep the stored shape/direction pointing at a valid pattern.
  useEffect(() => {
    if (!syncSelection) return;
    if (patterns.length === 0) {
      if (shapeId !== null) setSelectedShapeId(null);
      return;
    }
    const current = patterns.find((p) => p.shapeId === shapeId);
    if (!current) {
      const first = patterns[0];
      setSelectedShapeId(first.shapeId);
      if (first.directionId !== directionId) setDirectionId(first.directionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSelection, routeId, patterns]);

  const effectiveShapeId = useMemo(() => {
    if (patterns.length === 0) return null;
    return patterns.some((p) => p.shapeId === shapeId) ? shapeId : patterns[0].shapeId;
  }, [patterns, shapeId]);

  const noShapeBucket = isNoShapeBucket(effectiveShapeId);
  const realShapeIds = useMemo(
    () => new Set(patterns.filter((p) => !isNoShapeBucket(p.shapeId)).map((p) => p.shapeId)),
    [patterns],
  );

  const orderedStops: OrderedStop[] = useMemo(() => {
    if (!routeId) return [];
    const list = noShapeBucket
      ? routeStops.filter((rs) => rs.route_id === routeId && rs.direction_id === directionId
          && (!rs.shape_id || !realShapeIds.has(rs.shape_id)))
      : effectiveShapeId
        ? routeStops.filter((rs) => rs.route_id === routeId && rs.shape_id === effectiveShapeId)
        : routeStops.filter((rs) => rs.route_id === routeId && rs.direction_id === directionId);
    return [...list]
      .sort((a, b) => a.stop_sequence - b.stop_sequence)
      .map((rs) => {
        const stop = stops.find((s) => s.stop_id === rs.stop_id);
        return stop ? { uid: rs._uid ?? `${rs.stop_id}-${rs.stop_sequence}`, seq: rs.stop_sequence, stop } : null;
      })
      .filter((x): x is OrderedStop => x !== null);
  }, [routeId, effectiveShapeId, directionId, routeStops, stops, noShapeBucket, realShapeIds]);

  const findStopTime = useCallback((tripId: string, seq: number): StopTime | undefined => {
    const list = stopTimesByTrip.get(tripId);
    return list?.find((st) => st.stop_sequence === seq);
  }, [stopTimesByTrip]);

  const timepointStopIds = useMemo(() => {
    const ids = new Set<string>();
    if (routeId) {
      const routeTripIds = trips.filter((t) => t.route_id === routeId).map((t) => t.trip_id);
      for (const tripId of routeTripIds) {
        for (const st of stopTimesByTrip.get(tripId) ?? []) {
          if (st.timepoint === 1) ids.add(st.stop_id);
        }
      }
    }
    if (ids.size === 0 && orderedStops.length >= 2) {
      ids.add(orderedStops[0].stop.stop_id);
      ids.add(orderedStops[orderedStops.length - 1].stop.stop_id);
    }
    return ids;
  }, [stopTimesByTrip, orderedStops, routeId, trips]);

  const continuousOverrides = useMemo(() => {
    const map = new Map<string, { pickup?: 0 | 1 | 2 | 3; dropOff?: 0 | 1 | 2 | 3 }>();
    if (routeId) {
      const routeTripIds = new Set(trips.filter((t) => t.route_id === routeId).map((t) => t.trip_id));
      for (const tripId of routeTripIds) {
        for (const st of stopTimesByTrip.get(tripId) ?? []) {
          if (st.continuous_pickup === undefined && st.continuous_drop_off === undefined) continue;
          if (!map.has(st.stop_id)) map.set(st.stop_id, { pickup: st.continuous_pickup, dropOff: st.continuous_drop_off });
        }
      }
    }
    return map;
  }, [stopTimesByTrip, routeId, trips]);

  const routeTrips = useMemo(() => {
    if (!routeId) return [];
    return trips
      .filter((t) => t.route_id === routeId
        && (!activeServiceId || t.service_id === activeServiceId)
        && (noShapeBucket
          ? (t.direction_id === directionId && (!t.shape_id || !realShapeIds.has(t.shape_id)))
          : effectiveShapeId ? t.shape_id === effectiveShapeId : t.direction_id === directionId))
      .sort((a, b) => {
        const earliest = (tripId: string) => {
          let best = '';
          for (const st of stopTimesByTrip.get(tripId) ?? []) {
            if (st.arrival_time && (!best || st.arrival_time.localeCompare(best) < 0)) best = st.arrival_time;
          }
          return best;
        };
        const aTime = earliest(a.trip_id);
        const bTime = earliest(b.trip_id);
        if (!aTime || !bTime) return (aTime ? 0 : 1) - (bTime ? 0 : 1);
        return aTime.localeCompare(bTime);
      });
  }, [routeId, trips, stopTimesByTrip, directionId, activeServiceId, effectiveShapeId, noShapeBucket, realShapeIds]);

  const serviceIdsWithTrips = useMemo(() => {
    if (!routeId) return [];
    return [...new Set(
      trips.filter((t) => t.route_id === routeId && t.direction_id === directionId).map((t) => t.service_id),
    )];
  }, [routeId, trips, directionId]);

  // First non-blank displayed time for a trip (departure preferred at the origin).
  const getFirstDisplayedTime = useCallback((tripId: string) => {
    for (const col of orderedStops) {
      const st = findStopTime(tripId, col.seq);
      const t = st?.departure_time || st?.arrival_time;
      if (t) return t;
    }
    return '';
  }, [orderedStops, findStopTime]);

  return {
    route,
    patterns,
    activeServiceId,
    effectiveShapeId,
    noShapeBucket,
    realShapeIds,
    orderedStops,
    routeTrips,
    timepointStopIds,
    continuousOverrides,
    serviceIdsWithTrips,
    findStopTime,
    getFirstDisplayedTime,
    hasStops: orderedStops.length > 0,
  };
}
