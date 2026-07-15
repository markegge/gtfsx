// agency_id presence rules (services/validation.ts) — GTFS spec + FTA NTD.
//
// The GTFS spec only conditionally requires agency_id (it may be omitted in a
// single-agency feed), but FTA's July 10, 2025 final notice (FR 2025-12813)
// made it non-conditional for NTD reporters, INCLUDING in routes.txt: FTA
// crosswalks a feed to the agency's NTD ID on agency_id. So a spec-legal feed
// can still break NTD reporting. Two codes, both dismissible warnings: the
// multi-agency defect and the single-agency advisory.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { runValidation, VALIDATION_CODES, DISMISSIBLE_RULE_LABELS } from '../validation';
import type { Agency, Route } from '../../types/gtfs';

function agency(extra: Partial<Agency>): Agency {
  return {
    agency_id: 'A1',
    agency_name: 'Sample Transit',
    agency_url: 'https://example.test',
    agency_timezone: 'America/Denver',
    ...extra,
  };
}

function route(extra: Partial<Route> & Pick<Route, 'route_id'>): Route {
  return {
    agency_id: 'A1',
    route_short_name: '1',
    route_long_name: 'Main Street',
    route_type: 3,
    route_color: 'FFFFFF',
    route_text_color: '000000',
    ...extra,
  };
}

/** Codes emitted by the validator for the current store state. */
function codes(): string[] {
  return runValidation(useStore.getState()).map((m) => m.code).filter((c): c is string => !!c);
}

function messagesFor(code: string) {
  return runValidation(useStore.getState()).filter((m) => m.code === code);
}

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([]);
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

describe('multi-agency feed — agency_id is required by the spec', () => {
  it('warns for an agencies.txt row with no agency_id', () => {
    const s = useStore.getState();
    s.setAgencies([
      agency({ agency_id: '', agency_name: 'Valley Transit' }),
      agency({ agency_id: 'A2', agency_name: 'City Bus' }),
    ] as never);
    s.setRoutes([route({ route_id: 'R1', agency_id: 'A2' })] as never);

    const msgs = messagesFor(VALIDATION_CODES.ntdMissingAgencyId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe('warning');
    expect(msgs[0].entity_type).toBe('agency');
    expect(msgs[0].message).toContain('Valley Transit');
    // The advisory (single-agency) rule must NOT also fire.
    expect(codes()).not.toContain(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
  });

  it('warns for a routes.txt row with no agency_id, once per route', () => {
    const s = useStore.getState();
    s.setAgencies([
      agency({ agency_id: 'A1', agency_name: 'Valley Transit' }),
      agency({ agency_id: 'A2', agency_name: 'City Bus' }),
    ] as never);
    s.setRoutes([
      route({ route_id: 'R1', route_short_name: '1', agency_id: '' }),
      route({ route_id: 'R2', route_short_name: '2', agency_id: 'A2' }),
    ] as never);

    const msgs = messagesFor(VALIDATION_CODES.ntdMissingAgencyId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe('warning');
    expect(msgs[0].entity_type).toBe('route');
    expect(msgs[0].entity_id).toBe('R1');
    expect(msgs[0].message).toContain('"1"');
  });

  it('whitespace-only agency_id counts as missing', () => {
    const s = useStore.getState();
    s.setAgencies([agency({ agency_id: 'A1' }), agency({ agency_id: 'A2' })] as never);
    s.setRoutes([route({ route_id: 'R1', agency_id: '   ' })] as never);
    expect(codes()).toContain(VALIDATION_CODES.ntdMissingAgencyId);
  });

  it('a fully-populated multi-agency feed fires neither code', () => {
    const s = useStore.getState();
    s.setAgencies([
      agency({ agency_id: 'A1', agency_name: 'Valley Transit' }),
      agency({ agency_id: 'A2', agency_name: 'City Bus' }),
    ] as never);
    s.setRoutes([
      route({ route_id: 'R1', agency_id: 'A1' }),
      route({ route_id: 'R2', agency_id: 'A2' }),
    ] as never);

    const emitted = codes();
    expect(emitted).not.toContain(VALIDATION_CODES.ntdMissingAgencyId);
    expect(emitted).not.toContain(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
  });
});

describe('single-agency feed — omitting agency_id is spec-legal, so advisory only', () => {
  it('emits exactly ONE advisory warning, not one per route, and not the multi-agency code', () => {
    const s = useStore.getState();
    s.setAgencies([agency({ agency_id: '' })] as never);
    s.setRoutes([
      route({ route_id: 'R1', agency_id: '' }),
      route({ route_id: 'R2', agency_id: '' }),
      route({ route_id: 'R3', agency_id: '' }),
    ] as never);

    const msgs = messagesFor(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].severity).toBe('warning');
    // Advisory wording: spec-legal, but FTA's July 2025 notice requires it.
    expect(msgs[0].message).toContain('FR 2025-12813');
    expect(msgs[0].message).toContain('routes.txt');

    expect(codes()).not.toContain(VALIDATION_CODES.ntdMissingAgencyId);
  });

  it('fires when only the routes are missing agency_id (agency row has one)', () => {
    const s = useStore.getState();
    s.setAgencies([agency({ agency_id: 'A1' })] as never);
    s.setRoutes([route({ route_id: 'R1', agency_id: '' })] as never);

    const msgs = messagesFor(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toContain('1 route');
  });

  it('a single-agency feed with agency_id set everywhere fires neither code', () => {
    const s = useStore.getState();
    s.setAgencies([agency({ agency_id: 'A1' })] as never);
    s.setRoutes([route({ route_id: 'R1', agency_id: 'A1' })] as never);

    const emitted = codes();
    expect(emitted).not.toContain(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
    expect(emitted).not.toContain(VALIDATION_CODES.ntdMissingAgencyId);
  });
});

describe('an empty feed is not nagged about agency_id', () => {
  it('zero agencies emits neither code (the "at least one agency" error covers it)', () => {
    useStore.getState().setAgencies([]);
    useStore.getState().setRoutes([route({ route_id: 'R1', agency_id: '' })] as never);

    const emitted = codes();
    expect(emitted).not.toContain(VALIDATION_CODES.ntdMissingAgencyId);
    expect(emitted).not.toContain(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
    expect(runValidation(useStore.getState()).map((m) => m.message))
      .toContain('At least one agency is required');
  });
});

describe('both rules are dismissible', () => {
  it('each code has a human label and dismissing one silences only it', () => {
    expect(DISMISSIBLE_RULE_LABELS[VALIDATION_CODES.ntdMissingAgencyId]).toBeTruthy();
    expect(DISMISSIBLE_RULE_LABELS[VALIDATION_CODES.ntdSingleAgencyNoAgencyId]).toBeTruthy();

    const s = useStore.getState();
    s.setAgencies([agency({ agency_id: '' })] as never);
    s.setRoutes([route({ route_id: 'R1', agency_id: '' })] as never);
    s.dismissValidation(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);

    const dismissed = useStore.getState().dismissedValidations;
    const visible = runValidation(useStore.getState())
      .filter((m) => !(m.code && dismissed.includes(m.code)));
    expect(visible.map((m) => m.code)).not.toContain(VALIDATION_CODES.ntdSingleAgencyNoAgencyId);
  });
});
