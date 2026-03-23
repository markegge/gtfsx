/**
 * Comprehensive integration tests for GTFS Builder.
 * Run in browser console via: window.__runTests()
 *
 * Tests import a real GTFS feed (Pittsburgh Regional Transit),
 * then exercise modify/create/delete workflows across all entities.
 */

import { importGtfsZip, loadImportIntoStore } from '../services/gtfsImport';
import { exportGtfsZip } from '../services/gtfsExport';
import { runValidation } from '../services/validation';
import { useStore } from '../store';

interface TestResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, pass: condition, detail: detail || (condition ? 'OK' : 'FAILED') });
  if (!condition) console.error(`FAIL: ${name} — ${detail || ''}`);
}

function s() { return useStore.getState(); }

export async function runAllTests(zipFile: File): Promise<TestResult[]> {
  results.length = 0;
  console.log('=== GTFS Builder Test Suite ===');

  // =============================================
  // PHASE 1: IMPORT
  // =============================================
  console.log('\n--- Phase 1: Import ---');

  const data = await importGtfsZip(zipFile);
  loadImportIntoStore(data);

  assert('Import: agencies loaded', s().agencies.length === 1,
    `Expected 1, got ${s().agencies.length}`);
  assert('Import: agency name', s().agencies[0]?.agency_name === 'Pittsburgh Regional Transit');
  assert('Import: routes loaded', s().routes.length === 101,
    `Expected 101, got ${s().routes.length}`);
  assert('Import: stops loaded', s().stops.length === 6424,
    `Expected 6424, got ${s().stops.length}`);
  assert('Import: trips loaded', s().trips.length === 15826,
    `Expected 15826, got ${s().trips.length}`);
  assert('Import: calendars loaded', s().calendars.length === 7,
    `Expected 7, got ${s().calendars.length}`);
  assert('Import: shapes loaded', s().shapes.length > 0,
    `Expected >0, got ${s().shapes.length}`);
  assert('Import: stop_times loaded', s().stopTimes.length > 0,
    `Expected >0, got ${s().stopTimes.length}`);
  assert('Import: fare attributes loaded', s().fareAttributes.length > 0,
    `Expected >0, got ${s().fareAttributes.length}`);
  assert('Import: feed info loaded', s().feedInfo !== null);
  assert('Import: route stops built', s().routeStops.length > 0,
    `Expected >0, got ${s().routeStops.length}`);

  // =============================================
  // PHASE 2: QUERY & VERIFY DATA INTEGRITY
  // =============================================
  console.log('\n--- Phase 2: Data Integrity ---');

  // Check a specific route
  const route1 = s().routes.find(r => r.route_short_name === '1');
  assert('Integrity: Route 1 exists', !!route1);
  assert('Integrity: Route 1 name', route1?.route_long_name === 'FREEPORT ROAD');

  // Check trips reference valid routes
  const routeIds = new Set(s().routes.map(r => r.route_id));
  const orphanTrips = s().trips.filter(t => !routeIds.has(t.route_id));
  assert('Integrity: no orphan trips', orphanTrips.length === 0,
    `${orphanTrips.length} trips reference non-existent routes`);

  // Check trips reference valid calendars
  const serviceIds = new Set(s().calendars.map(c => c.service_id));
  const orphanCalTrips = s().trips.filter(t => !serviceIds.has(t.service_id));
  assert('Integrity: trips reference valid calendars', orphanCalTrips.length === 0,
    `${orphanCalTrips.length} trips reference non-existent service_ids`);

  // Check stop_times reference valid stops
  const stopIds = new Set(s().stops.map(st => st.stop_id));
  const badStopTimes = s().stopTimes.filter(st => !stopIds.has(st.stop_id)).length;
  assert('Integrity: stop_times reference valid stops', badStopTimes === 0,
    `${badStopTimes} stop_times reference non-existent stops`);

  // =============================================
  // PHASE 3: MODIFY AGENCY
  // =============================================
  console.log('\n--- Phase 3: Modify Agency ---');

  s().updateAgency(s().agencies[0].agency_id, { agency_phone: '412-555-1234' });
  assert('Agency: phone updated', s().agencies[0].agency_phone === '412-555-1234');

  s().updateFeedInfo({ feed_version: 'test-2026' });
  assert('FeedInfo: version updated', s().feedInfo?.feed_version === 'test-2026');

  // =============================================
  // PHASE 4: MODIFY CALENDARS
  // =============================================
  console.log('\n--- Phase 4: Modify Calendars ---');

  const originalCalCount = s().calendars.length;

  // Add a new service pattern
  s().addCalendar({
    service_id: 'test-summer',
    monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 1, sunday: 0,
    start_date: '20260601', end_date: '20260831',
    _description: 'Summer Weekdays+Sat',
  });
  assert('Calendar: add service pattern', s().calendars.length === originalCalCount + 1);

  // Add exception
  s().addCalendarDate({ service_id: 'test-summer', date: '20260704', exception_type: 2 });
  const summerExceptions = s().calendarDates.filter(cd => cd.service_id === 'test-summer');
  assert('Calendar: add exception', summerExceptions.length === 1);

  // Modify existing calendar
  const firstCal = s().calendars[0];
  s().updateCalendar(firstCal.service_id, { _description: 'Modified Weekdays' });
  assert('Calendar: modify description',
    s().calendars.find(c => c.service_id === firstCal.service_id)?._description === 'Modified Weekdays');

  // =============================================
  // PHASE 5: MODIFY ROUTES
  // =============================================
  console.log('\n--- Phase 5: Modify Routes ---');

  const originalRouteCount = s().routes.length;

  // Modify route color
  if (route1) {
    s().updateRoute(route1.route_id, { route_color: 'FF0000', route_desc: 'Modified by test' });
    const updated = s().routes.find(r => r.route_id === route1.route_id);
    assert('Route: color updated', updated?.route_color === 'FF0000');
    assert('Route: desc updated', updated?.route_desc === 'Modified by test');
  }

  // Add a new route
  s().addRoute({
    route_id: 'test-new-route',
    agency_id: 'PRT',
    route_short_name: 'T99',
    route_long_name: 'TEST EXPRESS',
    route_type: 3,
    route_color: '00FF00',
    route_text_color: '000000',
  });
  assert('Route: add new route', s().routes.length === originalRouteCount + 1);
  assert('Route: new route findable',
    !!s().routes.find(r => r.route_id === 'test-new-route'));

  // =============================================
  // PHASE 6: MODIFY STOPS
  // =============================================
  console.log('\n--- Phase 6: Modify Stops ---');

  const originalStopCount = s().stops.length;

  // Add a new stop
  s().addStop({
    stop_id: 'test-stop-1',
    stop_name: 'Test Stop Alpha',
    stop_lat: 40.4406,
    stop_lon: -79.9959,
    location_type: 0,
    wheelchair_boarding: 1,
  });
  assert('Stop: add new stop', s().stops.length === originalStopCount + 1);

  // Modify existing stop
  const firstStop = s().stops[0];
  const origStopName = firstStop.stop_name;
  s().updateStop(firstStop.stop_id, { stop_name: 'MODIFIED STOP NAME' });
  assert('Stop: modify name',
    s().stops.find(st => st.stop_id === firstStop.stop_id)?.stop_name === 'MODIFIED STOP NAME');

  // Restore original name
  s().updateStop(firstStop.stop_id, { stop_name: origStopName });

  // Link new stop to new route
  s().addRouteStop({
    route_id: 'test-new-route',
    stop_id: 'test-stop-1',
    direction_id: 0,
    stop_sequence: 0,
    _snapped: false,
  });
  const newRouteStops = s().routeStops.filter(rs => rs.route_id === 'test-new-route');
  assert('Stop: link to new route', newRouteStops.length === 1);

  // =============================================
  // PHASE 7: MODIFY TIMETABLES
  // =============================================
  console.log('\n--- Phase 7: Modify Timetables ---');

  const originalTripCount = s().trips.length;

  // Add a trip to the new route
  s().addTrip({
    trip_id: 'test-trip-1',
    route_id: 'test-new-route',
    service_id: 'test-summer',
    direction_id: 0,
    trip_headsign: 'Test Downtown',
  });
  assert('Trip: add new trip', s().trips.length === originalTripCount + 1);

  // Add stop times
  s().setStopTime('test-trip-1', 'test-stop-1', 0, {
    arrival_time: '08:00:00',
    departure_time: '08:00:00',
    timepoint: 1,
  });
  const testStopTimes = s().stopTimes.filter(st => st.trip_id === 'test-trip-1');
  assert('Trip: add stop time', testStopTimes.length === 1);
  assert('Trip: stop time value', testStopTimes[0]?.arrival_time === '08:00:00');

  // Modify an existing trip's stop time
  const existingTrip = s().trips.find(t => t.route_id === route1?.route_id);
  if (existingTrip) {
    const existingST = s().stopTimes.find(st => st.trip_id === existingTrip.trip_id);
    if (existingST) {
      const origTime = existingST.arrival_time;
      s().setStopTime(existingTrip.trip_id, existingST.stop_id, existingST.stop_sequence, {
        arrival_time: '05:30:00',
        departure_time: '05:30:00',
      });
      const modified = s().stopTimes.find(
        st => st.trip_id === existingTrip.trip_id && st.stop_id === existingST.stop_id
      );
      assert('Trip: modify existing stop time', modified?.arrival_time === '05:30:00');

      // Restore
      s().setStopTime(existingTrip.trip_id, existingST.stop_id, existingST.stop_sequence, {
        arrival_time: origTime,
        departure_time: origTime,
      });
    }
  }

  // Duplicate a trip
  s().duplicateTrip('test-trip-1', 'test-trip-2', 30);
  assert('Trip: duplicate', s().trips.some(t => t.trip_id === 'test-trip-2'));
  const dupStopTimes = s().stopTimes.filter(st => st.trip_id === 'test-trip-2');
  assert('Trip: duplicate stop times copied', dupStopTimes.length === 1);
  assert('Trip: duplicate time offset', dupStopTimes[0]?.arrival_time === '08:30:00');

  // Delete a trip
  s().removeTrip('test-trip-2');
  assert('Trip: delete', !s().trips.some(t => t.trip_id === 'test-trip-2'));
  assert('Trip: delete cleans stop times',
    s().stopTimes.filter(st => st.trip_id === 'test-trip-2').length === 0);

  // =============================================
  // PHASE 8: MODIFY FARES
  // =============================================
  console.log('\n--- Phase 8: Modify Fares ---');

  const originalFareCount = s().fareAttributes.length;

  s().addFareAttribute({
    fare_id: 'test-fare',
    price: '2.75',
    currency_type: 'USD',
    payment_method: 0,
    transfers: 1,
    transfer_duration: 7200,
  });
  assert('Fare: add attribute', s().fareAttributes.length === originalFareCount + 1);

  s().addFareRule({ fare_id: 'test-fare', route_id: 'test-new-route' });
  assert('Fare: add rule', s().fareRules.some(
    fr => fr.fare_id === 'test-fare' && fr.route_id === 'test-new-route'));

  // =============================================
  // PHASE 9: VALIDATION
  // =============================================
  console.log('\n--- Phase 9: Validation ---');

  const messages = runValidation(s());
  const errors = messages.filter(m => m.severity === 'error');
  const warnings = messages.filter(m => m.severity === 'warning');
  assert('Validation: no errors', errors.length === 0,
    errors.length > 0 ? `Errors: ${errors.map(e => e.message).join('; ')}` : 'OK');
  console.log(`  ${warnings.length} warnings, ${errors.length} errors`);

  // =============================================
  // PHASE 10: EXPORT & RE-IMPORT (ROUND-TRIP)
  // =============================================
  console.log('\n--- Phase 10: Export & Round-trip ---');

  const blob = await exportGtfsZip();
  assert('Export: produces ZIP', blob.size > 1000,
    `ZIP size: ${blob.size} bytes`);

  // Save current state counts
  const preRoutes = s().routes.length;
  const preStops = s().stops.length;
  const preTrips = s().trips.length;
  const preFares = s().fareAttributes.length;

  // Re-import the exported ZIP
  const exportedFile = new File([blob], 'test-export.zip', { type: 'application/zip' });
  const reimported = await importGtfsZip(exportedFile);
  loadImportIntoStore(reimported);

  assert('Round-trip: routes preserved', s().routes.length === preRoutes,
    `Expected ${preRoutes}, got ${s().routes.length}`);
  assert('Round-trip: stops preserved', s().stops.length === preStops,
    `Expected ${preStops}, got ${s().stops.length}`);
  assert('Round-trip: trips preserved', s().trips.length === preTrips,
    `Expected ${preTrips}, got ${s().trips.length}`);
  assert('Round-trip: fares preserved', s().fareAttributes.length === preFares,
    `Expected ${preFares}, got ${s().fareAttributes.length}`);

  // Verify modifications survived round-trip
  assert('Round-trip: agency phone preserved', s().agencies[0]?.agency_phone === '412-555-1234');
  assert('Round-trip: feed version preserved', s().feedInfo?.feed_version === 'test-2026');
  assert('Round-trip: new route preserved',
    !!s().routes.find(r => r.route_id === 'test-new-route'));
  assert('Round-trip: route color preserved',
    s().routes.find(r => r.route_id === route1?.route_id)?.route_color === 'FF0000');

  // Post round-trip validation
  const postMessages = runValidation(s());
  const postErrors = postMessages.filter(m => m.severity === 'error');
  assert('Round-trip: no validation errors', postErrors.length === 0,
    postErrors.length > 0 ? `Errors: ${postErrors.map(e => e.message).join('; ')}` : 'OK');

  // =============================================
  // PHASE 11: DELETE OPERATIONS
  // =============================================
  console.log('\n--- Phase 11: Delete Operations ---');

  // Delete the test route (should cascade to route stops)
  s().removeRoute('test-new-route');
  assert('Delete: route removed', !s().routes.some(r => r.route_id === 'test-new-route'));
  assert('Delete: route stops cascaded',
    s().routeStops.filter(rs => rs.route_id === 'test-new-route').length === 0);

  // Delete the test stop
  s().removeStop('test-stop-1');
  assert('Delete: stop removed', !s().stops.some(st => st.stop_id === 'test-stop-1'));

  // Delete test calendar (should cascade to calendar dates)
  s().removeCalendar('test-summer');
  assert('Delete: calendar removed', !s().calendars.some(c => c.service_id === 'test-summer'));
  assert('Delete: calendar dates cascaded',
    s().calendarDates.filter(cd => cd.service_id === 'test-summer').length === 0);

  // =============================================
  // SUMMARY
  // =============================================
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${results.length} tests ===`);
  if (failed > 0) {
    console.log('FAILURES:');
    results.filter(r => !r.pass).forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
  }

  return results;
}
