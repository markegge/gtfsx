// GTFS-Flex validation rules (services/validation.ts). Covers the zone/geography
// shape checks, the shared stops.txt / locations.geojson / location_groups.txt id
// namespace, GeoJSON geometry, the pickup/drop-off window, the service pattern,
// and the booking_rules.txt conditional requirements keyed on booking_type
// (gtfs.org/community/extensions/flex). Every rule carries a stable code from
// VALIDATION_CODES, so the assertions key off codes, not message text.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { runValidation, VALIDATION_CODES, DISMISSIBLE_RULE_LABELS } from '../validation';
import type { BookingRule, FlexZone } from '../../store/flexSlice';

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

/** A fully valid polygon zone — every flex rule passes. Override to break one. */
function zone(extra: Partial<FlexZone> & Pick<FlexZone, 'id'>): FlexZone {
  return {
    name: 'Dial-a-Ride',
    bufferMiles: 0,
    geojson: fc(square(-111, 45)),
    serviceId: 'wk',
    pickupWindowStart: '06:00:00',
    pickupWindowEnd: '22:00:00',
    bookingRule: { bookingType: 1, priorNoticeDurationMin: 60 },
    ...extra,
  };
}

function booking(extra: Partial<BookingRule> & Pick<BookingRule, 'bookingType'>): BookingRule {
  return { ...extra };
}

/** Run the validator over one zone and return the codes it emitted. */
function codesFor(z: FlexZone): string[] {
  useStore.getState().setFlexZones([z]);
  return runValidation(useStore.getState()).map((m) => m.code).filter((c): c is string => !!c);
}

/** Every flex message the validator emitted (code + severity), for one zone. */
function flexMessages(z: FlexZone) {
  useStore.getState().setFlexZones([z]);
  return runValidation(useStore.getState()).filter((m) => m.entity_type === 'flex_zone');
}

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20991231' } as never]);
  s.setCalendarDates([]);
  s.setRoutes([]);
  s.setRouteStops([]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setFlexZones([]);
  s.setFeatureSettings({});
  s.setDismissedValidations([]);
});

describe('the flex rules actually fire (regression: reported as silent)', () => {
  it('a zone with no window, no service_id and no booking rule emits all three notices exactly once', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      pickupWindowStart: undefined,
      pickupWindowEnd: undefined,
      serviceId: undefined,
      bookingRule: undefined,
    }));
    const codes = msgs.map((m) => m.code);
    expect(codes).toContain(VALIDATION_CODES.flexNoPickupWindow);
    expect(codes).toContain(VALIDATION_CODES.flexMissingBookingRule);
    // Consolidated: each problem is reported ONCE, not twice (the old validator
    // warned "no pickup window" from two separate blocks).
    expect(codes.filter((c) => c === VALIDATION_CODES.flexNoPickupWindow)).toHaveLength(1);
    expect(codes.filter((c) => c === VALIDATION_CODES.flexMissingBookingRule)).toHaveLength(1);
    // Every flex message deep-links to the zone and carries a dismissible code.
    for (const m of msgs) {
      expect(m.entity_id).toBe('fz');
      expect(m.code).toBeTruthy();
      expect(DISMISSIBLE_RULE_LABELS[m.code!]).toBeTruthy();
    }
  });

  it('fires even when the demandResponse feature is switched off', () => {
    useStore.getState().setFeatureSetting('demandResponse', false);
    const codes = codesFor(zone({ id: 'fz', pickupWindowStart: undefined, pickupWindowEnd: undefined }));
    expect(codes).toContain(VALIDATION_CODES.flexNoPickupWindow);
  });

  it('a fully valid zone emits no flex notices at all', () => {
    expect(flexMessages(zone({ id: 'fz' }))).toHaveLength(0);
  });
});

