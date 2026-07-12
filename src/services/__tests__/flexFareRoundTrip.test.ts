// A flex zone's fare rides on the route materializeFlex synthesizes for it, so
// the exported fare_rules row points at a route that only exists in the zip.
// Import drops that route (the zone re-creates it), which would strand the rule
// pointing at a route_id nothing defines — a dangling reference that blocks the
// next export. The fare has to come back onto the zone instead.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
import { importGtfsZip } from '../gtfsParse';

type Row = Record<string, string>;

const SQUARE: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[-111, 45], [-111, 45.05], [-110.95, 45.05], [-110.95, 45], [-111, 45]]],
    },
  }],
};

async function exportBytes(): Promise<Uint8Array> {
  const blob = await exportGtfsZip();
  return new Uint8Array(await blob.arrayBuffer());
}

async function rows(bytes: Uint8Array, name: string): Promise<Row[]> {
  const zip = await JSZip.loadAsync(bytes);
  const f = zip.file(name);
  if (!f) return [];
  return Papa.parse<Row>(await f.async('string'), { header: true, skipEmptyLines: true }).data;
}

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setCalendarDates([]);
  // The zone is paired with an AUTHORED route whose id is unrelated to the zone
  // id, as a real feed's is. A synthesized `${zone.id}-route` id would happen to
  // regenerate identically on re-export and mask the dangling reference.
  s.setRoutes([{ route_id: 'route-mqoatwpi-11', agency_id: 'A', route_short_name: 'DAR', route_type: 715 } as never]);
  s.setRouteStops([]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setFareAttributes([{ fare_id: 'flexfare', price: '2.50', currency_type: 'USD', payment_method: 0, transfers: 0 } as never]);
  s.setFareRules([]);
  s.setFlexZones([{
    id: 'dar',
    name: 'Dial-a-Ride',
    bufferMiles: 0,
    geojson: SQUARE,
    serviceId: 'wk',
    pickupWindowStart: '06:00:00',
    pickupWindowEnd: '22:00:00',
    routeId: 'route-mqoatwpi-11',
    fareId: 'flexfare',
  }]);
});

describe('flex zone fare round-trip', () => {
  it('exports a fare_rules row pointing at the zone\'s synthesized route', async () => {
    const bytes = await exportBytes();
    const routes = await rows(bytes, 'routes.txt');
    const fareRules = await rows(bytes, 'fare_rules.txt');

    expect(fareRules).toHaveLength(1);
    expect(fareRules[0].fare_id).toBe('flexfare');
    expect(routes.map((r) => r.route_id)).toContain(fareRules[0].route_id);
  });

  it('re-importing keeps the fare on the zone and leaves no dangling fare_rules row', async () => {
    const parsed = await importGtfsZip(await exportBytes() as unknown as File);

    expect(parsed.flexZones).toHaveLength(1);
    expect(parsed.flexZones[0].fareId).toBe('flexfare');

    const routeIds = new Set(parsed.routes.map((r) => r.route_id));
    for (const rule of parsed.fareRules) {
      if (rule.route_id) expect(routeIds.has(rule.route_id)).toBe(true);
    }
  });

  it('survives a second export: the fare rule is re-emitted against the live route', async () => {
    const parsed = await importGtfsZip(await exportBytes() as unknown as File);
    const s = useStore.getState();
    s.setRoutes(parsed.routes as never);
    s.setTrips(parsed.trips as never);
    s.setStopTimes(parsed.stopTimes as never);
    s.setFareRules(parsed.fareRules as never);
    s.setFlexZones(parsed.flexZones);

    const bytes = await exportBytes();
    const routeIds = new Set((await rows(bytes, 'routes.txt')).map((r) => r.route_id));
    const fareRules = await rows(bytes, 'fare_rules.txt');

    expect(fareRules).toHaveLength(1);
    expect(fareRules[0].fare_id).toBe('flexfare');
    expect(routeIds.has(fareRules[0].route_id)).toBe(true);
  });
});
