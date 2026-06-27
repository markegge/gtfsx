// Regression test for mergeImportIntoStore (importing a route from another feed).
//
// Bug (Mark, 2026-06-27): importing the "pink line" from another feed yielded
// trips that did not appear in the timetable ("Add stops to this route first"
// despite "8 trips"). Root cause: when an ID collision forces a prefix, the
// imported trips' and shapes' shape_id got prefixed (e.g. i2_SH1) but the
// route-stop associations kept the UN-prefixed shape_id (SH1). The timetable
// derives its stop columns from routeStops filtered by the trips' shape_id, so
// the mismatch made orderedStops empty. Fix: prefix shape_id on routeStops too.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { mergeImportIntoStore } from '../gtfsImport';

function resetStore() {
  const s = useStore.getState();
  s.setRoutes([]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setShapes([]);
  s.setRouteStops([]);
  s.setCalendars([]);
  s.setCalendarDates([]);
}

describe('mergeImportIntoStore — route-stop shape_id stays consistent under a prefix', () => {
  beforeEach(resetStore);

  it('prefixes routeStops.shape_id to match the imported trips/shapes', () => {
    // Pre-seed a shape with the SAME id the import uses → forces the i2_ prefix.
    useStore.getState().setShapes([
      { shape_id: 'SH1', shape_pt_lat: 0, shape_pt_lon: 0, shape_pt_sequence: 0 } as never,
    ]);

    const data = {
      routes: [{ route_id: 'R1', route_short_name: 'P' }],
      stops: [
        { stop_id: 'S1', stop_name: 'A', stop_lat: 1, stop_lon: 1 },
        { stop_id: 'S2', stop_name: 'B', stop_lat: 2, stop_lon: 2 },
      ],
      trips: [{ trip_id: 'T1', route_id: 'R1', service_id: 'WK', shape_id: 'SH1', direction_id: 0 }],
      stopTimes: [
        { trip_id: 'T1', stop_id: 'S1', stop_sequence: 1 },
        { trip_id: 'T1', stop_id: 'S2', stop_sequence: 2 },
      ],
      shapes: [{ shape_id: 'SH1', shape_pt_lat: 0, shape_pt_lon: 0, shape_pt_sequence: 0 }],
      routeStops: [
        { route_id: 'R1', stop_id: 'S1', shape_id: 'SH1', direction_id: 0, sequence: 0 },
        { route_id: 'R1', stop_id: 'S2', shape_id: 'SH1', direction_id: 0, sequence: 1 },
      ],
      calendars: [
        { service_id: 'WK', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' },
      ],
      calendarDates: [],
      agencies: [],
      fareProducts: [],
      warnings: [],
      feedInfo: null,
    } as never;

    mergeImportIntoStore(data, new Set(['R1']));

    const st = useStore.getState();
    const importedTrip = st.trips.find((t) => t.route_id === 'i2_R1');
    expect(importedTrip).toBeTruthy();
    expect(importedTrip!.shape_id).toBe('i2_SH1'); // trip shape was prefixed

    const importedRouteStops = st.routeStops.filter((rs) => rs.route_id === 'i2_R1');
    expect(importedRouteStops.length).toBe(2);
    // THE FIX: routeStops carry the SAME prefixed shape_id, so the timetable can
    // match them to the trips' shape (orderedStops would otherwise be empty).
    for (const rs of importedRouteStops) {
      expect(rs.shape_id).toBe('i2_SH1');
    }
  });
});