describe('flex service area + stop group', () => {
  it('a zone with neither polygon nor group warns', () => {
    const codes = codesFor(zone({ id: 'fz', geojson: fc() }));
    expect(codes).toContain(VALIDATION_CODES.flexNoServiceArea);
  });

  it('a stop group with no stops warns; a group with an unknown stop errors', () => {
    expect(codesFor(zone({ id: 'fz', geojson: fc(), stopIds: [] })))
      .toContain(VALIDATION_CODES.flexEmptyStopGroup);

    const msgs = flexMessages(zone({ id: 'fz', geojson: fc(), stopIds: ['nope'] }));
    const unknown = msgs.find((m) => m.code === VALIDATION_CODES.flexUnknownGroupStop);
    expect(unknown?.severity).toBe('error');
  });

  it('a group listing the same stop twice warns', () => {
    useStore.getState().setStops([
      { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111 } as never,
    ]);
    const codes = codesFor(zone({ id: 'fz', geojson: fc(), stopIds: ['s1', 's1'] }));
    expect(codes).toContain(VALIDATION_CODES.flexDuplicateGroupStop);
  });
});

describe('duplicate_geography_id — stops / locations / location_groups share one namespace', () => {
  it('a zone id colliding with a stop_id is an error', () => {
    useStore.getState().setStops([
      { stop_id: 'downtown', stop_name: 'Downtown', stop_lat: 45, stop_lon: -111 } as never,
    ]);
    const msgs = flexMessages(zone({ id: 'downtown' }));
    const dup = msgs.find((m) => m.code === VALIDATION_CODES.flexDuplicateGeographyId);
    expect(dup?.severity).toBe('error');
    expect(dup?.message).toContain('downtown');
    expect(dup?.entity_id).toBe('downtown');
  });

  it("a zone's location_group_id colliding with another zone's location id is an error", () => {
    useStore.getState().setStops([
      { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111 } as never,
    ]);
    // Zone "north" has a stop group → location_group_id "north-group", which is
    // exactly the polygon location id of the second zone.
    useStore.getState().setFlexZones([
      zone({ id: 'north', stopIds: ['s1'] }),
      zone({ id: 'north-group', geojson: fc(square(-110, 46)) }),
    ]);
    const dups = runValidation(useStore.getState())
      .filter((m) => m.code === VALIDATION_CODES.flexDuplicateGeographyId);
    expect(dups).toHaveLength(1);
    expect(dups[0].message).toContain('north-group');
  });

  it('a stop_id that no zone touches is not flagged', () => {
    useStore.getState().setStops([
      { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111 } as never,
    ]);
    expect(codesFor(zone({ id: 'fz' }))).not.toContain(VALIDATION_CODES.flexDuplicateGeographyId);
  });
});

describe('flex geometry (locations.geojson)', () => {
  it('a non-polygon geometry is an error', () => {
    const point: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [-111, 45] },
    };
    const msgs = flexMessages(zone({ id: 'fz', geojson: fc(point) }));
    const bad = msgs.find((m) => m.code === VALIDATION_CODES.flexUnsupportedGeometry);
    expect(bad?.severity).toBe('error');
    expect(bad?.message).toContain('Point');
  });

  it('a ring with fewer than 4 positions is an error', () => {
    const degenerate: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[-111, 45], [-111, 46], [-111, 45]]] },
    };
    const msgs = flexMessages(zone({ id: 'fz', geojson: fc(degenerate) }));
    expect(msgs.find((m) => m.code === VALIDATION_CODES.flexInvalidGeometry)?.severity).toBe('error');
  });

  it('an unclosed ring is an error', () => {
    const unclosed: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[-111, 45], [-111, 45.05], [-110.95, 45.05], [-110.95, 45]]],
      },
    };
    expect(codesFor(zone({ id: 'fz', geojson: fc(unclosed) })))
      .toContain(VALIDATION_CODES.flexInvalidGeometry);
  });

  it('a well-formed MultiPolygon passes', () => {
    const multi: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[-111, 45], [-111, 45.05], [-110.95, 45.05], [-110.95, 45], [-111, 45]]],
          [[[-110, 46], [-110, 46.05], [-109.95, 46.05], [-109.95, 46], [-110, 46]]],
        ],
      },
    };
    expect(flexMessages(zone({ id: 'fz', geojson: fc(multi) }))).toHaveLength(0);
  });
});

