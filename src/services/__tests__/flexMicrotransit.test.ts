// GTFS-Flex spec correctness for the canonical microtransit case: a service area
// a rider gets on and off inside. The spec requires TWO stop_times records with
// the SAME location_id (travel within one location), a top-level `id` on every
// locations.geojson Feature, safe_duration_* on trips.txt (not stop_times), and
// no pickup_type 0/3 or drop_off_type 0 on a row with a window.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
import { importGtfsZip } from '../gtfsParse';
import type { FlexZone } from '../../store/flexSlice';

type Row = Record<string, string>;

function square(lon: number, lat: number): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [lon, lat], [lon, lat + 0.05], [lon + 0.05, lat + 0.05], [lon + 0.05, lat], [lon, lat],
      ]],
    },
  };
}

function fc(...features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features };
}

function zone(extra: Partial<FlexZone> & Pick<FlexZone, 'id'>): FlexZone {
  return {
    name: 'Dial-a-Ride',
    bufferMiles: 0,
    geojson: fc(square(-111, 45)),
    serviceId: 'wk',
    pickupWindowStart: '06:00:00',
    pickupWindowEnd: '22:00:00',
    ...extra,
  };
}

async function exportZip(): Promise<JSZip> {
  const blob = await exportGtfsZip();
  return JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
}

async function text(zip: JSZip, name: string): Promise<string | null> {
  const f = zip.file(name);
  return f ? f.async('string') : null;
}

async function rows(zip: JSZip, name: string): Promise<Row[]> {
  const csv = await text(zip, name);
  if (!csv) return [];
  return Papa.parse<Row>(csv, { header: true, skipEmptyLines: true }).data;
}

async function locations(zip: JSZip): Promise<GeoJSON.FeatureCollection | null> {
  const json = await text(zip, 'locations.geojson');
  return json ? (JSON.parse(json) as GeoJSON.FeatureCollection) : null;
}

async function reimport() {
  const blob = await exportGtfsZip();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return importGtfsZip(bytes as unknown as File);
}

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setCalendarDates([]);
  s.setRoutes([]);
  s.setRouteStops([]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setFlexZones([]);
});

