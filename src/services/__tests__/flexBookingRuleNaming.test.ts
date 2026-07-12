// booking_rules.txt has no name column, so an imported rule is labelled with its
// own id. For the ids we generate ourselves (`<zone id>-booking`) that puts a
// slug like "flex-zone-1782077330646-booking" in front of the user as the rule's
// name. Name those after the zone instead, but never overwrite a meaningful id a
// third-party feed chose: that is the best label the feed gave us.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
import { importGtfsZip } from '../gtfsParse';
import type { FlexZone } from '../../store/flexSlice';

const SQUARE = (lon: number): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [[[lon, 45], [lon, 45.05], [lon + 0.05, 45.05], [lon + 0.05, 45], [lon, 45]]],
    },
  }],
});

function zone(id: string, name: string, lon: number, ruleId: string, ruleName: string): FlexZone {
  return {
    id,
    name,
    bufferMiles: 0,
    geojson: SQUARE(lon),
    serviceId: 'wk',
    pickupWindowStart: '06:00:00',
    pickupWindowEnd: '22:00:00',
    bookingRule: { id: ruleId, name: ruleName, bookingType: 0, phoneNumber: '406-555-0100' },
  };
}

async function reimport() {
  const blob = await exportGtfsZip();
  return importGtfsZip(new Uint8Array(await blob.arrayBuffer()) as unknown as File);
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

describe('imported booking-rule names', () => {
  it('names a rule after its zone when the id is one we generated', async () => {
    useStore.getState().setFlexZones([
      zone('dar', 'Northside Dial-a-Ride', -111, 'dar-booking', 'dar-booking'),
    ]);

    const parsed = await reimport();

    expect(parsed.flexZones).toHaveLength(1);
    expect(parsed.flexZones[0].bookingRule?.name).toBe('Northside Dial-a-Ride booking');
    // The id itself is untouched — it is what booking_rules.txt keys on.
    expect(parsed.flexZones[0].bookingRule?.id).toBe('dar-booking');
  });

  it('keeps a meaningful id from a third-party feed as the label', async () => {
    // A rule id that is not derived from the zone id is the feed author's own
    // naming, so it stays.
    const z = zone('dar', 'Northside Dial-a-Ride', -111, 'call_center', 'call_center');
    useStore.getState().setFlexZones([z]);

    const parsed = await reimport();

    expect(parsed.flexZones[0].bookingRule?.name).toBe('call_center');
  });

  it('labels a rule shared by several zones by its share count', async () => {
    useStore.getState().setFlexZones([
      zone('north', 'North Zone', -111, 'north-booking', 'north-booking'),
      { ...zone('south', 'South Zone', -110, 'north-booking', 'north-booking') },
    ]);

    const parsed = await reimport();

    expect(parsed.flexZones).toHaveLength(2);
    const names = parsed.flexZones.map((z) => z.bookingRule?.name);
    expect(new Set(names)).toEqual(new Set(['Shared booking rule (2 zones)']));
    // Still ONE row in the file: the library rule is shared, not duplicated.
    const zip = await JSZip.loadAsync(new Uint8Array(await (await exportGtfsZip()).arrayBuffer()));
    const csv = await zip.file('booking_rules.txt')!.async('string');
    expect(csv.trim().split('\n')).toHaveLength(2); // header + 1 rule
  });
});
