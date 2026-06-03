/**
 * Run GTFS·X integration tests headlessly via tsx.
 * Usage: npx tsx run-tests.ts
 *
 * Fixture is built in-memory from `streamline_gtfs_march_2026/` so the test
 * is self-contained on a fresh checkout (and in CI). No external zips required.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { importGtfsZip, loadImportIntoStore } from './src/services/gtfsImport';
import { exportGtfsZip } from './src/services/gtfsExport';
import { runValidation } from './src/services/validation';
import {
  computeStopSpacing, computeBalancingCandidates, computeServiceIntensity,
  computeAccessibilityAudit, representativeDay,
} from './src/services/stopAnalysis';
import { useStore } from './src/store';
import { getUSHolidaysForYear, getUSHolidaysInRange } from './src/utils/holidays';
import { pointInPolygon } from './src/utils/geometry';
import { stopsInsidePolygon } from './src/components/fares/fareZoneHelpers';
import { computeShapePatterns } from './src/components/ui/shapePatterns';
import type { RouteStop, Stop, Trip } from './src/types/gtfs';

const FIXTURE_DIR = 'streamline_gtfs_march_2026';

async function buildFixtureZip(): Promise<Buffer> {
  const zip = new JSZip();
  for (const name of readdirSync(FIXTURE_DIR)) {
    const full = path.join(FIXTURE_DIR, name);
    if (!statSync(full).isFile() || !name.endsWith('.txt')) continue;
    zip.file(name, readFileSync(full));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Synthetic feed exercising the spec-completeness bundle (#12/#13/#16/#17):
 *  - a headway trip (T_FREQ) with two non-overlapping frequencies windows,
 *    exact_times present only on the 2nd row;
 *  - a station with two levels + pathways, and child platform stops carrying
 *    level_id (regular stops listed first so level_id is absent on row 0 —
 *    exercises the toCSV union-of-columns round-trip fix);
 *  - two trips (T_BLK_A/T_BLK_B) sharing block BLOCK1 with overlapping spans;
 *  - a Saturday service (SAT) spanning 2026-07-04 (Independence Day, a Saturday).
 * Reused by the round-trip and validation phases below.
 */
async function buildBundleFixtureZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('agency.txt',
    'agency_id,agency_name,agency_url,agency_timezone\n' +
    'A1,Bundle Test,https://example.com,America/Denver\n');
  zip.file('routes.txt',
    'route_id,agency_id,route_short_name,route_long_name,route_type\n' +
    'R1,A1,1,Main Line,3\n');
  zip.file('stops.txt',
    'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,level_id\n' +
    'S1,First St,45.6770,-111.0429,0,,\n' +
    'S2,Second St,45.6800,-111.0400,0,,\n' +
    'STATION,Transit Center,45.6790,-111.0410,1,,\n' +
    'PLAT_A,TC Platform A,45.6791,-111.0411,0,STATION,L_CONCOURSE\n' +
    'PLAT_B,TC Platform B,45.6792,-111.0412,0,STATION,L_PLATFORM\n');
  zip.file('levels.txt',
    'level_id,level_index,level_name\n' +
    'L_PLATFORM,-1,Platform\n' +
    'L_CONCOURSE,0,Concourse\n');
  zip.file('pathways.txt',
    'pathway_id,from_stop_id,to_stop_id,pathway_mode,is_bidirectional,length,traversal_time,stair_count\n' +
    'PW1,STATION,PLAT_A,5,1,,,\n' +
    'PW2,PLAT_A,PLAT_B,2,1,12.5,40,18\n');
  zip.file('calendar.txt',
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
    'WKDY,1,1,1,1,1,0,0,20260101,20271231\n' +
    'SAT,0,0,0,0,0,1,0,20260101,20261231\n');
  zip.file('trips.txt',
    'route_id,service_id,trip_id,block_id\n' +
    'R1,WKDY,T_FREQ,\n' +
    'R1,WKDY,T_BLK_A,BLOCK1\n' +
    'R1,WKDY,T_BLK_B,BLOCK1\n' +
    'R1,SAT,T_SAT,\n');
  zip.file('stop_times.txt',
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' +
    'T_FREQ,06:00:00,06:00:00,S1,1\n' +
    'T_FREQ,06:30:00,06:30:00,S2,2\n' +
    'T_BLK_A,08:00:00,08:00:00,S1,1\n' +
    'T_BLK_A,08:30:00,08:30:00,S2,2\n' +
    'T_BLK_B,08:15:00,08:15:00,S1,1\n' +
    'T_BLK_B,08:45:00,08:45:00,S2,2\n' +
    'T_SAT,09:00:00,09:00:00,S1,1\n' +
    'T_SAT,09:30:00,09:30:00,S2,2\n');
  zip.file('frequencies.txt',
    'trip_id,start_time,end_time,headway_secs,exact_times\n' +
    'T_FREQ,06:00:00,09:00:00,600,\n' +
    'T_FREQ,15:00:00,19:00:00,1200,1\n');
  return zip.generateAsync({ type: 'nodebuffer' });
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = `  ✗ ${name}${detail ? ': ' + detail : ''}`;
    console.log(msg);
    failures.push(msg);
  }
}

function s() { return useStore.getState(); }