describe('flex pickup/drop-off window', () => {
  it('a malformed window time is an error', () => {
    const codes = codesFor(zone({ id: 'fz', pickupWindowStart: '6am' }));
    expect(codes).toContain(VALIDATION_CODES.flexMalformedWindow);
  });

  it('a window that ends before it starts is an error', () => {
    const msgs = flexMessages(zone({ id: 'fz', pickupWindowStart: '22:00:00', pickupWindowEnd: '06:00:00' }));
    expect(msgs.find((m) => m.code === VALIDATION_CODES.flexInvalidWindow)?.severity).toBe('error');
  });

  it('a zero-length window (end === start) is an error too', () => {
    expect(codesFor(zone({ id: 'fz', pickupWindowStart: '08:00:00', pickupWindowEnd: '08:00:00' })))
      .toContain(VALIDATION_CODES.flexInvalidWindow);
  });

  it('a window past midnight (25:00:00) is fine', () => {
    expect(flexMessages(zone({ id: 'fz', pickupWindowStart: '22:00:00', pickupWindowEnd: '25:00:00' })))
      .toHaveLength(0);
  });

  it('an additional window with end before start is an error', () => {
    const codes = codesFor(zone({
      id: 'fz',
      additionalWindows: [{ serviceId: 'wk', pickupWindowStart: '20:00:00', pickupWindowEnd: '18:00:00' }],
    }));
    expect(codes).toContain(VALIDATION_CODES.flexInvalidWindow);
  });
});

describe('flex service pattern', () => {
  it('a zone naming a service_id that does not exist is an error', () => {
    const msgs = flexMessages(zone({ id: 'fz', serviceId: 'gone' }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexUnknownServicePattern);
    expect(m?.severity).toBe('error');
  });

  it('a windowed zone with no calendar.txt row at all is an error (the export would drop it)', () => {
    useStore.getState().setCalendars([]);
    const msgs = flexMessages(zone({ id: 'fz', serviceId: undefined }));
    expect(msgs.find((m) => m.code === VALIDATION_CODES.flexNoServicePattern)?.severity).toBe('error');
  });

  it('a calendar_dates-only service is still not exportable (no calendar.txt fallback)', () => {
    const s = useStore.getState();
    s.setCalendars([]);
    s.setCalendarDates([{ service_id: 'holiday', date: '20260704', exception_type: 1 } as never]);
    const codes = codesFor(zone({ id: 'fz', serviceId: 'holiday' }));
    expect(codes).not.toContain(VALIDATION_CODES.flexUnknownServicePattern);
    expect(codes).toContain(VALIDATION_CODES.flexNoServicePattern);
  });

  it('a zone with no window is not nagged about its service pattern', () => {
    useStore.getState().setCalendars([]);
    const codes = codesFor(zone({
      id: 'fz', serviceId: undefined, pickupWindowStart: undefined, pickupWindowEnd: undefined,
    }));
    expect(codes).not.toContain(VALIDATION_CODES.flexNoServicePattern);
  });
});

describe('booking_rules.txt — missing_pickup_drop_off_booking_rule_id', () => {
  it('pickup_type/drop_off_type 2 (the default) with no booking rule warns once', () => {
    const msgs = flexMessages(zone({ id: 'fz', bookingRule: undefined }));
    const m = msgs.filter((x) => x.code === VALIDATION_CODES.flexMissingBookingRule);
    expect(m).toHaveLength(1);
    expect(m[0].severity).toBe('warning');
  });

  it('a zone that neither picks up nor drops off on request needs no booking rule', () => {
    const codes = codesFor(zone({ id: 'fz', bookingRule: undefined, pickupType: 1, dropOffType: 1 }));
    expect(codes).not.toContain(VALIDATION_CODES.flexMissingBookingRule);
  });
});

describe('booking_type=0 (real time) — every prior_notice_* field is forbidden', () => {
  it('flags a stale prior-notice field left behind by a booking-type switch', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({ bookingType: 0, priorNoticeDurationMin: 60 }),
    }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexForbiddenRealTimeBookingField);
    expect(m?.severity).toBe('error');
    expect(m?.message).toContain('prior_notice_duration_min');
  });

  it('names every offending field in one message', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 0,
        priorNoticeLastDay: 1,
        priorNoticeLastTime: '17:00:00',
        priorNoticeServiceId: 'wk',
      }),
    }));
    const forbidden = msgs.filter((x) => x.code === VALIDATION_CODES.flexForbiddenRealTimeBookingField);
    expect(forbidden).toHaveLength(1);
    expect(forbidden[0].message).toContain('prior_notice_last_day');
    expect(forbidden[0].message).toContain('prior_notice_last_time');
    expect(forbidden[0].message).toContain('prior_notice_service_id');
  });

  it('a clean real-time rule passes', () => {
    expect(flexMessages(zone({
      id: 'fz',
      bookingRule: booking({ bookingType: 0, phoneNumber: '406-555-0100' }),
    }))).toHaveLength(0);
  });
});

