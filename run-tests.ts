/**
 * Run GTFS·X integration tests headlessly via tsx.
 * Usage: npx tsx run-tests.ts
 *
 * Fixture is built in-memory from `tests/fixtures/sample-gtfs-feed/` so the
 * test is self-contained on a fresh checkout (and in CI). No external zips required.
 *
 * Fixture feed: public-transport/sample-gtfs-feed (npm v0.13.0).
 * Source: https://github.com/public-transport/sample-gtfs-feed
 * An imaginary, fully-specified GTFS dataset that exercises stations
 * (parent_station), boarding areas, generic nodes, transfers, frequencies,
 * pathways and levels — features a flat stop list would lack. Two
 * agencies (FTA + MTA), 4 routes (A/B/C/D), 10 stops, 10 trips. It is a test
 * feed and ships two `c-outbound` trips with intentionally incomplete endpoint
 * times, which our validator (correctly, per spec) flags — see Phase 9.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { importGtfsZip, loadImportIntoStore } from './src/services/gtfsImport';
import { exportGtfsZip } from './src/services/gtfsExport';
import { runValidation } from './src/services/validation';
import { groupValidationMessages } from './src/services/validationGrouping';
import { applyValidationFixBatch, applyWheelchairFill } from './src/services/validationFixes';
import type { StopTime } from './src/types/gtfs';
import {
  computeStopSpacing, computeBalancingCandidates, computeServiceIntensity,
  computeAccessibilityAudit, representativeDay,
  type FeedSlice,
} from './src/services/stopAnalysis';
import { useStore } from './src/store';
import { undo, redo, resetHistory, historyDepths } from './src/store/history';
import { getUSHolidaysForYear, getUSHolidaysInRange } from './src/utils/holidays';
import { pointInPolygon } from './src/utils/geometry';
import { stopsInsidePolygon } from './src/components/fares/fareZoneHelpers';
import { computeShapePatterns } from './src/components/ui/shapePatterns';
import { createDrawnShape, deriveRouteShapeIds } from './src/services/routeShapes';
import { gtfsTimeToSeconds, secondsToGtfsTime } from './src/utils/time';
import type { RouteStop, Stop, Trip } from './src/types/gtfs';

const FIXTURE_DIR = 'tests/fixtures/sample-gtfs-feed';

async function buildFixtureZip(): Promise<Buffer> {
  const zip = new JSZip();
  for (const name of readdirSync(FIXTURE_DIR)) {
    const full = path.join(FIXTURE_DIR, name);
    if (!statSync(full).isFile()) continue;
    // Include standard GTFS text files (and a GeoJSON flex-zone file if present).
    if (!name.endsWith('.txt') && !name.endsWith('.geojson')) continue;
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
    'route_id,agency_id,route_short_name,route_long_name,route_type,continuous_pickup,continuous_drop_off\n' +
    'R1,A1,1,Main Line,3,1,1\n');
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
  // T_FREQ row 1 carries per-stop_time continuous overrides (continuous_pickup=0
  // continuous_drop_off=3) that differ from the route default (both 1). The
  // column is sparse — only one of eight rows sets it — so this also exercises
  // the toCSV column-union round-trip for stop_times-level overrides (#29 part 1).
  zip.file('stop_times.txt',
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,continuous_pickup,continuous_drop_off\n' +
    'T_FREQ,06:00:00,06:00:00,S1,1,0,3\n' +
    'T_FREQ,06:30:00,06:30:00,S2,2,,\n' +
    'T_BLK_A,08:00:00,08:00:00,S1,1,,\n' +
    'T_BLK_A,08:30:00,08:30:00,S2,2,,\n' +
    'T_BLK_B,08:15:00,08:15:00,S1,1,,\n' +
    'T_BLK_B,08:45:00,08:45:00,S2,2,,\n' +
    'T_SAT,09:00:00,09:00:00,S1,1,,\n' +
    'T_SAT,09:30:00,09:30:00,S2,2,,\n');
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

  // Build fixture zip from the in-repo sample-gtfs-feed.
  const zipBuffer = await buildFixtureZip();
  const zipFile = zipBuffer as unknown as File;

  // ---- PHASE 1: IMPORT ----
  // Feed: public-transport/sample-gtfs-feed. A small but fully-specified feed:
  // 2 agencies (FTA + MTA), 4 routes (A/B/C/D), 10 stops (incl. 2 stations,
  // child platforms, entrances, generic nodes and a boarding area), 10 trips,
  // 4 calendars, 2 shapes, 1 transfer, 2 frequencies, 3 levels, 6 pathways.
  console.log('Phase 1: Import sample-gtfs-feed GTFS');
  const data = await importGtfsZip(zipFile);
  loadImportIntoStore(data);

  assert('agencies loaded (2)', s().agencies.length === 2, `got ${s().agencies.length}`);
  assert('agency name correct', s().agencies[0]?.agency_name === 'Full Transit Agency');
  assert('routes loaded (4)', s().routes.length === 4, `got ${s().routes.length}`);
  assert('stops loaded (10)', s().stops.length === 10, `got ${s().stops.length}`);
  assert('trips loaded (10)', s().trips.length === 10, `got ${s().trips.length}`);
  assert('calendars loaded (4)', s().calendars.length === 4, `got ${s().calendars.length}`);
  assert('shapes loaded', s().shapes.length > 0, `got ${s().shapes.length}`);
  assert('stop_times loaded', s().stopTimes.length > 0, `got ${s().stopTimes.length}`);
  // The sample feed has no fare_attributes.txt — fare round-trip is exercised
  // separately in phase 12 with a synthetic v2 feed.
  assert('feed info loaded', s().feedInfo !== null);
  assert('route stops built', s().routeStops.length > 0, `got ${s().routeStops.length}`);

  // Spec-completeness files a minimal feed would omit — make sure they import
  // (round-trip is checked in phase 10, validation in phase 9).
  assert('transfers loaded (1)', s().transfers.length === 1, `got ${s().transfers.length}`);
  assert('transfer is airport-1 → airport-2 (type 1)',
    s().transfers[0]?.from_stop_id === 'airport-1' && s().transfers[0]?.to_stop_id === 'airport-2' && s().transfers[0]?.transfer_type === 1);
  assert('frequencies loaded (2)', s().frequencies.length === 2, `got ${s().frequencies.length}`);
  assert('frequency exact_times honored', s().frequencies.find(f => f.trip_id === 'b-downtown-on-working-days')?.exact_times === 1);
  assert('levels loaded (3)', s().levels.length === 3, `got ${s().levels.length}`);
  assert('pathways loaded (6)', s().pathways.length === 6, `got ${s().pathways.length}`);

  // Stations / parent_station. The airport is a station with child platforms,
  // entrances, generic nodes and a boarding area beneath it.
  const stationStops = s().stops.filter(st => st.location_type === 1);
  assert('two stations present (airport, museum)',
    stationStops.length === 2 && stationStops.map(st => st.stop_id).sort().join(',') === 'airport,museum',
    stationStops.map(st => st.stop_id).join(','));
  assert('six stops carry a parent_station', s().stops.filter(st => st.parent_station).length === 6,
    `got ${s().stops.filter(st => st.parent_station).length}`);
  assert('child platform airport-1 parented by the airport station',
    s().stops.find(st => st.stop_id === 'airport-1')?.parent_station === 'airport');
  // Boarding area (location_type 4) parented by a PLATFORM (location_type 0),
  // which a flat stop list never exercises.
  const boarding = s().stops.find(st => st.stop_id === 'airport-2-boarding');
  assert('boarding area airport-2-boarding has location_type 4', boarding?.location_type === 4, `got ${boarding?.location_type}`);
  assert('boarding area parented by platform airport-2', boarding?.parent_station === 'airport-2');

  // ---- PHASE 2: DATA INTEGRITY ----
  console.log('\nPhase 2: Data Integrity');
  // Use route A (Ada Lovelace Bus Line) as the primary test route throughout.
  // It has two trips (a-downtown-all-day / a-outbound-all-day), each with
  // stop_times over real stop_ids and an associated shape.
  const blueline = s().routes.find(r => r.route_id === 'A');
  assert('route A exists', !!blueline);
  assert('route A long name', blueline?.route_long_name === 'Ada Lovelace Bus Line');

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

  // Feature 2 — balancing. The sample feed is a wide-area, station-heavy network
  // whose served patterns are short (2–3 stops) and bracketed by stations, so it
  // has NO interior consolidation pair at any threshold. Exercise that the
  // function runs and returns a well-formed empty result on the real fixture…
  const balancingFixture = computeBalancingCandidates(s(), { thresholdFt: 1500, dwellSeconds: 18, serviceIds: rep.serviceIds });
  assert('balancing: result well-formed', Array.isArray(balancingFixture.candidates));
  assert('balancing: sparse fixture has no <1500 ft interior pairs', balancingFixture.candidates.length === 0, `${balancingFixture.candidates.length}`);
  // …then exercise the candidate + savings path on a controlled 4-stop pattern
  // whose interior pair (BP1,BP2) sits ~110 ft apart (both plain stops, so not
  // skipped as stations). The scan only looks at interior segments i ∈ [1, n-2],
  // so only the (1,2) pair qualifies; BP0→BP1 and BP2→BP3 are terminal segments.
  const balSlice: FeedSlice = {
    stops: [
      { stop_id: 'BP0', stop_name: 'BP0', stop_lat: 45.0000, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'BP1', stop_name: 'BP1', stop_lat: 45.0200, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'BP2', stop_name: 'BP2', stop_lat: 45.0203, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
      { stop_id: 'BP3', stop_name: 'BP3', stop_lat: 45.0400, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
    ],
    routes: [{ route_id: 'BR', agency_id: 'MTA', route_short_name: 'Bal', route_long_name: 'Balancing Test', route_type: 3 }],
    routeStops: [],
    trips: [{ trip_id: 'BT', route_id: 'BR', service_id: 'BS', direction_id: 0 }],
    stopTimes: [
      { trip_id: 'BT', stop_id: 'BP0', stop_sequence: 0, arrival_time: '08:00:00', departure_time: '08:00:00' },
      { trip_id: 'BT', stop_id: 'BP1', stop_sequence: 1, arrival_time: '08:05:00', departure_time: '08:05:00' },
      { trip_id: 'BT', stop_id: 'BP2', stop_sequence: 2, arrival_time: '08:06:00', departure_time: '08:06:00' },
      { trip_id: 'BT', stop_id: 'BP3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
    ],
    calendars: [{ service_id: 'BS', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1, start_date: '20260101', end_date: '20261231' }],
    calendarDates: [],
  };
  const balancingLoose = computeBalancingCandidates(balSlice, { thresholdFt: 600, dwellSeconds: 18, serviceIds: new Set(['BS']) });
  assert('balancing: finds the interior close pair', balancingLoose.candidates.length === 1, `${balancingLoose.candidates.length}`);
  assert('balancing: candidate is the BP1/BP2 pair',
    balancingLoose.candidates[0]?.stopAId === 'BP1' && balancingLoose.candidates[0]?.stopBId === 'BP2');
  assert('balancing: savings = dwell × trips/day',
    balancingLoose.candidates.every(c => c.savingsSecPerDay === 18 * c.tripsPerDay));
  console.log(`    (balancing: fixture ${balancingFixture.candidates.length} <1500 ft; synthetic ${balancingLoose.candidates.length} <600 ft)`);

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
    route_id: 'test-route', agency_id: 'MTA', route_short_name: 'T99',
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
  // The sample feed ships two c-outbound trips with intentionally incomplete
  // endpoint times (blank arrival on the first stop / blank departure on the
  // last). Our validator correctly flags both endpoints of each, so the
  // otherwise-pristine fixture has exactly these 4 errors and nothing else —
  // none of the phase 3–8 edits add or remove one. Assert the exact set
  // (stronger than "zero": a new defect, or a regression that drops one, fails).
  const isCOutboundEndpointErr = (m: { message: string }) =>
    /(First|Last) served stop of trip "c-outbound-(all-day|on-weekends)"/.test(m.message);
  const endpointErrs = errors.filter(isCOutboundEndpointErr);
  assert('validation: only the 4 known c-outbound endpoint errors',
    errors.length === 4 && endpointErrs.length === 4,
    errors.map(e => e.message).join(' | '));

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
  // Round-trip preserves the feed's validity profile: the same 4 c-outbound
  // endpoint errors survive export → re-import, and no new error appears.
  assert('round-trip preserves exactly the c-outbound endpoint errors',
    postErrors.length === 4 && postErrors.filter(isCOutboundEndpointErr).length === 4,
    postErrors.map(e => e.message).join(' | '));

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

  // The synthetic v2 feed is internally consistent (every FK resolves), so the
  // v2 validation rules (#32 editors) must report no v2 errors on it.
  const v2ValTypes = new Set([
    'area', 'stop_area', 'network', 'route_network', 'timeframe',
    'rider_category', 'fare_media', 'fare_product', 'fare_leg_rule', 'fare_transfer_rule',
  ]);
  const v2ValErrors = runValidation(s()).filter(m => m.severity === 'error' && m.entity_type && v2ValTypes.has(m.entity_type));
  assert('v2 validation: clean for a consistent feed', v2ValErrors.length === 0,
    v2ValErrors.map(e => e.message).join('; '));
  // Break a foreign key and confirm the validator flags it.
  s().updateFareProduct('SINGLE', { rider_category_id: 'GHOST' });
  const v2BadRef = runValidation(s()).filter(m => m.message.includes('non-existent rider category "GHOST"'));
  assert('v2 validation: flags a dangling rider_category FK', v2BadRef.length > 0);
  s().updateFareProduct('SINGLE', { rider_category_id: 'ADULT' }); // restore

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

  // Per-stop_time continuous pickup/drop-off overrides (#29 part 1).
  const stFreqS1 = () => s().stopTimes.find(st => st.trip_id === 'T_FREQ' && st.stop_id === 'S1');
  const stFreqS2 = () => s().stopTimes.find(st => st.trip_id === 'T_FREQ' && st.stop_id === 'S2');
  assert('bundle import: route-level continuous default', s().routes.find(r => r.route_id === 'R1')?.continuous_pickup === 1);
  assert('bundle import: stop_time continuous_pickup override', stFreqS1()?.continuous_pickup === 0);
  assert('bundle import: stop_time continuous_drop_off override', stFreqS1()?.continuous_drop_off === 3);
  assert('bundle import: unset stop_time inherits (undefined)', stFreqS2()?.continuous_pickup === undefined && stFreqS2()?.continuous_drop_off === undefined);

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
  assert('bundle round-trip: route-level continuous default', s().routes.find(r => r.route_id === 'R1')?.continuous_pickup === 1);
  assert('bundle round-trip: stop_time continuous_pickup override survived', stFreqS1()?.continuous_pickup === 0);
  assert('bundle round-trip: stop_time continuous_drop_off override survived', stFreqS1()?.continuous_drop_off === 3);
  assert('bundle round-trip: unset stop_time stays inherited (undefined)', stFreqS2()?.continuous_pickup === undefined && stFreqS2()?.continuous_drop_off === undefined);

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

  // ---- PHASE 19: stop-balancing removal (removeRouteStop, route-only) ----
  // Mirrors the Stop Analysis panel's "remove {stop}" action: it strips the
  // flagged stop from one route's trips/stop sequence in that direction, but
  // must leave the stop in stops.txt and untouched on other routes.
  console.log('\nPhase 19: stop-balancing removal (route-only, keeps stops.txt)');
  // Fresh, controlled mini-feed so assertions are deterministic.
  s().setStops([
    mkStop('RM1', -111.04, 45.67),
    mkStop('RM2', -111.05, 45.68), // the stop we remove from RX
    mkStop('RM3', -111.06, 45.69),
  ]);
  s().setRoutes([
    { route_id: 'RX', agency_id: 'A', route_short_name: 'X', route_long_name: 'X Line', route_type: 3 },
    { route_id: 'RY', agency_id: 'A', route_short_name: 'Y', route_long_name: 'Y Line', route_type: 3 },
  ]);
  s().setRouteStops([
    { route_id: 'RX', stop_id: 'RM1', direction_id: 0, stop_sequence: 0, _snapped: false },
    { route_id: 'RX', stop_id: 'RM2', direction_id: 0, stop_sequence: 1, _snapped: false },
    { route_id: 'RX', stop_id: 'RM3', direction_id: 0, stop_sequence: 2, _snapped: false },
    // RM2 is also served by RY in the same direction — must NOT be touched.
    { route_id: 'RY', stop_id: 'RM2', direction_id: 0, stop_sequence: 0, _snapped: false },
    { route_id: 'RY', stop_id: 'RM3', direction_id: 0, stop_sequence: 1, _snapped: false },
  ]);
  s().setTrips([
    { trip_id: 'TX1', route_id: 'RX', service_id: 'SVC', direction_id: 0 },
    { trip_id: 'TX2', route_id: 'RX', service_id: 'SVC', direction_id: 0 },
    { trip_id: 'TY1', route_id: 'RY', service_id: 'SVC', direction_id: 0 },
  ]);
  s().setStopTimes([
    { trip_id: 'TX1', stop_id: 'RM1', stop_sequence: 0, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'TX1', stop_id: 'RM2', stop_sequence: 1, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'TX1', stop_id: 'RM3', stop_sequence: 2, arrival_time: '08:10:00', departure_time: '08:10:00' },
    { trip_id: 'TX2', stop_id: 'RM1', stop_sequence: 0, arrival_time: '09:00:00', departure_time: '09:00:00' },
    { trip_id: 'TX2', stop_id: 'RM2', stop_sequence: 1, arrival_time: '09:05:00', departure_time: '09:05:00' },
    { trip_id: 'TX2', stop_id: 'RM3', stop_sequence: 2, arrival_time: '09:10:00', departure_time: '09:10:00' },
    // RY serves RM2 too — its stop_times must survive.
    { trip_id: 'TY1', stop_id: 'RM2', stop_sequence: 0, arrival_time: '07:00:00', departure_time: '07:00:00' },
    { trip_id: 'TY1', stop_id: 'RM3', stop_sequence: 1, arrival_time: '07:05:00', departure_time: '07:05:00' },
  ]);

  // Mirror the Stop Analysis panel: resolve the flagged stop's instance(s) on
  // (route, direction) to their _uid and remove each (removeRouteStop is now
  // per-instance, by _uid).
  for (const rs of s().routeStops.filter(rs => rs.route_id === 'RX' && rs.direction_id === 0 && rs.stop_id === 'RM2')) {
    s().removeRouteStop('RX', rs._uid!);
  }

  assert('removal: route-stop dropped on RX',
    s().routeStops.filter(rs => rs.route_id === 'RX' && rs.stop_id === 'RM2').length === 0);
  assert('removal: stop_times for RM2 gone on RX trips',
    s().stopTimes.filter(st => (st.trip_id === 'TX1' || st.trip_id === 'TX2') && st.stop_id === 'RM2').length === 0);
  assert('removal: RX still serves its other stops',
    s().stopTimes.filter(st => st.trip_id === 'TX1').map(st => st.stop_id).sort().join(',') === 'RM1,RM3');
  assert('removal: stop RM2 STILL in stops.txt',
    s().stops.some(st => st.stop_id === 'RM2'));
  assert('removal: RM2 untouched on route RY (route-stop)',
    s().routeStops.some(rs => rs.route_id === 'RY' && rs.stop_id === 'RM2'));
  assert('removal: RM2 untouched on route RY (stop_times)',
    s().stopTimes.some(st => st.trip_id === 'TY1' && st.stop_id === 'RM2'));

  // ---- PHASE 20: GTFS-Flex mixed (polygon + stop group) zones (#29 part 2) ----
  console.log('\nPhase 20: GTFS-Flex mixed polygon + group flex zones round-trip');
  // Controlled mini-feed: one agency, one calendar, a few stops, and three flex
  // zones exercising every shape — polygon-only, group-only, and mixed.
  s().setAgencies([{ agency_id: 'FA', agency_name: 'Flex Co', agency_url: 'https://ex.com', agency_timezone: 'America/Denver' }]);
  s().setCalendars([{
    service_id: 'FLEX_SVC', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0,
    start_date: '20260101', end_date: '20271231',
  }]);
  s().setCalendarDates([]);
  s().setStops([
    mkStop('FS1', -111.04, 45.67),
    mkStop('FS2', -111.05, 45.68),
    mkStop('FS3', -111.06, 45.69),
  ]);
  // Pre-create the paired routes so export reuses them (mirrors createFlexZoneWithRoute).
  s().setRoutes([
    { route_id: 'R_POLY', agency_id: 'FA', route_short_name: 'Poly', route_long_name: 'Poly (Flex)', route_type: 3 },
    { route_id: 'R_GROUP', agency_id: 'FA', route_short_name: 'Group', route_long_name: 'Group (Flex)', route_type: 3 },
    { route_id: 'R_MIXED', agency_id: 'FA', route_short_name: 'Mixed', route_long_name: 'Mixed (Flex)', route_type: 3 },
  ]);
  s().setTrips([]);
  s().setStopTimes([]);
  s().setFareAttributes([]);
  s().setFareRules([]);

  const sqPolygon = (cx: number, cy: number): GeoJSON.Feature => ({
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[cx, cy], [cx + 0.01, cy], [cx + 0.01, cy + 0.01], [cx, cy + 0.01], [cx, cy]]],
    },
  });

  s().setFlexZones([
    {
      id: 'zpoly', name: 'Poly Area', bufferMiles: 0,
      geojson: { type: 'FeatureCollection', features: [sqPolygon(-111.10, 45.70)] },
      serviceId: 'FLEX_SVC', routeId: 'R_POLY',
      pickupWindowStart: '08:00:00', pickupWindowEnd: '17:00:00',
      bookingRule: { bookingType: 1, priorNoticeDurationMin: 60, phoneNumber: '406-555-0100' },
    },
    {
      id: 'zgroup', name: 'Stop Group', bufferMiles: 0,
      geojson: { type: 'FeatureCollection', features: [] },
      stopIds: ['FS1', 'FS2'],
      serviceId: 'FLEX_SVC', routeId: 'R_GROUP',
      pickupWindowStart: '09:00:00', pickupWindowEnd: '15:00:00',
    },
    {
      id: 'zmixed', name: 'Mixed Zone', bufferMiles: 0,
      geojson: { type: 'FeatureCollection', features: [sqPolygon(-111.20, 45.60)] },
      stopIds: ['FS2', 'FS3'],
      serviceId: 'FLEX_SVC', routeId: 'R_MIXED',
      pickupWindowStart: '07:30:00', pickupWindowEnd: '18:30:00',
      bookingRule: { bookingType: 2, priorNoticeLastDay: 1, priorNoticeLastTime: '17:00:00' },
    },
  ]);

  // Export the feed and confirm the flex artifacts are present.
  const flexBlob = await exportGtfsZip();
  const flexZip = await JSZip.loadAsync(Buffer.from(await flexBlob.arrayBuffer()));
  const locationsTxt = await flexZip.file('locations.geojson')?.async('string') ?? '';
  const locGroupsTxt = await flexZip.file('location_groups.txt')?.async('string') ?? '';
  const locGroupStopsTxt = await flexZip.file('location_group_stops.txt')?.async('string') ?? '';
  const stopTimesTxt = await flexZip.file('stop_times.txt')?.async('string') ?? '';

  const locFeatures = (JSON.parse(locationsTxt) as GeoJSON.FeatureCollection).features ?? [];
  // Polygon features: zpoly (1) + zmixed (1) = 2. Group-only zone has none.
  assert('export: locations.geojson has poly + mixed features', locFeatures.length === 2, `got ${locFeatures.length}`);
  // Two location_groups (zgroup + zmixed), not the polygon-only zone.
  assert('export: 2 location_groups (group + mixed)',
    (locGroupsTxt.match(/^[^\n]/gm)?.length ?? 0) - 1 === 2, locGroupsTxt);
  // location_group_stops: zgroup (FS1,FS2) + zmixed (FS2,FS3) = 4 rows.
  assert('export: 4 location_group_stops rows',
    (locGroupStopsTxt.trim().split('\n').length - 1) === 4, locGroupStopsTxt);
  // The mixed zone's trip carries BOTH a location_id row and a
  // location_group_id row (two flex stop_times on the same trip). The whole zone
  // is one location, so the location_id is the zone id itself.
  const mixedStopTimeRows = stopTimesTxt.split('\n').filter(l => l.startsWith('zmixed-trip,'));
  assert('export: mixed zone has 2 flex stop_times rows', mixedStopTimeRows.length === 2, `got ${mixedStopTimeRows.length}`);
  assert('export: mixed has a location_id row', mixedStopTimeRows.some(r => r.split(',').includes('zmixed')));
  assert('export: mixed has a location_group_id row', mixedStopTimeRows.some(r => r.includes('zmixed-group')));

  // Round-trip: re-import and confirm all three zones reconstruct with the
  // correct shapes — and crucially the mixed zone comes back as ONE zone with
  // both polygon geometry AND its stop group (not two split zones).
  const flexRe = await importGtfsZip(Buffer.from(await flexBlob.arrayBuffer()) as unknown as File);
  loadImportIntoStore(flexRe);

  const zones = s().flexZones;
  assert('round-trip: 3 flex zones', zones.length === 3, `got ${zones.length}: ${zones.map(z => z.id).join(',')}`);

  const rtPoly = zones.find(z => z.id === 'zpoly');
  const rtGroup = zones.find(z => z.id === 'zgroup');
  const rtMixed = zones.find(z => z.id === 'zmixed');

  assert('round-trip: polygon-only kept polygon, no group',
    !!rtPoly && rtPoly.geojson.features.length === 1 && !Array.isArray(rtPoly.stopIds),
    `poly=${rtPoly?.geojson.features.length} group=${JSON.stringify(rtPoly?.stopIds)}`);
  assert('round-trip: group-only kept stops, no polygon',
    !!rtGroup && (rtGroup.geojson.features.length === 0) && (rtGroup.stopIds?.length === 2),
    `poly=${rtGroup?.geojson.features.length} stops=${JSON.stringify(rtGroup?.stopIds)}`);
  assert('round-trip: MIXED zone has BOTH polygon and stop group',
    !!rtMixed && rtMixed.geojson.features.length === 1 && (rtMixed.stopIds?.length === 2),
    `poly=${rtMixed?.geojson.features.length} stops=${JSON.stringify(rtMixed?.stopIds)}`);
  assert('round-trip: mixed zone stop group is FS2,FS3',
    !!rtMixed && [...(rtMixed.stopIds ?? [])].sort().join(',') === 'FS2,FS3',
    JSON.stringify(rtMixed?.stopIds));
  assert('round-trip: mixed zone window preserved',
    rtMixed?.pickupWindowStart === '07:30:00' && rtMixed?.pickupWindowEnd === '18:30:00');
  assert('round-trip: mixed zone booking rule preserved',
    rtMixed?.bookingRule?.bookingType === 2 && rtMixed?.bookingRule?.priorNoticeLastDay === 1);
  assert('round-trip: polygon zone booking rule preserved',
    rtPoly?.bookingRule?.bookingType === 1 && rtPoly?.bookingRule?.priorNoticeDurationMin === 60);

  // Validation: a clean mixed feed produces no flex errors; a group with a
  // dangling stop ref produces an error.
  const flexErrors = runValidation(s()).filter(m => m.severity === 'error' && m.entity_type === 'flex_zone');
  assert('validation: clean mixed feed has no flex errors', flexErrors.length === 0,
    flexErrors.map(e => e.message).join('; '));

  s().updateFlexZone('zmixed', { stopIds: ['FS2', 'GHOST_STOP'] });
  const flexBadRefs = runValidation(s()).filter(m => m.severity === 'error' && m.message.includes('GHOST_STOP'));
  assert('validation: dangling group stop ref flagged', flexBadRefs.length === 1, `got ${flexBadRefs.length}`);

  // ---- PHASE 21: same stop repeated in one pattern (loop: start == end) ----
  // GTFS-legal: stop_times may list the same stop_id at different
  // stop_sequence values. The editor keys route_stops by a synthetic per-
  // instance _uid so duplicates are individually addressable.
  console.log('\nPhase 21: same stop repeated in a pattern (round-trip loop)');
  s().setStops([
    { stop_id: 'L1', stop_name: 'Depot', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'L2', stop_name: 'Midtown', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 0 },
  ]);
  s().setRoutes([
    { route_id: 'LOOP', agency_id: 'A', route_short_name: 'L', route_long_name: 'Loop', route_type: 3 },
  ]);
  s().setRouteStops([]);
  s().setTrips([]);
  s().setStopTimes([]);

  // Add L1, then L2, then L1 AGAIN (the loop returns to the depot).
  s().addRouteStop({ route_id: 'LOOP', stop_id: 'L1', direction_id: 0, stop_sequence: 0, _snapped: false, shape_id: 'SHL' });
  s().addRouteStop({ route_id: 'LOOP', stop_id: 'L2', direction_id: 0, stop_sequence: 1, _snapped: false, shape_id: 'SHL' });
  s().addRouteStop({ route_id: 'LOOP', stop_id: 'L1', direction_id: 0, stop_sequence: 2, _snapped: false, shape_id: 'SHL' });

  const loopRs = () => s().routeStops.filter(rs => rs.route_id === 'LOOP').sort((a, b) => a.stop_sequence - b.stop_sequence);
  assert('dup: same stop added twice → 3 route_stops', loopRs().length === 3, `got ${loopRs().length}`);
  assert('dup: L1 appears twice', loopRs().filter(rs => rs.stop_id === 'L1').length === 2);
  const loopUids = loopRs().map(rs => rs._uid);
  assert('dup: every instance has a _uid', loopUids.every(Boolean));
  assert('dup: the two L1 instances have DISTINCT _uids',
    loopUids[0] !== loopUids[2] && new Set(loopUids).size === 3);

  // A trip on the loop gets two stop_times for L1 at distinct stop_sequence.
  s().addTrip({ trip_id: 'LT1', route_id: 'LOOP', service_id: 'SVC', direction_id: 0, shape_id: 'SHL' });
  for (const rs of loopRs()) {
    s().setStopTime('LT1', rs.stop_id, rs.stop_sequence, {
      arrival_time: `08:0${rs.stop_sequence}:00`, departure_time: `08:0${rs.stop_sequence}:00`,
    });
  }
  const lt1 = () => s().stopTimes.filter(st => st.trip_id === 'LT1').sort((a, b) => a.stop_sequence - b.stop_sequence);
  assert('dup: trip has 3 stop_times (one per instance)', lt1().length === 3, `got ${lt1().length}`);
  assert('dup: L1 has two stop_times at different stop_sequence',
    lt1().filter(st => st.stop_id === 'L1').length === 2
    && lt1().filter(st => st.stop_id === 'L1')[0].stop_sequence !== lt1().filter(st => st.stop_id === 'L1')[1].stop_sequence);
  assert('dup: stop_id order is L1,L2,L1', lt1().map(st => st.stop_id).join(',') === 'L1,L2,L1');
  // The two L1 cells hold their own (distinct) times — not collapsed onto one.
  assert('dup: the two L1 stop_times keep distinct times',
    lt1().filter(st => st.stop_id === 'L1')[0].arrival_time !== lt1().filter(st => st.stop_id === 'L1')[1].arrival_time);

  // Reorder a list containing the duplicate: move the trailing L1 to the front
  // (uids order [2,0,1]). Both L1 instances survive; times follow their column.
  const beforeReorder = loopRs();
  s().reorderRouteStops('LOOP', 0, [beforeReorder[2]._uid!, beforeReorder[0]._uid!, beforeReorder[1]._uid!], 'SHL');
  const afterReorder = loopRs();
  assert('dup: reorder keeps all 3 instances', afterReorder.length === 3);
  assert('dup: reorder kept both L1 instances', afterReorder.filter(rs => rs.stop_id === 'L1').length === 2);
  assert('dup: reorder produced contiguous 0..2 sequences',
    afterReorder.map(rs => rs.stop_sequence).join(',') === '0,1,2');
  // The instance that was last (had the 08:02 time) is now first; its time
  // followed the reorder via stop_sequence remap.
  const movedUid = beforeReorder[2]._uid;
  const movedNow = afterReorder.find(rs => rs._uid === movedUid)!;
  assert('dup: moved L1 instance now at sequence 0', movedNow.stop_sequence === 0);
  assert('dup: moved instance\'s stop_time followed it',
    s().stopTimes.find(st => st.trip_id === 'LT1' && st.stop_sequence === 0)?.arrival_time === '08:02:00');

  // Remove ONE L1 instance (the one NOT moved, now at sequence 1) by _uid →
  // the other L1 survives.
  const toRemove = afterReorder.find(rs => rs.stop_id === 'L1' && rs._uid !== movedUid)!;
  s().removeRouteStop('LOOP', toRemove._uid!);
  assert('dup: removing one instance leaves 2 route_stops', loopRs().length === 2, `got ${loopRs().length}`);
  assert('dup: the OTHER L1 instance still present', loopRs().some(rs => rs.stop_id === 'L1'));
  assert('dup: surviving L1 stop_time kept', s().stopTimes.some(st => st.trip_id === 'LT1' && st.stop_id === 'L1'));
  assert('dup: removed instance\'s stop_time gone (only one L1 left)',
    s().stopTimes.filter(st => st.trip_id === 'LT1' && st.stop_id === 'L1').length === 1);

  // Export → re-import a feed whose trip repeats a stop, and confirm the
  // repeat round-trips (two stop_times rows for the same stop_id at different
  // stop_sequence survive).
  s().setStops([
    { stop_id: 'L1', stop_name: 'Depot', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'L2', stop_name: 'Midtown', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 0 },
  ]);
  s().setStopTimes([
    { trip_id: 'LT1', stop_id: 'L1', stop_sequence: 0, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'LT1', stop_id: 'L2', stop_sequence: 1, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'LT1', stop_id: 'L1', stop_sequence: 2, arrival_time: '08:10:00', departure_time: '08:10:00' },
  ]);
  const loopBlob = await exportGtfsZip();
  const loopZip = await JSZip.loadAsync(Buffer.from(await loopBlob.arrayBuffer()));
  const loopStTxt = await loopZip.file('stop_times.txt')?.async('string') ?? '';
  const lt1ExportRows = loopStTxt.split('\n').filter(l => l.startsWith('LT1,'));
  assert('dup-export: 3 stop_times rows for the loop trip', lt1ExportRows.length === 3, `got ${lt1ExportRows.length}`);
  assert('dup-export: L1 written twice', lt1ExportRows.filter(r => r.includes(',L1,')).length === 2);
  const loopRe = await importGtfsZip(Buffer.from(await loopBlob.arrayBuffer()) as unknown as File);
  loadImportIntoStore(loopRe);
  const reLt1 = s().stopTimes.filter(st => st.trip_id === 'LT1').sort((a, b) => a.stop_sequence - b.stop_sequence);
  assert('dup-roundtrip: trip still has 3 stop_times', reLt1.length === 3, `got ${reLt1.length}`);
  assert('dup-roundtrip: stop_id order preserved L1,L2,L1', reLt1.map(st => st.stop_id).join(',') === 'L1,L2,L1');
  const reLoopRs = s().routeStops.filter(rs => rs.route_id === 'LOOP').sort((a, b) => a.stop_sequence - b.stop_sequence);
  assert('dup-roundtrip: imported route_stops repeat L1', reLoopRs.filter(rs => rs.stop_id === 'L1').length === 2,
    `got ${reLoopRs.map(rs => rs.stop_id).join(',')}`);
  assert('dup-roundtrip: imported route_stops all carry _uid', reLoopRs.every(rs => !!rs._uid));

  // ---- PHASE 22: timed / interpolated / skipped stop states ----
  // Reproduces the forum "Assistance Please" case: a trip that skips its first
  // and last stops on some runs. Skipped stops must drop their rows (so the
  // trip's first/last become the adjacent SERVED, timed stops and no
  // missing-start/end error fires); interpolated (served, blank) stops export
  // with blank times + timepoint=0.
  console.log('\nPhase 22: timed / interpolated / skipped stops');
  s().setFlexZones([]);
  s().setStops([
    { stop_id: 'KA', stop_name: 'A', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'KB', stop_name: 'B', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'KC', stop_name: 'C', stop_lat: 45.2, stop_lon: -111.2, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'KD', stop_name: 'D', stop_lat: 45.3, stop_lon: -111.3, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'KE', stop_name: 'E', stop_lat: 45.4, stop_lon: -111.4, location_type: 0, wheelchair_boarding: 0 },
  ]);
  s().setRoutes([{ route_id: 'SKR', agency_id: 'A', route_short_name: 'SK', route_long_name: 'Skip Test', route_type: 3 }]);
  s().setRouteStops([]);
  s().setTrips([]);
  s().setStopTimes([]);

  const kstops: [string, number][] = [['KA', 0], ['KB', 1], ['KC', 2], ['KD', 3], ['KE', 4]];
  // route_stops added BEFORE the trip exists → no seeding here.
  for (const [sid, seq] of kstops) {
    s().addRouteStop({ route_id: 'SKR', stop_id: sid, direction_id: 0, stop_sequence: seq, _snapped: false, shape_id: 'SHK' });
  }
  s().addTrip({ trip_id: 'SKT', route_id: 'SKR', service_id: 'SVC', direction_id: 0, shape_id: 'SHK' });
  for (const [sid, seq] of kstops) {
    s().setStopTime('SKT', sid, seq, { arrival_time: `09:0${seq}:00`, departure_time: `09:0${seq}:00` });
  }
  assert('skip: trip starts with 5 stop_times', s().stopTimes.filter(st => st.trip_id === 'SKT').length === 5);

  // Middle stop C (seq 2) → interpolated: clear the time, KEEP the row.
  s().setStopTime('SKT', 'KC', 2, { arrival_time: '', departure_time: '' });
  const cRow = s().stopTimes.find(st => st.trip_id === 'SKT' && st.stop_sequence === 2);
  assert('skip: interpolated stop keeps its row', !!cRow);
  assert('skip: interpolated row has blank times', !!cRow && !cRow.arrival_time && !cRow.departure_time);

  // First (seq 0) and last (seq 4) → skipped: remove their rows.
  s().skipStop('SKT', 0);
  s().skipStop('SKT', 4);
  const skRows = s().stopTimes.filter(st => st.trip_id === 'SKT').sort((a, b) => a.stop_sequence - b.stop_sequence);
  assert('skip: skipped ends drop their rows (3 remain)', skRows.length === 3, `got ${skRows.length}`);
  assert('skip: served sequences are 1,2,3', skRows.map(st => st.stop_sequence).join(',') === '1,2,3');

  // Validation: skipped ends are NOT a missing-start/end error — the first/last
  // SERVED stops (seq 1 and 3) are timed.
  const skErrs = runValidation(s()).filter(m => m.severity === 'error' && m.message.includes('"SKT"'));
  assert('skip: no missing start/end error when ends are skipped', skErrs.length === 0, skErrs.map(m => m.message).join('; '));

  // Export round-trip of the three states.
  const skBlob = await exportGtfsZip();
  const skZip = await JSZip.loadAsync(Buffer.from(await skBlob.arrayBuffer()));
  const skTxt = await skZip.file('stop_times.txt')?.async('string') ?? '';
  const skLines = skTxt.split(/\r?\n/).filter(l => l.length > 0);
  const skHeader = skLines[0].split(',');
  const col = (name: string) => skHeader.indexOf(name);
  const skExport = skLines.slice(1)
    .map(l => l.split(','))
    .filter(c => c[col('trip_id')] === 'SKT')
    .sort((a, b) => Number(a[col('stop_sequence')]) - Number(b[col('stop_sequence')]));
  assert('skip-export: 3 rows for SKT (skipped omitted)', skExport.length === 3, `got ${skExport.length}`);
  assert('skip-export: skipped seq 0 and 4 absent from export',
    !skExport.some(c => c[col('stop_sequence')] === '0' || c[col('stop_sequence')] === '4'));
  const interpRow = skExport.find(c => c[col('stop_sequence')] === '2');
  assert('skip-export: interpolated row has blank arrival_time', !!interpRow && interpRow[col('arrival_time')] === '');
  assert('skip-export: interpolated row has blank departure_time', !!interpRow && interpRow[col('departure_time')] === '');
  assert('skip-export: interpolated row has timepoint=0', !!interpRow && interpRow[col('timepoint')] === '0');
  const skFirst = skExport[0];
  const skLast = skExport[skExport.length - 1];
  assert('skip-export: first emitted row (seq 1) is timed',
    skFirst[col('stop_sequence')] === '1' && skFirst[col('arrival_time')] !== '');
  assert('skip-export: last emitted row (seq 3) is timed',
    skLast[col('stop_sequence')] === '3' && skLast[col('arrival_time')] !== '');

  // An interpolated stop is only valid mid-trip: blank the first SERVED stop
  // (seq 1) and confirm validation flags the untimed endpoint.
  s().setStopTime('SKT', 'KB', 1, { arrival_time: '', departure_time: '' });
  const endErr = runValidation(s()).filter(m => m.severity === 'error' && m.message.includes('"SKT"') && /first served stop/i.test(m.message));
  assert('skip: untimed first served stop is flagged', endErr.length >= 1, endErr.map(m => m.message).join('; '));

  // ---- PHASE 23: skip-aware interpolate + estimate write-path ----
  // Both auto-fill tools must respect a skipped stop: they keep computing over
  // ALL stops (the bus still physically passes a skipped one, so downstream
  // times stay correct) but only WRITE to SERVED stops. A skipped stop has no
  // row, and neither tool may re-create it (which would silently un-skip it).
  console.log('\nPhase 23: skip-aware interpolate & estimate write-path');
  s().setFlexZones([]);
  s().setStops([
    { stop_id: 'IA', stop_name: 'A', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'IB', stop_name: 'B', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'IC', stop_name: 'C', stop_lat: 45.2, stop_lon: -111.2, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'ID', stop_name: 'D', stop_lat: 45.3, stop_lon: -111.3, location_type: 0, wheelchair_boarding: 0 },
    { stop_id: 'IE', stop_name: 'E', stop_lat: 45.4, stop_lon: -111.4, location_type: 0, wheelchair_boarding: 0 },
  ]);
  s().setRoutes([{ route_id: 'ISR', agency_id: 'A', route_short_name: 'IS', route_long_name: 'Interp Skip', route_type: 3 }]);
  s().setShapes([]); // no shape → equal-spacing interpolation, deterministic times
  s().setRouteStops([]);
  s().setTrips([]);
  s().setStopTimes([]);

  const istops: [string, number][] = [['IA', 0], ['IB', 1], ['IC', 2], ['ID', 3], ['IE', 4]];
  for (const [sid, seq] of istops) {
    s().addRouteStop({ route_id: 'ISR', stop_id: sid, direction_id: 0, stop_sequence: seq, _snapped: false });
  }
  s().addTrip({ trip_id: 'IST', route_id: 'ISR', service_id: 'SVC', direction_id: 0 });
  // All five SERVED (rows exist): endpoints timed, middles blank (served, await
  // interpolation). Then skip the centre stop C so it has no row at all.
  s().setStopTime('IST', 'IA', 0, { arrival_time: '08:00:00', departure_time: '08:00:00' });
  s().setStopTime('IST', 'IB', 1, { arrival_time: '', departure_time: '' });
  s().setStopTime('IST', 'IC', 2, { arrival_time: '', departure_time: '' });
  s().setStopTime('IST', 'ID', 3, { arrival_time: '', departure_time: '' });
  s().setStopTime('IST', 'IE', 4, { arrival_time: '08:40:00', departure_time: '08:40:00' });
  s().skipStop('IST', 2);
  assert('interp-skip: stop C has no row before interpolation',
    !s().stopTimes.some(st => st.trip_id === 'IST' && st.stop_sequence === 2));

  // interpolateStopTimes must fill the served blanks (seq 1, 3) but must NOT
  // re-create a row for the skipped seq 2.
  s().interpolateStopTimes('IST');
  const istRow = (seq: number) => s().stopTimes.find(st => st.trip_id === 'IST' && st.stop_sequence === seq);
  assert('interp-skip: skipped stop C still has NO row after interpolate', !istRow(2));
  assert('interp-skip: served stop B (seq 1) got interpolated time', !!istRow(1)?.arrival_time, istRow(1)?.arrival_time);
  assert('interp-skip: served stop D (seq 3) got interpolated time', !!istRow(3)?.arrival_time, istRow(3)?.arrival_time);
  assert('interp-skip: endpoints unchanged',
    istRow(0)?.arrival_time === '08:00:00' && istRow(4)?.arrival_time === '08:40:00');
  assert('interp-skip: row count stays 4 (skip not un-skipped)',
    s().stopTimes.filter(st => st.trip_id === 'IST').length === 4,
    `got ${s().stopTimes.filter(st => st.trip_id === 'IST').length}`);

  // Estimate write-path. The async Mapbox match (and services/travelTime, whose
  // module top-level reads import.meta.env) can't run under tsx, so we inline a
  // copy of layoutStopTimes over synthetic cumulative travel seconds (one per
  // stop, computed over ALL stops) and replay handleEstimateConfirm's guarded
  // write loop verbatim: skip any column whose stop has no row (it's skipped).
  const estStart = gtfsTimeToSeconds('10:00:00');
  const estCum = [0, 60, 120, 180, 240]; // cumulative driving seconds at each of the 5 stops
  const estDwellSec = 18;
  const estTimings: { arrivalSec: number; departureSec: number }[] = [{ arrivalSec: estStart, departureSec: estStart }];
  for (let i = 1; i < estCum.length; i++) {
    const seg = Math.abs(estCum[i] - estCum[i - 1]); // speedFactor = 1
    const arrival = Math.round(estTimings[i - 1].departureSec + seg);
    const isLast = i === estCum.length - 1;
    estTimings.push({ arrivalSec: arrival, departureSec: isLast ? arrival : arrival + estDwellSec });
  }
  assert('estimate-skip: layout covers all 5 stops', estTimings.length === 5, `got ${estTimings.length}`);
  estTimings.forEach((t, i) => {
    const [stop_id, seq] = istops[i];
    // Mirror the component guard: no stop_time row ⇒ skipped column ⇒ don't write.
    if (!istRow(seq)) return;
    s().setStopTime('IST', stop_id, seq, {
      arrival_time: secondsToGtfsTime(t.arrivalSec),
      departure_time: secondsToGtfsTime(t.departureSec),
    });
  });
  assert('estimate-skip: skipped stop C still has NO row after estimate write', !istRow(2));
  assert('estimate-skip: served stop A (seq 0) got the start time', istRow(0)?.arrival_time === '10:00:00');
  assert('estimate-skip: served stop B (seq 1) got an estimate time', !!istRow(1)?.arrival_time);
  assert('estimate-skip: served stop D (seq 3) got an estimate time', !!istRow(3)?.arrival_time);
  assert('estimate-skip: row count stays 4 (estimate never un-skips)',
    s().stopTimes.filter(st => st.trip_id === 'IST').length === 4,
    `got ${s().stopTimes.filter(st => st.trip_id === 'IST').length}`);

  // Drawing a route shape must create a SHAPE only — no placeholder/stub trip
  // (which used to show as an empty trip in the timetable). The drawn shape is
  // associated to its route via the editor-only Shape._route_id, so it still
  // surfaces in the Route Shapes panel (deriveRouteShapeIds) and on the map.
  console.log('\nPhase 24: drawn shape has no stub trip but stays route-associated');
  s().setFlexZones([]);
  s().setRoutes([{ route_id: 'DR', agency_id: 'A', route_short_name: 'D', route_long_name: 'Draw Route', route_type: 3 }]);
  s().setStops([
    { stop_id: 'DA', stop_name: 'DA', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 0 },
  ]);
  s().setShapes([]);
  s().setRouteStops([]);
  s().setTrips([]);
  s().setStopTimes([]);

  const tripsBeforeDraw = s().trips.length;
  const drawnShapeId = createDrawnShape(
    [[-111.00, 45.00], [-111.01, 45.01], [-111.02, 45.02]], 'DR',
  );
  assert('draw-shape: shape was created', s().shapes.some(sh => sh.shape_id === drawnShapeId));
  assert('draw-shape: NO stub trip created', s().trips.length === tripsBeforeDraw,
    `trips went ${tripsBeforeDraw} -> ${s().trips.length}`);
  assert('draw-shape: tagged with its route via _route_id',
    s().shapes.find(sh => sh.shape_id === drawnShapeId)?._route_id === 'DR');
  assert('draw-shape: distances were recalculated',
    (s().shapes.find(sh => sh.shape_id === drawnShapeId)?.points.at(-1)?.shape_dist_traveled ?? 0) > 0);

  // Appears in the route's shapes (the panel's source) with ZERO trips.
  const drawnDerived = deriveRouteShapeIds('DR', s().trips, s().routeStops, s().shapes);
  assert('draw-shape: appears in route shapes with zero trips', drawnDerived.includes(drawnShapeId));

  // Once it gains a route_stop, it stays listed exactly once (draft deduped).
  s().addRouteStop({ route_id: 'DR', stop_id: 'DA', direction_id: 0, stop_sequence: 0, _snapped: false, shape_id: drawnShapeId });
  const drawnDerived2 = deriveRouteShapeIds('DR', s().trips, s().routeStops, s().shapes);
  assert('draw-shape: still listed once after gaining a route_stop',
    drawnDerived2.filter(id => id === drawnShapeId).length === 1);

  // A shape with neither a draft tag nor a trip/route_stop on this route is NOT listed.
  s().addShape({ shape_id: 'UNREL', points: [
    { shape_pt_lat: 1, shape_pt_lon: 1, shape_pt_sequence: 0, shape_dist_traveled: 0 },
    { shape_pt_lat: 1, shape_pt_lon: 2, shape_pt_sequence: 1, shape_dist_traveled: 0 },
  ] });
  assert('draw-shape: unrelated untagged shape is not listed for the route',
    !deriveRouteShapeIds('DR', s().trips, s().routeStops, s().shapes).includes('UNREL'));

  // Undo / redo edit history (#49). Patch-based history over the store: a feed
  // edit is undoable + redoable, rapid same-target edits coalesce into one step,
  // and loading a different feed resets the stack (no cross-feed undo).
  console.log('\nPhase 25: undo / redo edit history (#49)');
  const hstop = (id: string, lat = 45, lon = -111): Stop => ({
    stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon,
    location_type: 0, wheelchair_boarding: 0,
  });

  s().setStops([hstop('H1')]);
  resetHistory();
  assert('history: starts empty after reset', historyDepths().undo === 0);
  s().updateStop('H1', { stop_name: 'Renamed' });
  assert('history: an edit is recorded', historyDepths().undo === 1);
  assert('history: edit applied', s().stops.find(x => x.stop_id === 'H1')?.stop_name === 'Renamed');
  undo();
  assert('history: undo reverts the edit', s().stops.find(x => x.stop_id === 'H1')?.stop_name === 'H1');
  redo();
  assert('history: redo re-applies the edit', s().stops.find(x => x.stop_id === 'H1')?.stop_name === 'Renamed');

  s().setStops([hstop('H2')]);
  resetHistory();
  s().updateStop('H2', { stop_lat: 45.1 });
  s().updateStop('H2', { stop_lat: 45.2 });
  assert('history: rapid same-target edits coalesce into one step', historyDepths().undo === 1);
  undo();
  assert('history: one undo reverts the whole coalesced gesture',
    s().stops.find(x => x.stop_id === 'H2')?.stop_lat === 45);

  s().setStops([hstop('H3')]);
  resetHistory();
  s().updateStop('H3', { stop_name: 'changed' });
  assert('history: pre-import edit recorded', historyDepths().undo === 1);
  const reimportForHistory = await importGtfsZip(zipFile);
  loadImportIntoStore(reimportForHistory);
  assert('history: importing a feed resets the stack', historyDepths().undo === 0);
  assert('history: cannot undo across a feed load', undo() === null);

  // ---- PHASE 26: validation grouping + batch fix ----
  // A feed with hundreds of the SAME error must collapse to one "N×" group and
  // be fixable in one undoable batch. Build many trips whose first stop has only
  // a departure_time (one-present endpoint) so each emits the trip-edge error,
  // each carrying the fill-trip-edge-times fix.
  console.log('\nPhase 26: validation grouping + batch fix');
  {
    const N = 200;
    const gtrips: Trip[] = [];
    const gsts: StopTime[] = [];
    for (let i = 0; i < N; i++) {
      const id = `GRP${i}`;
      gtrips.push({ trip_id: id, route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip);
      gsts.push(
        { trip_id: id, stop_id: 'g1', stop_sequence: 1, arrival_time: '', departure_time: '08:00:00' } as StopTime,
        { trip_id: id, stop_id: 'g2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' } as StopTime,
        { trip_id: id, stop_id: 'g3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' } as StopTime,
      );
    }
    s().setTrips(gtrips);
    s().setStopTimes(gsts);

    const edgeMsgs = runValidation(s()).filter(m => m.message.includes('missing arrival_time or departure_time'));
    assert('grouping: all N trip-edge errors present', edgeMsgs.length === N, `got ${edgeMsgs.length}`);

    const groups = groupValidationMessages(edgeMsgs);
    assert('grouping: collapse to a single group', groups.length === 1, `got ${groups.length}`);
    assert('grouping: group count is N', groups[0].count === N, `got ${groups[0].count}`);
    assert('grouping: every message is fixable', groups[0].fixableCount === N, `got ${groups[0].fixableCount}`);
    assert('grouping: group carries the fill-trip-edge-times fix', groups[0].fixId === 'fill-trip-edge-times');

    // Batch fix: one undoable step over the whole group.
    const batch = applyValidationFixBatch(groups[0].messages);
    assert('batch fix: returns a result', !!batch);
    assert('batch fix: reports changed', !!batch && batch.changed === true);
    assert('batch fix: label reports "Fixed N of N"', !!batch && batch.label.includes(`Fixed ${N} of ${N}`), batch?.label);

    const afterFix = runValidation(s()).filter(m => m.message.includes('missing arrival_time or departure_time'));
    assert('batch fix: re-validation clears the whole group', afterFix.length === 0, `got ${afterFix.length}`);

    // Single combined undo restores every endpoint.
    batch!.undo();
    const afterUndo = runValidation(s()).filter(m => m.message.includes('missing arrival_time or departure_time'));
    assert('batch fix: one undo restores all N errors', afterUndo.length === N, `got ${afterUndo.length}`);

    s().setTrips([]);
    s().setStopTimes([]);
  }

  // ---- PHASE 27: validation fix recipes ----
  // Covers fill-missing-wheelchair, remove-orphan-trips, and delete-unused-stop.
  // Each recipe is tested for: message carries the fix id, fix executes and
  // mutates state, re-validation clears the warning (or confirms expected
  // behavior), and the undo closure reverses the mutation.
  console.log('\nPhase 27: validation fix recipes (wheelchair / orphan-trips / unused-stop)');
  {
    // ── 27a: fill-missing-wheelchair ──────────────────────────────────────────
    // WC1 has no wheelchair_boarding (flagged). WC2 has wheelchair_boarding=1
    // (fine — not touched). The fix sets WC1 to 0 (GTFS "no information").
    // NOTE: the validation rule counts both undefined and 0 as "no info", so
    // the warning persists after the 0-fill. The recipe's purpose is to mark
    // stops as explicitly reviewed (value set), not to silence the warning —
    // users then update individual stops to 1 or 2 via Stop Analysis.
    s().setStops([
      { stop_id: 'WC1', stop_name: 'WC1', stop_lat: 45.0, stop_lon: -111.0, location_type: 0 } as Stop,
      { stop_id: 'WC2', stop_name: 'WC2', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 1 } as Stop,
    ]);
    s().setCalendars([{ service_id: 'WCSVC', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20270101', end_date: '20271231' }]);
    s().setRoutes([{ route_id: 'WCR', agency_id: 'A1', route_short_name: 'W', route_long_name: 'WC Route', route_type: 3 }]);
    s().setTrips([{ trip_id: 'WCT', route_id: 'WCR', service_id: 'WCSVC', direction_id: 0 }]);
    s().setStopTimes([]);
    s().setFrequencies([]);
    s().setFlexZones([]);

    const wcMsgs = runValidation(s()).filter((m) => m.message.includes('missing wheelchair_boarding'));
    assert('27a: wheelchair warning fires', wcMsgs.length === 1, `got ${wcMsgs.length}`);
    assert('27a: message carries fill-missing-wheelchair fix id', wcMsgs[0]?.fix?.id === 'fill-missing-wheelchair');

    const wcResult = applyValidationFixBatch(wcMsgs);
    assert('27a: fix reports changed', !!wcResult && wcResult.changed === true);
    assert('27a: WC1 wheelchair_boarding set to 0', s().stops.find((x) => x.stop_id === 'WC1')?.wheelchair_boarding === 0);
    assert('27a: WC2 (=1) not touched by fix', s().stops.find((x) => x.stop_id === 'WC2')?.wheelchair_boarding === 1);

    // Undo: fillMissingWheelchairBoarding saves prev=0 for undefined inputs
    // (Number.isFinite(undefined) = false → stored as 0). After undo WC1 gets 0.
    wcResult!.undo();
    assert('27a: undo runs; WC2 still = 1', s().stops.find((x) => x.stop_id === 'WC2')?.wheelchair_boarding === 1);

    // 27a (picker): the validation panel's value picker calls applyWheelchairFill
    // with the chosen value. Filling 1 (accessible) records the status AND clears
    // the warning (unlike the 0-fill above). WC2 (already 1) is left alone.
    const wcPick = applyWheelchairFill(1);
    assert('27a-picker: fills the gap stop', wcPick.changed === true);
    assert('27a-picker: WC1 now = 1 (accessible)', s().stops.find((x) => x.stop_id === 'WC1')?.wheelchair_boarding === 1);
    const wcAfterPick = runValidation(s()).filter((m) => m.message.includes('missing wheelchair_boarding'));
    assert('27a-picker: warning clears after filling 1', wcAfterPick.length === 0, wcAfterPick.map((m) => m.message).join('; '));
    wcPick.undo();
    assert('27a-picker: undo restores WC1 to no-info (flagged again)',
      runValidation(s()).filter((m) => m.message.includes('missing wheelchair_boarding')).length === 1);

    // ── 27b: remove-orphan-trips ──────────────────────────────────────────────
    // ORPHAN_T references GHOST_SVC which has no calendar. The fix removes it
    // plus its 2 stop_times and 1 frequency window. GOOD_T (valid service) must
    // be untouched. Undo restores all removed rows.
    s().setStops([
      { stop_id: 'ORP_S1', stop_name: 'S1', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 1 },
      { stop_id: 'ORP_S2', stop_name: 'S2', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 1 },
    ]);
    s().setCalendars([{ service_id: 'REAL_SVC', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20270101', end_date: '20271231' }]);
    s().setRoutes([{ route_id: 'ORP_R', agency_id: 'A1', route_short_name: 'O', route_long_name: 'Orphan Route', route_type: 3 }]);
    s().setTrips([
      { trip_id: 'GOOD_T', route_id: 'ORP_R', service_id: 'REAL_SVC', direction_id: 0 },
      { trip_id: 'ORPHAN_T', route_id: 'ORP_R', service_id: 'GHOST_SVC', direction_id: 0 },
    ]);
    s().setStopTimes([
      { trip_id: 'GOOD_T', stop_id: 'ORP_S1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
      { trip_id: 'GOOD_T', stop_id: 'ORP_S2', stop_sequence: 2, arrival_time: '08:10:00', departure_time: '08:10:00' },
      { trip_id: 'ORPHAN_T', stop_id: 'ORP_S1', stop_sequence: 1, arrival_time: '09:00:00', departure_time: '09:00:00' },
      { trip_id: 'ORPHAN_T', stop_id: 'ORP_S2', stop_sequence: 2, arrival_time: '09:10:00', departure_time: '09:10:00' },
    ] as StopTime[]);
    s().setFrequencies([
      { trip_id: 'ORPHAN_T', start_time: '08:00:00', end_time: '12:00:00', headway_secs: 600 },
    ]);
    s().setFlexZones([]);
    s().setRouteStops([]);

    const orphanMsgs = runValidation(s()).filter((m) => m.message.includes('non-existent calendar "GHOST_SVC"'));
    assert('27b: orphan trip warning fires', orphanMsgs.length === 1, `got ${orphanMsgs.length}`);
    assert('27b: orphan message has entity_id ORPHAN_T', orphanMsgs[0]?.entity_id === 'ORPHAN_T');
    assert('27b: orphan message carries remove-orphan-trips fix', orphanMsgs[0]?.fix?.id === 'remove-orphan-trips');

    const orphanResult = applyValidationFixBatch(orphanMsgs);
    assert('27b: fix reports changed', !!orphanResult && orphanResult.changed === true);
    assert('27b: ORPHAN_T removed from trips', !s().trips.some((t) => t.trip_id === 'ORPHAN_T'));
    assert('27b: ORPHAN_T stop_times removed', s().stopTimes.filter((st) => st.trip_id === 'ORPHAN_T').length === 0);
    assert('27b: ORPHAN_T frequency removed', s().frequencies.filter((f) => f.trip_id === 'ORPHAN_T').length === 0);
    assert('27b: GOOD_T unaffected', s().trips.some((t) => t.trip_id === 'GOOD_T'));
    assert('27b: GOOD_T stop_times intact (2)', s().stopTimes.filter((st) => st.trip_id === 'GOOD_T').length === 2);

    const orphanAfter = runValidation(s()).filter((m) => m.entity_id === 'ORPHAN_T');
    assert('27b: re-validation clears orphan warning', orphanAfter.length === 0, orphanAfter.map((m) => m.message).join('; '));

    orphanResult!.undo();
    assert('27b: undo restores ORPHAN_T trip', s().trips.some((t) => t.trip_id === 'ORPHAN_T'));
    assert('27b: undo restores 2 stop_times for ORPHAN_T', s().stopTimes.filter((st) => st.trip_id === 'ORPHAN_T').length === 2);
    assert('27b: undo restores 1 frequency for ORPHAN_T', s().frequencies.filter((f) => f.trip_id === 'ORPHAN_T').length === 1);
    assert('27b: GOOD_T still present after undo', s().trips.some((t) => t.trip_id === 'GOOD_T'));

    // ── 27c: delete-unused-stop ───────────────────────────────────────────────
    // UNUSED_S has no stop_times but has a route_stop entry. USED_S is served by
    // UT. The fix removes UNUSED_S and its route_stop; USED_S is untouched.
    // The unused-stop rule only fires when stopTimes.length > 0.
    s().setStops([
      { stop_id: 'USED_S', stop_name: 'Used Stop', stop_lat: 45.0, stop_lon: -111.0, location_type: 0, wheelchair_boarding: 1 },
      { stop_id: 'UNUSED_S', stop_name: 'Unused Stop', stop_lat: 45.1, stop_lon: -111.1, location_type: 0, wheelchair_boarding: 1 },
    ]);
    s().setCalendars([{ service_id: 'USVC', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20270101', end_date: '20271231' }]);
    s().setRoutes([{ route_id: 'UR', agency_id: 'A1', route_short_name: 'U', route_long_name: 'Used Route', route_type: 3 }]);
    s().setTrips([{ trip_id: 'UT', route_id: 'UR', service_id: 'USVC', direction_id: 0 }]);
    s().setStopTimes([
      { trip_id: 'UT', stop_id: 'USED_S', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    ] as StopTime[]);
    s().setRouteStops([
      { route_id: 'UR', stop_id: 'USED_S', direction_id: 0, stop_sequence: 0, _snapped: false },
      { route_id: 'UR', stop_id: 'UNUSED_S', direction_id: 0, stop_sequence: 1, _snapped: false },
    ]);
    s().setFrequencies([]);
    s().setFlexZones([]);

    const unusedMsgs = runValidation(s()).filter((m) => m.entity_id === 'UNUSED_S');
    assert('27c: unused stop warning fires', unusedMsgs.length === 1, `got ${unusedMsgs.length}: ${unusedMsgs.map((m) => m.message).join(';')}`);
    assert('27c: message has entity_id UNUSED_S', unusedMsgs[0]?.entity_id === 'UNUSED_S');
    assert('27c: message carries delete-unused-stop fix', unusedMsgs[0]?.fix?.id === 'delete-unused-stop');

    const unusedResult = applyValidationFixBatch(unusedMsgs);
    assert('27c: fix reports changed', !!unusedResult && unusedResult.changed === true);
    assert('27c: UNUSED_S removed from stops', !s().stops.some((st) => st.stop_id === 'UNUSED_S'));
    assert('27c: UNUSED_S route_stop removed', !s().routeStops.some((rs) => rs.stop_id === 'UNUSED_S'));
    assert('27c: USED_S still in stops', s().stops.some((st) => st.stop_id === 'USED_S'));
    assert('27c: USED_S route_stop intact', s().routeStops.some((rs) => rs.stop_id === 'USED_S'));

    const unusedAfter = runValidation(s()).filter((m) => m.entity_id === 'UNUSED_S');
    assert('27c: re-validation clears unused-stop warning', unusedAfter.length === 0);

    unusedResult!.undo();
    assert('27c: undo restores UNUSED_S stop', s().stops.some((st) => st.stop_id === 'UNUSED_S'));
    assert('27c: undo restores UNUSED_S route_stop', s().routeStops.some((rs) => rs.stop_id === 'UNUSED_S'));
    assert('27c: USED_S still present after undo', s().stops.some((st) => st.stop_id === 'USED_S'));

    s().setStops([]);
    s().setTrips([]);
    s().setStopTimes([]);
    s().setFrequencies([]);
    s().setRouteStops([]);
  }

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