describe('GTFS-Flex microtransit export', () => {
  it('a single-polygon zone round-trips as one location with two stop_times records', async () => {
    useStore.getState().setFlexZones([
      zone({
        id: 'fz',
        bookingRule: { bookingType: 1, priorNoticeDurationMin: 60, phoneNumber: '406-555-0100' },
      }),
    ]);

    const zip = await exportZip();

    // locations.geojson — one Feature, top-level id, Polygon, stop_name only.
    const geo = await locations(zip);
    expect(geo!.features).toHaveLength(1);
    const feature = geo!.features[0];
    expect(feature.id).toBe('fz');
    expect(feature.geometry.type).toBe('Polygon');
    expect(Object.keys(feature.properties as Row)).toEqual(['stop_name']);
    expect((feature.properties as Row).stop_name).toBe('Dial-a-Ride');

    // stop_times.txt — TWO records, same location_id, no arrival/departure.
    const st = await rows(zip, 'stop_times.txt');
    expect(st).toHaveLength(2);
    expect(st.map((r) => r.stop_sequence)).toEqual(['1', '2']);
    for (const r of st) {
      expect(r.trip_id).toBe('fz-trip');
      expect(r.location_id).toBe('fz');
      expect(r.start_pickup_drop_off_window).toBe('06:00:00');
      expect(r.end_pickup_drop_off_window).toBe('22:00:00');
      expect(r.pickup_type).toBe('2');
      expect(r.drop_off_type).toBe('2');
      expect(r.arrival_time || '').toBe('');
      expect(r.departure_time || '').toBe('');
      expect(r.stop_id || '').toBe('');
    }

    // booking_rules.txt + the synthesized 715 route.
    const booking = await rows(zip, 'booking_rules.txt');
    expect(booking).toHaveLength(1);
    expect(booking[0].booking_rule_id).toBe('fz-booking');
    expect(booking[0].booking_type).toBe('1');
    expect(booking[0].prior_notice_duration_min).toBe('60');
    const routes = await rows(zip, 'routes.txt');
    expect(routes).toHaveLength(1);
    expect(routes[0].route_type).toBe('715');

    // Re-import: zone, window, booking rule and service_id all survive.
    const back = await reimport();
    expect(back.flexZones).toHaveLength(1);
    const z = back.flexZones[0];
    expect(z.id).toBe('fz');
    expect(z.name).toBe('Dial-a-Ride');
    expect(z.pickupWindowStart).toBe('06:00:00');
    expect(z.pickupWindowEnd).toBe('22:00:00');
    expect(z.serviceId).toBe('wk');
    expect(z.bookingRule?.bookingType).toBe(1);
    expect(z.bookingRule?.priorNoticeDurationMin).toBe(60);
    expect(z.bookingRule?.phoneNumber).toBe('406-555-0100');
    // The duplicated record must NOT read back as a second service window.
    expect(z.additionalWindows).toBeUndefined();
    expect(z.geojson.features).toHaveLength(1);
  });

  it('a multi-polygon zone exports ONE MultiPolygon feature with no orphans', async () => {
    useStore.getState().setFlexZones([
      zone({ id: 'fz', geojson: fc(square(-111, 45), square(-110, 46)) }),
    ]);

    const zip = await exportZip();
    const geo = await locations(zip);
    expect(geo!.features).toHaveLength(1);
    const feature = geo!.features[0];
    expect(feature.id).toBe('fz');
    expect(feature.geometry.type).toBe('MultiPolygon');
    expect((feature.geometry as GeoJSON.MultiPolygon).coordinates).toHaveLength(2);

    // Both stop_times records point at the single location id.
    const st = await rows(zip, 'stop_times.txt');
    expect(st).toHaveLength(2);
    expect(st.every((r) => r.location_id === 'fz')).toBe(true);

    const back = await reimport();
    expect(back.flexZones).toHaveLength(1);
    expect(back.flexZones[0].id).toBe('fz');
    expect(back.flexZones[0].geojson.features).toHaveLength(1);
    expect(back.flexZones[0].geojson.features[0].geometry.type).toBe('MultiPolygon');
  });

  it('a deviated fixed route exports timed rows and flex rows side by side', async () => {
    const s = useStore.getState();
    s.setRoutes([{ route_id: 'R1', agency_id: 'A', route_short_name: 'R1', route_long_name: 'Route 1', route_type: 3 } as never]);
    s.setStops([
      { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never,
      { stop_id: 's2', stop_name: 'B', stop_lat: 45.02, stop_lon: -111, wheelchair_boarding: 0 } as never,
    ]);
    s.setTrips([{ trip_id: 'T1', route_id: 'R1', service_id: 'wk', direction_id: 0 } as never]);
    s.setStopTimes([
      { trip_id: 'T1', arrival_time: '06:00:00', departure_time: '06:00:00', stop_id: 's1', stop_sequence: 1 } as never,
      { trip_id: 'T1', arrival_time: '06:20:00', departure_time: '06:20:00', stop_id: 's2', stop_sequence: 2 } as never,
    ]);
    s.setFlexZones([zone({ id: 'fz' })]);

    const zip = await exportZip();
    const st = await rows(zip, 'stop_times.txt');
    expect(st).toHaveLength(4);

    const timed = st.filter((r) => r.trip_id === 'T1');
    expect(timed).toHaveLength(2);
    for (const r of timed) {
      expect(r.arrival_time).toMatch(/^06:\d\d:00$/);
      expect(r.departure_time).toMatch(/^06:\d\d:00$/);
      expect(r.start_pickup_drop_off_window || '').toBe('');
      expect(r.end_pickup_drop_off_window || '').toBe('');
      expect(r.location_id || '').toBe('');
    }

    const flex = st.filter((r) => r.trip_id === 'fz-trip');
    expect(flex).toHaveLength(2);
    for (const r of flex) {
      expect(r.arrival_time || '').toBe('');
      expect(r.departure_time || '').toBe('');
      expect(r.stop_id || '').toBe('');
      expect(r.start_pickup_drop_off_window).toBe('06:00:00');
    }

    const back = await reimport();
    expect(back.stopTimes).toHaveLength(2);
    expect(back.flexZones).toHaveLength(1);
    expect(back.trips.map((t) => t.trip_id)).toEqual(['T1']);
  });

  it('a zone with no service window emits no location, booking rule or trip', async () => {
    useStore.getState().setFlexZones([
      zone({
        id: 'fz',
        pickupWindowStart: undefined,
        pickupWindowEnd: undefined,
        bookingRule: { bookingType: 0, phoneNumber: '406-555-0100' },
      }),
    ]);

    const zip = await exportZip();
    expect(await text(zip, 'locations.geojson')).toBeNull();
    expect(await text(zip, 'booking_rules.txt')).toBeNull();
    expect(await text(zip, 'trips.txt')).toBeNull();
    expect(await text(zip, 'stop_times.txt')).toBeNull();
  });

  it('a zone id ending in -1 is not mangled on re-import', async () => {
    useStore.getState().setFlexZones([
      zone({ id: 'dial-a-ride-1', name: 'Dial-a-Ride 1', geojson: fc(square(-111, 45), square(-110, 46)) }),
    ]);

    const zip = await exportZip();
    const geo = await locations(zip);
    expect(geo!.features[0].id).toBe('dial-a-ride-1');

    const back = await reimport();
    expect(back.flexZones).toHaveLength(1);
    expect(back.flexZones[0].id).toBe('dial-a-ride-1');
    expect(back.flexZones[0].name).toBe('Dial-a-Ride 1');
    expect(back.flexZones[0].pickupWindowStart).toBe('06:00:00');
  });

  it('pickup_type / drop_off_type round-trip, and forbidden values are clamped to 2', async () => {
    useStore.getState().setFlexZones([
      zone({ id: 'ok', pickupType: 1, dropOffType: 3 }),
      // Forbidden with a window defined: pickup_type 0/3 and drop_off_type 0.
      zone({ id: 'bad', geojson: fc(square(-109, 44)), pickupType: 3, dropOffType: 0 }),
      zone({ id: 'zero', geojson: fc(square(-108, 43)), pickupType: 0, dropOffType: 0 }),
    ]);

    const zip = await exportZip();
    const st = await rows(zip, 'stop_times.txt');
    const byLoc = (id: string) => st.filter((r) => r.location_id === id);

    expect(byLoc('ok').every((r) => r.pickup_type === '1' && r.drop_off_type === '3')).toBe(true);
    expect(byLoc('bad').every((r) => r.pickup_type === '2' && r.drop_off_type === '2')).toBe(true);
    expect(byLoc('zero').every((r) => r.pickup_type === '2' && r.drop_off_type === '2')).toBe(true);

    const back = await reimport();
    const ok = back.flexZones.find((z) => z.id === 'ok');
    expect(ok?.pickupType).toBe(1);
    expect(ok?.dropOffType).toBe(3);
    const bad = back.flexZones.find((z) => z.id === 'bad');
    expect(bad?.pickupType).toBe(2);
    expect(bad?.dropOffType).toBe(2);
  });

  it('safe_duration_* lands on trips.txt and mean_duration_* is never written', async () => {
    useStore.getState().setFlexZones([
      zone({
        id: 'fz',
        safeDurationFactor: 1.5,
        safeDurationOffset: 600,
        meanDurationFactor: 1.0,
        meanDurationOffset: 300,
      }),
    ]);

    const zip = await exportZip();
    const trips = await rows(zip, 'trips.txt');
    expect(trips).toHaveLength(1);
    expect(trips[0].safe_duration_factor).toBe('1.5');
    expect(trips[0].safe_duration_offset).toBe('600');

    const stText = (await text(zip, 'stop_times.txt'))!;
    expect(stText).not.toContain('safe_duration');
    for (const name of Object.keys(zip.files)) {
      expect(await text(zip, name)).not.toContain('mean_duration');
    }

    const back = await reimport();
    expect(back.flexZones[0].safeDurationFactor).toBe(1.5);
    expect(back.flexZones[0].safeDurationOffset).toBe(600);
    expect(back.flexZones[0].meanDurationFactor).toBeUndefined();
  });
});