describe('booking_type=1 (same day)', () => {
  it('missing prior_notice_duration_min is an error', () => {
    const msgs = flexMessages(zone({ id: 'fz', bookingRule: booking({ bookingType: 1 }) }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexMissingPriorNoticeDurationMin);
    expect(m?.severity).toBe('error');
  });

  it('prior-day fields are forbidden', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({ bookingType: 1, priorNoticeDurationMin: 60, priorNoticeLastDay: 1 }),
    }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexForbiddenSameDayBookingField);
    expect(m?.severity).toBe('error');
    expect(m?.message).toContain('prior_notice_last_day');
  });

  it('prior_notice_start_day + prior_notice_duration_max are mutually exclusive', () => {
    const codes = codesFor(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 1,
        priorNoticeDurationMin: 60,
        priorNoticeDurationMax: 1440,
        priorNoticeStartDay: 2,
        priorNoticeStartTime: '09:00:00',
      }),
    }));
    expect(codes).toContain(VALIDATION_CODES.flexForbiddenPriorNoticeStartDay);
  });

  it('prior_notice_start_day with no start_time is an error', () => {
    const codes = codesFor(zone({
      id: 'fz',
      bookingRule: booking({ bookingType: 1, priorNoticeDurationMin: 60, priorNoticeStartDay: 2 }),
    }));
    expect(codes).toContain(VALIDATION_CODES.flexMissingPriorNoticeStartTime);
  });

  it('duration_max below duration_min is an error', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({ bookingType: 1, priorNoticeDurationMin: 120, priorNoticeDurationMax: 60 }),
    }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexInvalidPriorNoticeDurationMin);
    expect(m?.severity).toBe('error');
  });

  it('a clean same-day rule passes', () => {
    expect(flexMessages(zone({
      id: 'fz',
      bookingRule: booking({ bookingType: 1, priorNoticeDurationMin: 60, priorNoticeDurationMax: 1440 }),
    }))).toHaveLength(0);
  });
});

describe('booking_type=2 (prior day)', () => {
  it('last_day and last_time are each required, and a rule missing both gets BOTH notices', () => {
    // Matches the canonical validator, which emits missing_prior_notice_last_day
    // and missing_prior_notice_last_time independently rather than chaining them.
    const msgs = flexMessages(zone({ id: 'fz', bookingRule: booking({ bookingType: 2 }) }));
    expect(msgs.find((x) => x.code === VALIDATION_CODES.flexMissingPriorNoticeLastDay)?.severity).toBe('error');
    expect(msgs.find((x) => x.code === VALIDATION_CODES.flexMissingPriorNoticeLastTime)?.severity).toBe('error');
  });

  it('last_day set with no last_time is an error', () => {
    const codes = codesFor(zone({
      id: 'fz', bookingRule: booking({ bookingType: 2, priorNoticeLastDay: 1 }),
    }));
    expect(codes).toContain(VALIDATION_CODES.flexMissingPriorNoticeLastTime);
    expect(codes).not.toContain(VALIDATION_CODES.flexMissingPriorNoticeLastDay);
  });

  it('prior_notice_start_day with no start_time is an error on prior-day booking too', () => {
    // The spec pairs start_day/start_time on BOTH booking types; the canonical
    // validator flags it here as well, not only on booking_type=1.
    const codes = codesFor(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 2,
        priorNoticeLastDay: 1,
        priorNoticeLastTime: '17:00:00',
        priorNoticeStartDay: 14,
      }),
    }));
    expect(codes).toContain(VALIDATION_CODES.flexMissingPriorNoticeStartTime);
  });

  it('the same-day duration fields are forbidden', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 2,
        priorNoticeLastDay: 1,
        priorNoticeLastTime: '17:00:00',
        priorNoticeDurationMin: 60,
      }),
    }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexForbiddenPriorDayBookingField);
    expect(m?.severity).toBe('error');
    expect(m?.message).toContain('prior_notice_duration_min');
  });

  it('prior_notice_start_time without start_day is forbidden', () => {
    const codes = codesFor(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 2,
        priorNoticeLastDay: 1,
        priorNoticeLastTime: '17:00:00',
        priorNoticeStartTime: '09:00:00',
      }),
    }));
    expect(codes).toContain(VALIDATION_CODES.flexForbiddenPriorNoticeStartTime);
  });

  it('booking that closes before it opens (last_day > start_day) is an error', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 2,
        priorNoticeLastDay: 5,
        priorNoticeLastTime: '17:00:00',
        priorNoticeStartDay: 2,
        priorNoticeStartTime: '09:00:00',
      }),
    }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexPriorNoticeLastDayAfterStartDay);
    expect(m?.severity).toBe('error');
  });

  it('prior_notice_service_id must resolve', () => {
    const msgs = flexMessages(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 2,
        priorNoticeLastDay: 1,
        priorNoticeLastTime: '17:00:00',
        priorNoticeServiceId: 'gone',
      }),
    }));
    const m = msgs.find((x) => x.code === VALIDATION_CODES.flexUnknownPriorNoticeService);
    expect(m?.severity).toBe('error');
  });

  it('a clean prior-day rule (incl. a resolving prior_notice_service_id) passes', () => {
    expect(flexMessages(zone({
      id: 'fz',
      bookingRule: booking({
        bookingType: 2,
        priorNoticeLastDay: 1,
        priorNoticeLastTime: '17:00:00',
        priorNoticeStartDay: 14,
        priorNoticeStartTime: '09:00:00',
        priorNoticeServiceId: 'wk',
      }),
    }))).toHaveLength(0);
  });
});