async function main() {
  console.log('=== GTFS·X Integration Tests ===\n');

  // Build fixture zip from the in-repo streamline (BOZEMAN) feed.
  const zipBuffer = await buildFixtureZip();
  const zipFile = zipBuffer as unknown as File;

  // ---- PHASE 1: IMPORT ----
  console.log('Phase 1: Import Streamline (BOZEMAN) GTFS');
  const data = await importGtfsZip(zipFile);
  loadImportIntoStore(data);

  assert('agencies loaded', s().agencies.length === 1, `got ${s().agencies.length}`);
  assert('agency name correct', s().agencies[0]?.agency_name === 'BOZEMAN');
  assert('routes loaded (8)', s().routes.length === 8, `got ${s().routes.length}`);
  assert('stops loaded (166)', s().stops.length === 166, `got ${s().stops.length}`);
  assert('trips loaded (214)', s().trips.length === 214, `got ${s().trips.length}`);
  assert('calendars loaded (2)', s().calendars.length === 2, `got ${s().calendars.length}`);
  assert('shapes loaded', s().shapes.length > 0, `got ${s().shapes.length}`);
  assert('stop_times loaded', s().stopTimes.length > 0, `got ${s().stopTimes.length}`);
  // streamline has no fare_attributes.txt — fare round-trip is exercised separately in phase 12
  assert('feed info loaded', s().feedInfo !== null);
  assert('route stops built', s().routeStops.length > 0, `got ${s().routeStops.length}`);

  // ---- PHASE 2: DATA INTEGRITY ----
  console.log('\nPhase 2: Data Integrity');
  const blueline = s().routes.find(r => r.route_short_name === 'Blueline');
  assert('Blueline route exists', !!blueline);
  assert('Blueline long name = Blueline', blueline?.route_long_name === 'Blueline');

  const routeIds = new Set(s().routes.map(r => r.route_id));
  const orphanTrips = s().trips.filter(t => !routeIds.has(t.route_id));
  assert('no orphan trips', orphanTrips.length === 0, `${orphanTrips.length} orphans`);

  const serviceIds = new Set(s().calendars.map(c => c.service_id));
  const badCalTrips = s().trips.filter(t => !serviceIds.has(t.service_id));
  assert('trips reference valid calendars', badCalTrips.length === 0, `${badCalTrips.length} bad refs`);

  const stopIdSet = new Set(s().stops.map(st => st.stop_id));
  const badST = s().stopTimes.filter(st => !stopIdSet.has(st.stop_id)).length;
  assert('stop_times reference valid stops', badST === 0, `${badST} bad refs`);

  // ---- PHASE 2.5: STOP ANALYSIS (features 1–4 smoke on the pristine feed) ----
  console.log('\nPhase 2.5: Stop Analysis');
  const rep = representativeDay(s());
  assert('stop-analysis: representative day picked', !!rep.weekday, `weekday=${rep.weekday}`);
  assert('stop-analysis: active service ids', rep.serviceIds.size > 0, `${rep.serviceIds.size}`);

  // Feature 1 — spacing
  const spacing = computeStopSpacing(s());
  assert('spacing: segments computed', spacing.pairCount > 0, `${spacing.pairCount}`);
  assert('spacing: median positive', (spacing.medianFt ?? 0) > 0, `${spacing.medianFt}`);
  assert('spacing: per-route rows', spacing.perRoute.length > 0, `${spacing.perRoute.length}`);
  assert('spacing: benchmark counts sum ≤ total',
    spacing.tooCloseCount + spacing.inTargetCount + spacing.aboveMaxCount <= spacing.pairCount);

  // Feature 2 — balancing (a valid feed may legitimately have 0 candidates;
  // assert the result is well-formed and that a generous threshold finds some).
  const balancing = computeBalancingCandidates(s(), { thresholdFt: 600, dwellSeconds: 18, serviceIds: rep.serviceIds });
  assert('balancing: result well-formed', Array.isArray(balancing.candidates));
  const balancingLoose = computeBalancingCandidates(s(), { thresholdFt: 1500, dwellSeconds: 18, serviceIds: rep.serviceIds });
  assert('balancing: finds candidates at 1500 ft', balancingLoose.candidates.length > 0, `${balancingLoose.candidates.length}`);
  assert('balancing: savings = dwell × trips/day',
    balancingLoose.candidates.every(c => c.savingsSecPerDay === 18 * c.tripsPerDay));
  console.log(`    (balancing: ${balancing.candidates.length} pairs <600 ft, ${balancingLoose.candidates.length} <1500 ft)`);

  // Feature 3 — service intensity
  const intensity = computeServiceIntensity(s(), { serviceIds: rep.serviceIds });
  assert('intensity: served stops', intensity.length > 0, `${intensity.length}`);
  assert('intensity: trips/day positive', intensity.every(i => i.tripsPerDay > 0));
  // Sum of per-stop trips/day (distinct trips at each stop) = number of
  // distinct (trip, stop) pairs over active trips. NOT raw stop_times: loop
  // routes revisit a stop within one trip, which tripsPerDay dedupes.
  const activeTripIds = new Set(s().trips.filter(t => rep.serviceIds.has(t.service_id)).map(t => t.trip_id));
  const distinctVisits = new Set<string>();
  for (const st of s().stopTimes) if (activeTripIds.has(st.trip_id)) distinctVisits.add(`${st.trip_id} ${st.stop_id}`);
  const summedTripsPerDay = intensity.reduce((a, i) => a + i.tripsPerDay, 0);
  assert('intensity: trips/day sum = distinct (trip,stop) visits', summedTripsPerDay === distinctVisits.size,
    `sum=${summedTripsPerDay} visits=${distinctVisits.size}`);

  // Feature 4 — accessibility
  const access = computeAccessibilityAudit(s());
  assert('accessibility: counts board points', access.totalStops > 0, `${access.totalStops}`);
  assert('accessibility: pct in [0,100]', access.pctPopulated >= 0 && access.pctPopulated <= 100, `${access.pctPopulated}`);
  assert('accessibility: populated + gaps = total', access.populatedCount + access.gapCount === access.totalStops);

  // ---- PHASE 3: MODIFY AGENCY ----
  console.log('\nPhase 3: Modify Agency');
  s().updateAgency(s().agencies[0].agency_id, { agency_phone: '406-555-1234' });
  assert('phone updated', s().agencies[0].agency_phone === '406-555-1234');
  s().updateFeedInfo({ feed_version: 'test-2026' });
  assert('feed version updated', s().feedInfo?.feed_version === 'test-2026');

  // ---- PHASE 4: MODIFY CALENDARS ----
  console.log('\nPhase 4: Modify Calendars');
  const origCalCount = s().calendars.length;
  s().addCalendar({
    service_id: 'test-summer', monday: 1, tuesday: 1, wednesday: 1, thursday: 1,
    friday: 1, saturday: 1, sunday: 0, start_date: '20260601', end_date: '20260831',
    _description: 'Summer Weekdays+Sat',
  });
  assert('add calendar', s().calendars.length === origCalCount + 1);
  s().addCalendarDate({ service_id: 'test-summer', date: '20260704', exception_type: 2 });
  assert('add exception', s().calendarDates.filter(cd => cd.service_id === 'test-summer').length === 1);
  s().updateCalendar(s().calendars[0].service_id, { _description: 'Modified' });
  assert('modify calendar', s().calendars[0]._description === 'Modified');

  // ---- PHASE 5: MODIFY ROUTES ----
  console.log('\nPhase 5: Modify Routes');
  const origRouteCount = s().routes.length;
  if (blueline) {
    s().updateRoute(blueline.route_id, { route_color: 'FF0000', route_desc: 'Test modified' });
    assert('route color updated', s().routes.find(r => r.route_id === blueline.route_id)?.route_color === 'FF0000');
  }
  s().addRoute({
    route_id: 'test-route', agency_id: '260', route_short_name: 'T99',
    route_long_name: 'TEST EXPRESS', route_type: 3, route_color: '00FF00', route_text_color: '000000',
  });
  assert('add route', s().routes.length === origRouteCount + 1);

  // ---- PHASE 6: MODIFY STOPS ----
  console.log('\nPhase 6: Modify Stops');
  const origStopCount = s().stops.length;
  s().addStop({
    stop_id: 'test-stop', stop_name: 'Test Stop', stop_lat: 40.4406, stop_lon: -79.9959,
    location_type: 0, wheelchair_boarding: 1,
  });
  assert('add stop', s().stops.length === origStopCount + 1);
  s().updateStop(s().stops[0].stop_id, { stop_name: 'MODIFIED' });
  assert('modify stop', s().stops[0].stop_name === 'MODIFIED');
  s().addRouteStop({
    route_id: 'test-route', stop_id: 'test-stop', direction_id: 0, stop_sequence: 0, _snapped: false,
  });
  assert('link stop to route', s().routeStops.filter(rs => rs.route_id === 'test-route').length === 1);

  // ---- PHASE 7: MODIFY TIMETABLES ----
  console.log('\nPhase 7: Modify Timetables');
  const origTripCount = s().trips.length;
  s().addTrip({
    trip_id: 'test-trip-1', route_id: 'test-route', service_id: 'test-summer',
    direction_id: 0, trip_headsign: 'Test Downtown',
  });
  assert('add trip', s().trips.length === origTripCount + 1);

  s().setStopTime('test-trip-1', 'test-stop', 0, {
    arrival_time: '08:00:00', departure_time: '08:00:00', timepoint: 1,
  });
  assert('add stop time', s().stopTimes.filter(st => st.trip_id === 'test-trip-1').length === 1);

  // Modify existing trip
  const existTrip = s().trips.find(t => t.route_id === blueline?.route_id);
  if (existTrip) {
    const existST = s().stopTimes.find(st => st.trip_id === existTrip.trip_id);
    if (existST) {
      const orig = existST.arrival_time;
      s().setStopTime(existTrip.trip_id, existST.stop_id, existST.stop_sequence, {
        arrival_time: '05:30:00', departure_time: '05:30:00',
      });
      assert('modify stop time', s().stopTimes.find(
        st => st.trip_id === existTrip.trip_id && st.stop_id === existST.stop_id
      )?.arrival_time === '05:30:00');
      s().setStopTime(existTrip.trip_id, existST.stop_id, existST.stop_sequence, {
        arrival_time: orig, departure_time: orig,
      });
    }
  }

  // Duplicate trip
  s().duplicateTrip('test-trip-1', 'test-trip-2', 30);
  assert('duplicate trip exists', s().trips.some(t => t.trip_id === 'test-trip-2'));
  assert('duplicate offset correct',
    s().stopTimes.find(st => st.trip_id === 'test-trip-2')?.arrival_time === '08:30:00');

  // Delete trip
  s().removeTrip('test-trip-2');
  assert('delete trip', !s().trips.some(t => t.trip_id === 'test-trip-2'));
  assert('delete cascades stop times', s().stopTimes.filter(st => st.trip_id === 'test-trip-2').length === 0);

  // ---- PHASE 8: FARES ----
  console.log('\nPhase 8: Modify Fares');
  const origFareCount = s().fareAttributes.length;
  s().addFareAttribute({
    fare_id: 'test-fare', price: '2.75', currency_type: 'USD',
    payment_method: 0, transfers: 1, transfer_duration: 7200,
  });
  assert('add fare', s().fareAttributes.length === origFareCount + 1);
  s().addFareRule({ fare_id: 'test-fare', route_id: 'test-route' });
  assert('add fare rule', s().fareRules.some(fr => fr.fare_id === 'test-fare'));

  // ---- PHASE 9: VALIDATION ----
  console.log('\nPhase 9: Validation');
  const msgs = runValidation(s());
  const errors = msgs.filter(m => m.severity === 'error');
  assert('no validation errors', errors.length === 0,
    errors.map(e => e.message).join('; '));

  // ---- PHASE 10: EXPORT & ROUND-TRIP ----
  console.log('\nPhase 10: Export & Round-trip');
  const blob = await exportGtfsZip();
  assert('export produces ZIP', blob.size > 1000, `size: ${blob.size}`);

  const preRoutes = s().routes.length;
  const preStops = s().stops.length;
  const preTrips = s().trips.length;

  const reBuffer = Buffer.from(await blob.arrayBuffer());
  const reFile = reBuffer as unknown as File;
  const reimported = await importGtfsZip(reFile);
  loadImportIntoStore(reimported);

  assert('round-trip routes', s().routes.length === preRoutes, `${preRoutes} → ${s().routes.length}`);
  assert('round-trip stops', s().stops.length === preStops, `${preStops} → ${s().stops.length}`);
  assert('round-trip trips', s().trips.length === preTrips, `${preTrips} → ${s().trips.length}`);
  assert('round-trip agency phone', s().agencies[0]?.agency_phone === '406-555-1234');
  assert('round-trip new route', !!s().routes.find(r => r.route_id === 'test-route'));
  assert('round-trip route color', s().routes.find(r => r.route_id === blueline?.route_id)?.route_color === 'FF0000');

  const postErrors = runValidation(s()).filter(m => m.severity === 'error');
  assert('round-trip no errors', postErrors.length === 0,
    postErrors.map(e => e.message).join('; '));

  // ---- PHASE 11: DELETES ----
  console.log('\nPhase 11: Delete Operations (with cascading)');
  const preDeleteTrips = s().trips.length;
  s().removeRoute('test-route');
  assert('delete route', !s().routes.some(r => r.route_id === 'test-route'));
  assert('delete cascades routeStops', s().routeStops.filter(rs => rs.route_id === 'test-route').length === 0);
  assert('delete cascades trips', s().trips.filter(t => t.route_id === 'test-route').length === 0);
  assert('delete cascades stopTimes', s().trips.length < preDeleteTrips);
  assert('delete cascades fareRules', s().fareRules.filter(fr => fr.route_id === 'test-route').length === 0);

  // Verify no orphan trips after delete
  const routeIdSet2 = new Set(s().routes.map(r => r.route_id));
  const orphansAfter = s().trips.filter(t => !routeIdSet2.has(t.route_id));
  assert('no orphan trips after delete', orphansAfter.length === 0, `${orphansAfter.length} orphans`);

  s().removeStop('test-stop');
  assert('delete stop', !s().stops.some(st => st.stop_id === 'test-stop'));
  s().removeCalendar('test-summer');
  assert('delete calendar', !s().calendars.some(c => c.service_id === 'test-summer'));
  assert('delete cascades dates', s().calendarDates.filter(cd => cd.service_id === 'test-summer').length === 0);

  // ---- PHASE 12: GTFS-Fares v2 round-trip ----
  // Build a minimal synthetic v2 feed in-memory and verify every v2 file
  // survives import → export → re-import without data loss. No editor UI yet
  // (Phase 1 scope is round-trip only); this test guards against regressions
  // in the import/export plumbing.
  console.log('\nPhase 12: GTFS-Fares v2 round-trip');
  const JSZip = (await import('jszip')).default;
  const v2zip = new JSZip();
  // Minimum-viable feed scaffolding so importGtfsZip parses without warnings.
  v2zip.file('agency.txt', 'agency_id,agency_name,agency_url,agency_timezone\nA1,Test Agency,https://example.com,America/Los_Angeles\n');
  v2zip.file('routes.txt', 'route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A1,1,Test Route,3\n');
  v2zip.file('stops.txt', 'stop_id,stop_name,stop_lat,stop_lon\nS1,Stop One,37.7749,-122.4194\nS2,Stop Two,37.7849,-122.4094\n');
  v2zip.file('calendar.txt', 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWKDY,1,1,1,1,1,0,0,20260101,20261231\n');
  v2zip.file('trips.txt', 'route_id,service_id,trip_id\nR1,WKDY,T1\n');
  v2zip.file('stop_times.txt', 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,S1,1\nT1,08:10:00,08:10:00,S2,2\n');
  // v2 fare data — one row per file that exercises the typed columns.
  v2zip.file('areas.txt', 'area_id,area_name\nDOWNTOWN,Downtown\nSUBURBAN,Suburban\n');
  v2zip.file('stop_areas.txt', 'area_id,stop_id\nDOWNTOWN,S1\nSUBURBAN,S2\n');
  v2zip.file('networks.txt', 'network_id,network_name\nBUS,Bus Network\n');
  v2zip.file('route_networks.txt', 'network_id,route_id\nBUS,R1\n');
  v2zip.file('timeframes.txt', 'timeframe_group_id,start_time,end_time,service_id\nPEAK,06:00:00,09:00:00,WKDY\nPEAK,15:00:00,19:00:00,WKDY\n');
  v2zip.file('rider_categories.txt', 'rider_category_id,rider_category_name,is_default_fare_category,eligibility_url\nADULT,Adult,1,\nSENIOR,Senior,0,https://example.com/senior\n');
  v2zip.file('fare_media.txt', 'fare_media_id,fare_media_name,fare_media_type\nCASH,Cash,0\nCARD,Smart Card,2\nCEMV,Contactless,3\n');
  v2zip.file('fare_products.txt', 'fare_product_id,fare_product_name,rider_category_id,fare_media_id,amount,currency\nSINGLE,Single Ride,ADULT,CASH,2.50,USD\nSENIOR_SINGLE,Senior Single,SENIOR,CARD,1.25,USD\n');
  v2zip.file('fare_leg_rules.txt', 'leg_group_id,network_id,from_area_id,to_area_id,from_timeframe_group_id,to_timeframe_group_id,fare_product_id,rule_priority\nLG_BUS,BUS,,,PEAK,,SINGLE,1\n');
  v2zip.file('fare_transfer_rules.txt', 'from_leg_group_id,to_leg_group_id,transfer_count,duration_limit,duration_limit_type,fare_transfer_type,fare_product_id\nLG_BUS,LG_BUS,-1,5400,1,0,\n');

  const v2bytes = await v2zip.generateAsync({ type: 'nodebuffer' });
  const v2File = v2bytes as unknown as File;
  const v2data = await importGtfsZip(v2File);
  loadImportIntoStore(v2data);

  assert('v2 import: 2 areas', s().fareAreas.length === 2, `got ${s().fareAreas.length}`);
  assert('v2 import: 2 stop_areas', s().stopAreas.length === 2, `got ${s().stopAreas.length}`);
  assert('v2 import: 1 network', s().fareNetworks.length === 1, `got ${s().fareNetworks.length}`);
  assert('v2 import: 1 route_network', s().routeNetworks.length === 1, `got ${s().routeNetworks.length}`);
  assert('v2 import: 2 timeframes (PEAK)', s().timeframes.length === 2, `got ${s().timeframes.length}`);
  assert('v2 import: 2 rider categories', s().riderCategories.length === 2, `got ${s().riderCategories.length}`);
  assert('v2 import: 3 fare media', s().fareMedia.length === 3, `got ${s().fareMedia.length}`);
  assert('v2 import: 2 fare products', s().fareProducts.length === 2, `got ${s().fareProducts.length}`);
  assert('v2 import: 1 leg rule', s().fareLegRules.length === 1, `got ${s().fareLegRules.length}`);
  assert('v2 import: 1 transfer rule', s().fareTransferRules.length === 1, `got ${s().fareTransferRules.length}`);
  assert('v2 import: SINGLE amount preserved', s().fareProducts.find(p => p.fare_product_id === 'SINGLE')?.amount === '2.50');
  assert('v2 import: ADULT is default', s().riderCategories.find(c => c.rider_category_id === 'ADULT')?.is_default_fare_category === 1);
  assert('v2 import: cEMV media type=3', s().fareMedia.find(m => m.fare_media_id === 'CEMV')?.fare_media_type === 3);
  assert('v2 import: leg rule has PEAK timeframe', s().fareLegRules[0]?.from_timeframe_group_id === 'PEAK');
  assert('v2 import: transfer count -1 (unlimited)', s().fareTransferRules[0]?.transfer_count === -1);

  // Export and re-import — every count and key value should survive.
  const v2blob = await exportGtfsZip();
  const v2reBytes = Buffer.from(await v2blob.arrayBuffer());
  const v2reFile = v2reBytes as unknown as File;
  const v2re = await importGtfsZip(v2reFile);
  loadImportIntoStore(v2re);

  assert('v2 round-trip: areas', s().fareAreas.length === 2);
  assert('v2 round-trip: stop_areas', s().stopAreas.length === 2);
  assert('v2 round-trip: networks', s().fareNetworks.length === 1);
  assert('v2 round-trip: route_networks', s().routeNetworks.length === 1);
  assert('v2 round-trip: timeframes', s().timeframes.length === 2);
  assert('v2 round-trip: rider categories', s().riderCategories.length === 2);
  assert('v2 round-trip: fare media', s().fareMedia.length === 3);
  assert('v2 round-trip: fare products', s().fareProducts.length === 2);
  assert('v2 round-trip: leg rules', s().fareLegRules.length === 1);
  assert('v2 round-trip: transfer rules', s().fareTransferRules.length === 1);
  assert('v2 round-trip: SINGLE amount', s().fareProducts.find(p => p.fare_product_id === 'SINGLE')?.amount === '2.50');
  assert('v2 round-trip: ADULT default flag', s().riderCategories.find(c => c.rider_category_id === 'ADULT')?.is_default_fare_category === 1);
  assert('v2 round-trip: cEMV media type=3', s().fareMedia.find(m => m.fare_media_id === 'CEMV')?.fare_media_type === 3);
  assert('v2 round-trip: leg rule timeframe', s().fareLegRules[0]?.from_timeframe_group_id === 'PEAK');
  assert('v2 round-trip: transfer count -1', s().fareTransferRules[0]?.transfer_count === -1);

  // ---- PHASE 13: spec-completeness bundle round-trip (#12/#13 plumbing) ----
  console.log('\nPhase 13: frequencies / pathways / levels round-trip');
  const bundleBytes = await buildBundleFixtureZip();
  const bundleData = await importGtfsZip(bundleBytes as unknown as File);
  loadImportIntoStore(bundleData);

  assert('bundle import: 2 frequencies', s().frequencies.length === 2, `got ${s().frequencies.length}`);
  assert('bundle import: 2 levels', s().levels.length === 2, `got ${s().levels.length}`);
  assert('bundle import: 2 pathways', s().pathways.length === 2, `got ${s().pathways.length}`);
  assert('bundle import: stop level_id honored', s().stops.find(s2 => s2.stop_id === 'PLAT_A')?.level_id === 'L_CONCOURSE');
  assert('bundle import: block_id parsed', s().trips.find(t => t.trip_id === 'T_BLK_A')?.block_id === 'BLOCK1');
  assert('bundle import: exact_times on 2nd window', s().frequencies.find(f => f.start_time === '15:00:00')?.exact_times === 1);
  assert('bundle import: pathway optional cols', s().pathways.find(p => p.pathway_id === 'PW2')?.stair_count === 18);
  assert('bundle import: pathway PW1 optionals undefined', s().pathways.find(p => p.pathway_id === 'PW1')?.length === undefined);

  // Export → re-import. Optional columns absent on row 0 (exact_times, level_id,
  // pathway length/traversal/stairs) must survive via the toCSV column union.
  const bundleBlob = await exportGtfsZip();
  const bundleReBytes = Buffer.from(await bundleBlob.arrayBuffer());
  const bundleRe = await importGtfsZip(bundleReBytes as unknown as File);
  loadImportIntoStore(bundleRe);

  assert('bundle round-trip: 2 frequencies', s().frequencies.length === 2, `got ${s().frequencies.length}`);
  assert('bundle round-trip: 2 levels', s().levels.length === 2, `got ${s().levels.length}`);
  assert('bundle round-trip: 2 pathways', s().pathways.length === 2, `got ${s().pathways.length}`);
  assert('bundle round-trip: exact_times survived', s().frequencies.find(f => f.start_time === '15:00:00')?.exact_times === 1);
  assert('bundle round-trip: headway survived', s().frequencies.find(f => f.start_time === '06:00:00')?.headway_secs === 600);
  assert('bundle round-trip: level_id survived', s().stops.find(s2 => s2.stop_id === 'PLAT_B')?.level_id === 'L_PLATFORM');
  assert('bundle round-trip: level_index survived', s().levels.find(l => l.level_id === 'L_PLATFORM')?.level_index === -1);
  assert('bundle round-trip: pathway optionals survived', s().pathways.find(p => p.pathway_id === 'PW2')?.stair_count === 18);
  assert('bundle round-trip: pathway length survived', s().pathways.find(p => p.pathway_id === 'PW2')?.length === 12.5);
  assert('bundle round-trip: pathway mode survived', s().pathways.find(p => p.pathway_id === 'PW1')?.pathway_mode === 5);
  assert('bundle round-trip: block_id survived', s().trips.find(t => t.trip_id === 'T_BLK_A')?.block_id === 'BLOCK1');

  // ---- PHASE 14: bundle validation rules (#12/#13/#16/#17) ----
  console.log('\nPhase 14: validation rules (#12/#13/#16/#17)');
  // Reload a clean copy so prior phases don't bleed in.
  loadImportIntoStore(await importGtfsZip(await buildBundleFixtureZip() as unknown as File));
  let vmsgs = runValidation(s());
  const hasMsg = (sev: 'error' | 'warning', sub: string) =>
    vmsgs.some(m => m.severity === sev && m.message.includes(sub));

  // Positive baseline: the fixture's frequencies + pathways/levels are valid.
  assert('#12 valid windows: no frequency error', !hasMsg('error', 'frequency') && !hasMsg('error', 'Frequency'));
  assert('#13 valid pathways/levels: no FK/enum error',
    !hasMsg('error', 'Pathway') && !hasMsg('error', 'non-existent level_id'));
  // #16 — overlapping block trips warn (soft).
  assert('#16 block overlap warns', hasMsg('warning', 'block "BLOCK1"'));
  assert('#16 overlap is a warning not error', !hasMsg('error', 'block "BLOCK1"'));
  // #17 — Independence Day (Sat 2026-07-04) nudge on the Saturday service.
  assert('#17 Independence Day nudge fires', hasMsg('warning', 'Independence Day'));
  assert('#17 nudge is a warning not error', !hasMsg('error', 'Independence Day'));

  // #12 negatives — overlap, end<=start, headway<=0.
  s().setFrequencies([
    { trip_id: 'T_FREQ', start_time: '06:00:00', end_time: '09:00:00', headway_secs: 600 },
    { trip_id: 'T_FREQ', start_time: '08:30:00', end_time: '10:00:00', headway_secs: 600 }, // overlaps prev
    { trip_id: 'T_FREQ', start_time: '12:00:00', end_time: '11:00:00', headway_secs: 600 }, // end < start
    { trip_id: 'T_FREQ', start_time: '13:00:00', end_time: '14:00:00', headway_secs: 0 },   // headway 0
    { trip_id: 'GHOST',  start_time: '06:00:00', end_time: '07:00:00', headway_secs: 600 }, // bad trip FK
  ]);
  vmsgs = runValidation(s());
  assert('#12 overlap detected', hasMsg('error', 'overlapping frequency windows'));
  assert('#12 end<=start detected', hasMsg('error', 'at or before it starts'));
  assert('#12 headway>0 detected', hasMsg('error', 'headway_secs 0'));
  assert('#12 trip FK detected', hasMsg('error', 'Frequency references non-existent trip "GHOST"'));

  // #13 negatives — bad FK, out-of-range enums, dangling level_id.
  s().setLevels([{ level_id: 'L1', level_index: 0 }]);
  s().setPathways([
    { pathway_id: 'BAD1', from_stop_id: 'NOPE', to_stop_id: 'S1', pathway_mode: 9, is_bidirectional: 2 },
  ] as never);
  s().setStops(s().stops.map((st, i) => (i === 0 ? { ...st, level_id: 'GHOST' } : st)));
  vmsgs = runValidation(s());
  assert('#13 pathway bad from_stop', hasMsg('error', 'non-existent from_stop_id "NOPE"'));
  assert('#13 pathway_mode range', hasMsg('error', 'pathway_mode 9'));
  assert('#13 is_bidirectional range', hasMsg('error', 'is_bidirectional 2'));
  assert('#13 dangling level_id', hasMsg('error', 'non-existent level_id "GHOST"'));

  // #17 — adding a matching exception silences the nudge.
  loadImportIntoStore(await importGtfsZip(await buildBundleFixtureZip() as unknown as File));
  s().addCalendarDate({ service_id: 'SAT', date: '20260704', exception_type: 2 });
  vmsgs = runValidation(s());
  assert('#17 nudge cleared by exception', !hasMsg('warning', 'Independence Day'));

  // ---- PHASE 15: US holiday date math (#17) ----
  console.log('\nPhase 15: US holiday date math');
  const h2026 = getUSHolidaysForYear(2026);
  const dateOf = (year: number, name: string) => getUSHolidaysForYear(year).find(h => h.name === name)?.gtfsDate;
  assert('MLK 2026 = 3rd Mon Jan (01-19)', dateOf(2026, 'MLK Day') === '20260119', `got ${dateOf(2026, 'MLK Day')}`);
  assert('Memorial 2026 = last Mon May (05-25)', dateOf(2026, 'Memorial Day') === '20260525', `got ${dateOf(2026, 'Memorial Day')}`);
  assert('Labor 2026 = 1st Mon Sep (09-07)', dateOf(2026, 'Labor Day') === '20260907', `got ${dateOf(2026, 'Labor Day')}`);
  assert('Thanksgiving 2026 = 4th Thu Nov (11-26)', dateOf(2026, 'Thanksgiving') === '20261126', `got ${dateOf(2026, 'Thanksgiving')}`);
  assert('Juneteenth 2026 fixed (06-19)', dateOf(2026, 'Juneteenth') === '20260619');
  assert('Independence 2026 fixed (07-04)', dateOf(2026, 'Independence Day') === '20260704');
  assert('Independence 2026 falls on Saturday (dow=6)', h2026.find(h => h.name === 'Independence Day')?.dayOfWeek === 6);
  // Leap year — date math still correct in 2024.
  assert('MLK 2024 = 3rd Mon Jan (01-15)', dateOf(2024, 'MLK Day') === '20240115', `got ${dateOf(2024, 'MLK Day')}`);
  assert('Thanksgiving 2024 = 4th Thu Nov (11-28)', dateOf(2024, 'Thanksgiving') === '20241128', `got ${dateOf(2024, 'Thanksgiving')}`);
  // Multi-year range returns one entry per holiday per year.
  const range = getUSHolidaysInRange('20240101', '20261231');
  const julys = range.filter(h => h.name === 'Independence Day').map(h => h.gtfsDate).sort();
  assert('multi-year range: 3 Independence Days', julys.length === 3 && julys[0] === '20240704' && julys[2] === '20260704', julys.join(','));
  assert('range excludes out-of-bounds', !getUSHolidaysInRange('20260201', '20260601').some(h => h.name === 'Independence Day'));

  // ---- PHASE 16: fare-zone lasso geometry (#14) ----
  console.log('\nPhase 16: fare-zone lasso (stopsInsidePolygon)');
  const mkStop = (id: string, lon: number, lat: number): Stop =>
    ({ stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon, location_type: 0, wheelchair_boarding: 0 });
  const lassoStops: Stop[] = [
    mkStop('IN1', 5, 5),      // inside
    mkStop('IN2', 1, 1),      // inside
    mkStop('OUT1', 15, 5),    // east of the box
    mkStop('OUT2', 10.5, 5),  // just outside the east edge
    mkStop('OUT3', -1, -1),   // southwest of the box
  ];
  // Square box (0,0)–(10,10), closed ring, wrapped as a GeoJSON Feature<Polygon>.
  const box: GeoJSON.Feature<GeoJSON.Polygon> = {
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  };
  const inside = stopsInsidePolygon(lassoStops, box).sort();
  assert('lasso: only inside stops selected', JSON.stringify(inside) === JSON.stringify(['IN1', 'IN2']), inside.join(','));
  assert('pointInPolygon: center inside', pointInPolygon(5, 5, [[0, 0], [10, 0], [10, 10], [0, 10]]) === true);
  assert('pointInPolygon: far point outside', pointInPolygon(50, 50, [[0, 0], [10, 0], [10, 10], [0, 10]]) === false);
  assert('lasso: degenerate ring → empty', stopsInsidePolygon(lassoStops, { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } } as GeoJSON.Feature<GeoJSON.Polygon>).length === 0);

  // ---- PHASE 17: duplicateRoute remaps route_stops' shape_id ----
  // Regression for the bug where a duplicated route's cloned route_stops kept
  // the ORIGINAL shape_id. Since route stops are keyed per shape, the copy's
  // per-shape Stops panel/timetable then showed "No stops in this direction"
  // even though the badge counted them. Build a mini-feed whose route_stops
  // carry a shape_id matching the shape its trips use, duplicate it, and assert
  // the copy's route_stops resolve under the copy's OWN shapes.
  console.log('\nPhase 17: duplicateRoute remaps route_stops.shape_id');
  s().setRoutes([{ route_id: 'DUP_R', agency_id: 'A1', route_short_name: 'D', route_long_name: 'Dup Line', route_type: 3 }]);
  s().setShapes([{ shape_id: 'DUP_SHP', points: [
    { shape_pt_lat: 45.0, shape_pt_lon: -111.0, shape_pt_sequence: 1, shape_dist_traveled: 0 },
    { shape_pt_lat: 45.1, shape_pt_lon: -111.1, shape_pt_sequence: 2, shape_dist_traveled: 100 },
  ] }]);
  s().setTrips([{ trip_id: 'DUP_T1', route_id: 'DUP_R', service_id: 'WKDY', direction_id: 0, shape_id: 'DUP_SHP' }]);
  s().setStopTimes([
    { trip_id: 'DUP_T1', arrival_time: '08:00:00', departure_time: '08:00:00', stop_id: 'DUP_S1', stop_sequence: 1 },
    { trip_id: 'DUP_T1', arrival_time: '08:10:00', departure_time: '08:10:00', stop_id: 'DUP_S2', stop_sequence: 2 },
  ]);
  s().setRouteStops([
    { route_id: 'DUP_R', stop_id: 'DUP_S1', direction_id: 0, stop_sequence: 0, _snapped: true, shape_id: 'DUP_SHP' },
    { route_id: 'DUP_R', stop_id: 'DUP_S2', direction_id: 0, stop_sequence: 1, _snapped: true, shape_id: 'DUP_SHP' },
  ]);

  const dupId = s().duplicateRoute('DUP_R');
  assert('duplicateRoute returns a new id', !!dupId && dupId !== 'DUP_R', `got ${dupId}`);

  const copyRouteStops = s().routeStops.filter(rs => rs.route_id === dupId);
  const copyShapeIds = new Set(s().shapes
    .filter(sh => s().trips.some(t => t.route_id === dupId && t.shape_id === sh.shape_id))
    .map(sh => sh.shape_id));
  const copyTripShapeIds = new Set(s().trips.filter(t => t.route_id === dupId).map(t => t.shape_id));

  assert('copy has both route_stops', copyRouteStops.length === 2, `got ${copyRouteStops.length}`);
  // (a) none of the copy's route_stops point at the ORIGINAL shape_id.
  assert('copy route_stops no longer reference original shape_id',
    copyRouteStops.every(rs => rs.shape_id !== 'DUP_SHP'),
    copyRouteStops.map(rs => rs.shape_id).join(','));
  // (b) every copy route_stop shape_id matches the copy's own shapes AND its
  //     trips' shape_ids — i.e. the per-shape stop list resolves.
  assert('copy route_stops resolve under copy shapes',
    copyRouteStops.every(rs => !!rs.shape_id && copyShapeIds.has(rs.shape_id)),
    `routeStops=[${copyRouteStops.map(rs => rs.shape_id).join(',')}] shapes=[${[...copyShapeIds].join(',')}]`);
  assert('copy route_stops match copy trips\' shape_ids',
    copyRouteStops.every(rs => copyTripShapeIds.has(rs.shape_id)),
    `routeStops=[${copyRouteStops.map(rs => rs.shape_id).join(',')}] trips=[${[...copyTripShapeIds].join(',')}]`);

  // ---- PHASE 18: computeShapePatterns includes trip-less but stop-bearing shapes ----
  // A shape whose last trip was deleted must still surface as a pattern (so the
  // user can rebuild its timetable: remove all trips → add one → repeat). It
  // takes its direction from a routeStop; shapes with trips keep trip direction.
  console.log('\nPhase 18: computeShapePatterns unions trips + routeStops');
  const spTrips: Trip[] = [
    { trip_id: 'P_T1', route_id: 'P_R', service_id: 'WKDY', direction_id: 0, shape_id: 'SHP_A' },
    { trip_id: 'P_T2', route_id: 'OTHER', service_id: 'WKDY', direction_id: 0, shape_id: 'SHP_X' },
  ];
  const spRouteStops: RouteStop[] = [
    // SHP_A still has a trip (above) — direction comes from the trip.
    { route_id: 'P_R', stop_id: 'P_S1', direction_id: 0, stop_sequence: 0, _snapped: true, shape_id: 'SHP_A' },
    // SHP_B is trip-less but stop-bearing, inbound — must appear with dir 1.
    { route_id: 'P_R', stop_id: 'P_S2', direction_id: 1, stop_sequence: 0, _snapped: true, shape_id: 'SHP_B' },
    // a routeStop for a different route must be ignored.
    { route_id: 'OTHER', stop_id: 'P_S3', direction_id: 1, stop_sequence: 0, _snapped: true, shape_id: 'SHP_Z' },
  ];
  const sp = computeShapePatterns('P_R', spTrips, spRouteStops);
  assert('patterns include both trip and trip-less shapes', sp.length === 2, `got ${sp.length}: ${sp.map(p => p.shapeId).join(',')}`);
  const shpA = sp.find(p => p.shapeId === 'SHP_A');
  const shpB = sp.find(p => p.shapeId === 'SHP_B');
  assert('shape with trips keeps trip direction', shpA?.directionId === 0, `got ${shpA?.directionId}`);
  assert('trip-less shape takes routeStop direction', shpB?.directionId === 1, `got ${shpB?.directionId}`);
  assert('other routes\' shapes excluded', !sp.some(p => p.shapeId === 'SHP_X' || p.shapeId === 'SHP_Z'), sp.map(p => p.shapeId).join(','));
  // Back-compat: omitting routeStops behaves like the old trips-only signature.
  const spLegacy = computeShapePatterns('P_R', spTrips);
  assert('routeStops arg defaults to [] (trips-only)', spLegacy.length === 1 && spLegacy[0].shapeId === 'SHP_A', spLegacy.map(p => p.shapeId).join(','));
  // No route id → empty.
  assert('no route id → empty patterns', computeShapePatterns(null, spTrips, spRouteStops).length === 0);

  // ---- SUMMARY ----
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(f));
  }
  console.log('='.repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
