// The booking-rule library (GH #58): one named rule, defined once, attached to
// many zones — plus the editors for the booking fields that round-trip but had
// no UI (prior_notice_start_day/_time, pickup/drop_off_message,
// prior_notice_service_id, pickup_type/drop_off_type).
//
// The rule lives on each zone that uses it, keyed by a shared booking_rule_id;
// `flexBookingRules` derives the library from the zones and the export writes
// each rule ONCE. These tests pin the three things that can silently corrupt a
// feed: stale fields left behind by a booking_type switch (Forbidden under the
// new type), a shared rule duplicated across booking_rules.txt rows, and a
// legacy inline rule losing its data on the way into the library.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
import { importGtfsZip } from '../gtfsParse';
import { runValidation } from '../validation';
import {
  bookingRuleIdOf, bookingRuleZones, flexBookingRules, type FlexZone,
} from '../../store/flexSlice';

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

function zone(extra: Partial<FlexZone> & Pick<FlexZone, 'id'>): FlexZone {
  return {
    name: 'Dial-a-Ride',
    bufferMiles: 0,
    geojson: { type: 'FeatureCollection', features: [square(-111, 45)] },
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

async function rows(zip: JSZip, name: string): Promise<Row[]> {
  const f = zip.file(name);
  if (!f) return [];
  return Papa.parse<Row>(await f.async('string'), { header: true, skipEmptyLines: true }).data;
}

async function reimport() {
  const blob = await exportGtfsZip();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return importGtfsZip(bytes as unknown as File);
}

const zones = () => useStore.getState().flexZones;
const zoneById = (id: string) => zones().find((z) => z.id === id)!;
const flexErrors = () => runValidation(useStore.getState())
  .filter((m) => m.severity === 'error' && m.entity_type === 'flex_zone');

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

describe('booking_type switch clears now-forbidden fields', () => {
  it('same-day → prior-day drops prior_notice_duration_min (Forbidden under booking_type=2)', async () => {
    const s = useStore.getState();
    s.setFlexZones([zone({ id: 'fz' })]);
    s.updateFlexZoneBooking('fz', { bookingType: 1, priorNoticeDurationMin: 60, priorNoticeDurationMax: 1440 });
    expect(zoneById('fz').bookingRule?.priorNoticeDurationMin).toBe(60);

    s.updateFlexZoneBooking('fz', { bookingType: 2 });

    const rule = zoneById('fz').bookingRule!;
    expect(rule.bookingType).toBe(2);
    expect(rule.priorNoticeDurationMin).toBeUndefined();
    expect(rule.priorNoticeDurationMax).toBeUndefined();

    // The whole point: the stale field is what made the export invalid.
    s.updateFlexZoneBooking('fz', { priorNoticeLastDay: 1, priorNoticeLastTime: '17:00:00' });
    expect(flexErrors()).toHaveLength(0);
    const booking = (await rows(await exportZip(), 'booking_rules.txt'))[0];
    expect(booking.booking_type).toBe('2');
    expect(booking.prior_notice_duration_min || '').toBe('');
  });

  it('prior-day → same-day drops the last-day/time cutoff and the prior-notice calendar', () => {
    const s = useStore.getState();
    s.setFlexZones([zone({ id: 'fz' })]);
    s.updateFlexZoneBooking('fz', {
      bookingType: 2, priorNoticeLastDay: 1, priorNoticeLastTime: '17:00:00', priorNoticeServiceId: 'wk',
      priorNoticeStartDay: 14, priorNoticeStartTime: '09:00:00',
    });

    s.updateFlexZoneBooking('fz', { bookingType: 1 });

    const rule = zoneById('fz').bookingRule!;
    expect(rule.priorNoticeLastDay).toBeUndefined();
    expect(rule.priorNoticeLastTime).toBeUndefined();
    expect(rule.priorNoticeServiceId).toBeUndefined();
    // start_day/_time stay — they're Optional on same-day booking too.
    expect(rule.priorNoticeStartDay).toBe(14);
    expect(rule.priorNoticeStartTime).toBe('09:00:00');
  });

  it('real-time booking drops every prior-notice field', () => {
    const s = useStore.getState();
    s.setFlexZones([zone({ id: 'fz' })]);
    s.updateFlexZoneBooking('fz', {
      bookingType: 1, priorNoticeDurationMin: 60, priorNoticeStartDay: 3, priorNoticeStartTime: '09:00:00',
    });

    s.updateFlexZoneBooking('fz', { bookingType: 0 });

    const rule = zoneById('fz').bookingRule!;
    expect(rule.bookingType).toBe(0);
    expect(rule.priorNoticeDurationMin).toBeUndefined();
    expect(rule.priorNoticeStartDay).toBeUndefined();
    expect(rule.priorNoticeStartTime).toBeUndefined();
    // Contact details survive — they aren't keyed on booking_type.
    expect(flexErrors()).toHaveLength(0);
  });
});

describe('booking fields with no editor before #58 round-trip', () => {
  it('start day/time, pickup + drop-off messages and the prior-notice calendar survive export → import', async () => {
    const s = useStore.getState();
    s.setFlexZones([zone({ id: 'fz' })]);
    s.updateFlexZoneBooking('fz', {
      bookingType: 2,
      priorNoticeLastDay: 1,
      priorNoticeLastTime: '17:00:00',
      priorNoticeStartDay: 14,
      priorNoticeStartTime: '09:00:00',
      priorNoticeServiceId: 'wk',
      message: 'Call the dispatcher.',
      pickupMessage: 'Wait at the curb.',
      dropOffMessage: 'Tell the driver your stop.',
      bookingUrl: 'https://book.test',
    });
    expect(flexErrors()).toHaveLength(0);

    const booking = (await rows(await exportZip(), 'booking_rules.txt'))[0];
    expect(booking.prior_notice_start_day).toBe('14');
    expect(booking.prior_notice_start_time).toBe('09:00:00');
    expect(booking.prior_notice_service_id).toBe('wk');
    expect(booking.pickup_message).toBe('Wait at the curb.');
    expect(booking.drop_off_message).toBe('Tell the driver your stop.');
    // `name` is a library label, not a spec field.
    expect(Object.keys(booking)).not.toContain('name');

    const back = await reimport();
    const rule = back.flexZones[0].bookingRule!;
    expect(rule.priorNoticeStartDay).toBe(14);
    expect(rule.priorNoticeStartTime).toBe('09:00:00');
    expect(rule.priorNoticeServiceId).toBe('wk');
    expect(rule.message).toBe('Call the dispatcher.');
    expect(rule.pickupMessage).toBe('Wait at the curb.');
    expect(rule.dropOffMessage).toBe('Tell the driver your stop.');
    expect(rule.bookingUrl).toBe('https://book.test');
  });

  it('pickup_type / drop_off_type set in the editor round-trip, and forbidden values never reach the feed', async () => {
    const s = useStore.getState();
    s.setFlexZones([
      zone({ id: 'coord', pickupType: 2, dropOffType: 3 }),
      zone({ id: 'closed', geojson: { type: 'FeatureCollection', features: [square(-110, 44)] }, pickupType: 1, dropOffType: 1 }),
    ]);

    const st = await rows(await exportZip(), 'stop_times.txt');
    const byLoc = (id: string) => st.filter((r) => r.location_id === id);
    expect(byLoc('coord').every((r) => r.pickup_type === '2' && r.drop_off_type === '3')).toBe(true);
    expect(byLoc('closed').every((r) => r.pickup_type === '1' && r.drop_off_type === '1')).toBe(true);
    // pickup_type 0/3 and drop_off_type 0 are Forbidden with a window, so no
    // exported flex row may carry them however the store got into that state.
    expect(st.some((r) => r.pickup_type === '0' || r.pickup_type === '3')).toBe(false);
    expect(st.some((r) => r.drop_off_type === '0')).toBe(false);

    const back = await reimport();
    expect(back.flexZones.find((z) => z.id === 'coord')?.dropOffType).toBe(3);
    expect(back.flexZones.find((z) => z.id === 'closed')?.pickupType).toBe(1);
  });
});

describe('booking-rule library', () => {
  const twoZones = () => {
    const s = useStore.getState();
    s.setFlexZones([
      zone({ id: 'north', name: 'North Zone' }),
      zone({ id: 'south', name: 'South Zone', geojson: { type: 'FeatureCollection', features: [square(-110, 44)] } }),
    ]);
  };

  it('a rule shared by two zones exports as ONE booking_rules.txt row that both reference', async () => {
    const s = useStore.getState();
    twoZones();
    s.createBookingRule('north', { phoneNumber: '406-555-0100' });
    s.updateFlexZoneBooking('north', { bookingType: 1, priorNoticeDurationMin: 60 });
    s.renameBookingRule(bookingRuleIdOf(zoneById('north'))!, 'Call centre');
    const ruleId = bookingRuleIdOf(zoneById('north'))!;
    s.attachBookingRule('south', ruleId);

    expect(flexBookingRules(zones())).toHaveLength(1);
    expect(bookingRuleZones(zones(), ruleId).map((z) => z.id)).toEqual(['north', 'south']);
    expect(flexErrors()).toHaveLength(0);

    const zip = await exportZip();
    const booking = await rows(zip, 'booking_rules.txt');
    expect(booking).toHaveLength(1);
    expect(booking[0].booking_rule_id).toBe(ruleId);
    expect(booking[0].prior_notice_duration_min).toBe('60');
    expect(booking[0].phone_number).toBe('406-555-0100');

    // Both zones' flex rows point at that single rule.
    const st = await rows(zip, 'stop_times.txt');
    expect(st).toHaveLength(4);
    for (const id of ['north', 'south']) {
      const rowsFor = st.filter((r) => r.location_id === id);
      expect(rowsFor).toHaveLength(2);
      expect(rowsFor.every((r) => r.pickup_booking_rule_id === ruleId && r.drop_off_booking_rule_id === ruleId)).toBe(true);
    }

    // …and it comes back as ONE shared rule, still on both zones.
    const back = await reimport();
    useStore.getState().setFlexZones(back.flexZones);
    expect(flexBookingRules(zones())).toHaveLength(1);
    expect(bookingRuleZones(zones(), ruleId)).toHaveLength(2);
  });

  it('editing a shared rule updates every zone using it; a per-zone rule stays private', () => {
    const s = useStore.getState();
    twoZones();
    s.createBookingRule('north');
    const shared = bookingRuleIdOf(zoneById('north'))!;
    s.attachBookingRule('south', shared);

    s.updateFlexZoneBooking('south', { phoneNumber: '406-555-0199' });
    expect(zoneById('north').bookingRule?.phoneNumber).toBe('406-555-0199');

    // A zone given its OWN new rule stops tracking the shared one.
    s.createBookingRule('south');
    const own = bookingRuleIdOf(zoneById('south'))!;
    expect(own).not.toBe(shared);
    s.updateFlexZoneBooking('south', { phoneNumber: '406-555-0000' });
    expect(zoneById('north').bookingRule?.phoneNumber).toBe('406-555-0199');
    expect(flexBookingRules(zones())).toHaveLength(2);
  });

  it('renaming touches every zone, and deleting a shared rule detaches it cleanly', () => {
    const s = useStore.getState();
    twoZones();
    s.createBookingRule('north');
    const ruleId = bookingRuleIdOf(zoneById('north'))!;
    s.attachBookingRule('south', ruleId);

    s.renameBookingRule(ruleId, 'Call centre');
    expect(zones().map((z) => z.bookingRule?.name)).toEqual(['Call centre', 'Call centre']);

    s.deleteBookingRule(ruleId);
    expect(zones().every((z) => z.bookingRule === undefined)).toBe(true);
    expect(flexBookingRules(zones())).toHaveLength(0);
    // No zone is left pointing at a rule that isn't there.
    expect(zones().every((z) => bookingRuleIdOf(z) === undefined)).toBe(true);
  });
});

describe('legacy inline booking rules migrate into the library', () => {
  it('a zone saved by the old code keeps its rule, its data, and its exported booking_rule_id', async () => {
    const legacy = zone({
      id: 'fz',
      name: 'Dial-a-Ride',
      // Exactly the shape older code (and IndexedDB-persisted projects) hold:
      // an inline rule with no id and no name.
      bookingRule: {
        bookingType: 1,
        priorNoticeDurationMin: 60,
        phoneNumber: '406-555-0100',
        message: 'Call ahead.',
      },
    });
    useStore.getState().setFlexZones([legacy]);

    const rule = zoneById('fz').bookingRule!;
    expect(rule.id).toBe('fz-booking');
    expect(rule.name).toBe('Dial-a-Ride booking');
    expect(rule.bookingType).toBe(1);
    expect(rule.priorNoticeDurationMin).toBe(60);
    expect(rule.phoneNumber).toBe('406-555-0100');
    expect(rule.message).toBe('Call ahead.');

    // It's a library rule now — attachable to another zone.
    const library = flexBookingRules(zones());
    expect(library).toHaveLength(1);
    expect(library[0].id).toBe('fz-booking');

    // And the feed it exports is unchanged: same id the old exporter derived.
    const booking = await rows(await exportZip(), 'booking_rules.txt');
    expect(booking).toHaveLength(1);
    expect(booking[0].booking_rule_id).toBe('fz-booking');
    expect(booking[0].prior_notice_duration_min).toBe('60');
  });

  it('a feed with one identical rule per zone imports as a single shared rule and re-exports as one row', async () => {
    // What our own pre-library exporter wrote: `north-booking` and
    // `south-booking`, byte-identical apart from the id.
    const s = useStore.getState();
    s.setFlexZones([
      zone({
        id: 'north', name: 'North Zone',
        bookingRule: { bookingType: 1, priorNoticeDurationMin: 60, phoneNumber: '406-555-0100' },
      }),
      zone({
        id: 'south', name: 'South Zone',
        geojson: { type: 'FeatureCollection', features: [square(-110, 44)] },
        bookingRule: { bookingType: 1, priorNoticeDurationMin: 60, phoneNumber: '406-555-0100' },
      }),
    ]);
    expect(await rows(await exportZip(), 'booking_rules.txt')).toHaveLength(2);

    const back = await reimport();
    s.setFlexZones(back.flexZones);

    // One rule in the library, used by both zones — nothing retyped, nothing lost.
    const library = flexBookingRules(zones());
    expect(library).toHaveLength(1);
    expect(library[0].priorNoticeDurationMin).toBe(60);
    expect(library[0].phoneNumber).toBe('406-555-0100');
    expect(bookingRuleZones(zones(), library[0].id!).map((z) => z.id)).toEqual(['north', 'south']);

    const zip = await exportZip();
    expect(await rows(zip, 'booking_rules.txt')).toHaveLength(1);
    const st = await rows(zip, 'stop_times.txt');
    expect(new Set(st.map((r) => r.pickup_booking_rule_id))).toEqual(new Set([library[0].id]));
  });

  it('rules that differ anywhere stay separate on import', async () => {
    const s = useStore.getState();
    s.setFlexZones([
      zone({ id: 'north', bookingRule: { bookingType: 1, priorNoticeDurationMin: 60 } }),
      zone({
        id: 'south',
        geojson: { type: 'FeatureCollection', features: [square(-110, 44)] },
        bookingRule: { bookingType: 1, priorNoticeDurationMin: 90 },
      }),
    ]);

    const back = await reimport();
    s.setFlexZones(back.flexZones);
    expect(flexBookingRules(zones())).toHaveLength(2);
    expect(zoneById('north').bookingRule?.priorNoticeDurationMin).toBe(60);
    expect(zoneById('south').bookingRule?.priorNoticeDurationMin).toBe(90);
    expect(await rows(await exportZip(), 'booking_rules.txt')).toHaveLength(2);
  });
});