describe('a demand-response-only feed is not "route-less"', () => {
  it('a zone that will materialize a flex route suppresses "No routes defined"', () => {
    // The flex route is synthesized per zone at export time, so a flex-only feed
    // legitimately has zero routes.txt rows in the editor.
    useStore.getState().setFlexZones([zone({ id: 'fz', routeId: undefined })]);
    const msgs = runValidation(useStore.getState());
    expect(msgs.map((m) => m.message)).not.toContain('No routes defined');
  });

  it('...but a zone that materializes nothing still leaves the warning in place', () => {
    useStore.getState().setFlexZones([
      zone({ id: 'fz', routeId: undefined, pickupWindowStart: undefined, pickupWindowEnd: undefined }),
    ]);
    const msgs = runValidation(useStore.getState());
    expect(msgs.map((m) => m.message)).toContain('No routes defined');
  });
});

describe('a stop served only by a flex stop group is not an orphan', () => {
  it('is not reported "not used by any trip"', () => {
    const s = useStore.getState();
    s.setStops([
      { stop_id: 's1', stop_name: 'Depot', stop_lat: 45, stop_lon: -111 } as never,
      { stop_id: 's2', stop_name: 'Clinic', stop_lat: 45.1, stop_lon: -111 } as never,
    ]);
    // A fixed-route trip touches s2 only, so the unused-stop rule is live.
    s.setRoutes([{ route_id: 'R1', route_short_name: 'R1', route_type: 3 } as never]);
    s.setTrips([{ trip_id: 'T1', route_id: 'R1', service_id: 'wk' } as never]);
    s.setStopTimes([
      { trip_id: 'T1', stop_id: 's2', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' } as never,
    ]);
    // s1 is served ONLY through the flex zone's stop group.
    s.setFlexZones([zone({ id: 'fz', geojson: fc(), stopIds: ['s1'] })]);

    const orphans = runValidation(useStore.getState())
      .filter((m) => m.message.includes('is not used by any trip'));
    expect(orphans.map((m) => m.entity_id)).not.toContain('s1');
  });
});

describe('flex notices are dismissible like every other coded rule', () => {
  it('dismissing a flex code hides only that rule', () => {
    const s = useStore.getState();
    s.setFlexZones([zone({
      id: 'fz', bookingRule: undefined, pickupWindowStart: undefined, pickupWindowEnd: undefined,
    })]);
    s.dismissValidation(VALIDATION_CODES.flexNoPickupWindow);

    const dismissed = useStore.getState().dismissedValidations;
    const visible = runValidation(useStore.getState())
      .filter((m) => !(m.code && dismissed.includes(m.code)));
    const codes = visible.map((m) => m.code);
    expect(codes).not.toContain(VALIDATION_CODES.flexNoPickupWindow);
    expect(codes).toContain(VALIDATION_CODES.flexMissingBookingRule);
  });
});
