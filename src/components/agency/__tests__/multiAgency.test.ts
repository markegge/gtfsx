// Multi-agency editing — the Agency panel manages every agency in the feed, not
// just agencies[0]. Covers what the panel's controls do: add an agency, edit the
// SECOND agency's fields (including its own `external_id`), rename an agency_id
// (cascading to the routes that reference it), and the delete guard that stops a
// referenced agency from being removed out from under its routes.
//
// The panel edits rows by INDEX (agency_id is only conditionally required by the
// spec, so an imported feed can carry blank/duplicate ids) — these tests exercise
// the same index-addressed store actions the component calls.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../../store';
import { agencyReferenceCount, newAgencyDraft } from '../agencyHelpers';
import { exportGtfsZip } from '../../../services/gtfsExport';
import { importGtfsZip } from '../../../services/gtfsParse';
import type { Agency, Route } from '../../../types/gtfs';

function agency(extra: Partial<Agency> & Pick<Agency, 'agency_id'>): Agency {
  return {
    agency_name: 'Sunny Valley Transit',
    agency_url: 'https://svt.test',
    agency_timezone: 'America/Denver',
    ...extra,
  };
}

function route(extra: Partial<Route> & Pick<Route, 'route_id' | 'agency_id'>): Route {
  return {
    route_short_name: '1',
    route_long_name: 'Main Street',
    route_type: 3,
    route_color: 'FFFFFF',
    route_text_color: '000000',
    ...extra,
  };
}

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([agency({ agency_id: 'SVT', external_id: '01234' })]);
  s.setRoutes([]);
  s.setRouteStops([]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setCalendars([]);
  s.setCalendarDates([]);
  s.setFareAttributes([]);
  s.setFareRules([]);
  s.setFlexZones([]);
});

const s = () => useStore.getState();

describe('adding an agency', () => {
  it('seeds the GTFS-required fields and inherits the feed timezone', () => {
    s().setAgencies([agency({ agency_id: 'SVT', agency_timezone: 'America/New_York' })]);
    const draft = newAgencyDraft(s().agencies);

    expect(draft.agency_id).toMatch(/^agency-/); // generated, and editable in the panel
    expect(draft.agency_name).toBe('');
    expect(draft.agency_url).toBe('');
    expect(draft.agency_timezone).toBe('America/New_York');

    s().addAgency(draft);
    expect(s().agencies).toHaveLength(2);
    expect(s().agencies[1].agency_id).toBe(draft.agency_id);
  });

  it('falls back to a default timezone for a feed with no agency yet', () => {
    expect(newAgencyDraft([]).agency_timezone).toBe('America/Denver');
  });
});

describe('editing the second agency', () => {
  beforeEach(() => {
    s().addAgency(agency({ agency_id: 'MVX', agency_name: 'Mountain View Express' }));
  });

  it('updates the second agency by index, leaving the first untouched', () => {
    s().updateAgencyAt(1, { agency_name: 'Mountain View Transit', agency_phone: '555-0100' });

    expect(s().agencies[1].agency_name).toBe('Mountain View Transit');
    expect(s().agencies[1].agency_phone).toBe('555-0100');
    expect(s().agencies[0].agency_name).toBe('Sunny Valley Transit');
    expect(s().agencies[0].agency_phone).toBeUndefined();
  });

  it('gives each agency its own external_id (NTD ID), leading zeros intact', () => {
    s().updateAgencyAt(1, { external_id: '00567' });

    expect(s().agencies[0].external_id).toBe('01234');
    expect(s().agencies[1].external_id).toBe('00567');
    // Strings, never number-coerced — the leading zero is significant.
    expect(typeof s().agencies[1].external_id).toBe('string');
  });

  it('clears an external_id back to undefined when the field is emptied', () => {
    s().updateAgencyAt(0, { external_id: undefined });
    expect(s().agencies[0].external_id).toBeUndefined();
  });

  it('edits the right row even when both agencies share a blank agency_id', () => {
    // An imported (spec-invalid) feed can look like this; an id-addressed update
    // would silently edit the first row for both.
    s().setAgencies([
      agency({ agency_id: '', agency_name: 'One' }),
      agency({ agency_id: '', agency_name: 'Two' }),
    ]);
    s().updateAgencyAt(1, { external_id: '00567' });

    expect(s().agencies[0].external_id).toBeUndefined();
    expect(s().agencies[1].external_id).toBe('00567');
  });
});

describe('renaming an agency_id', () => {
  beforeEach(() => {
    s().addAgency(agency({ agency_id: 'MVX', agency_name: 'Mountain View Express' }));
    s().setRoutes([
      route({ route_id: 'R1', agency_id: 'SVT' }),
      route({ route_id: 'R2', agency_id: 'MVX' }),
    ]);
    s().setFareAttributes([
      { fare_id: 'F1', price: '2.00', currency_type: 'USD', payment_method: 0, transfers: '', agency_id: 'MVX' },
    ]);
  });

  it('cascades to the routes and fares that referenced it', () => {
    s().renameAgencyIdAt(1, 'MVT');

    expect(s().agencies[1].agency_id).toBe('MVT');
    expect(s().routes.find((r) => r.route_id === 'R2')?.agency_id).toBe('MVT');
    expect(s().fareAttributes[0].agency_id).toBe('MVT');
    // The other agency's route is untouched.
    expect(s().routes.find((r) => r.route_id === 'R1')?.agency_id).toBe('SVT');
  });

  it('refuses a collision with another agency_id', () => {
    s().renameAgencyIdAt(1, 'SVT');

    expect(s().agencies[1].agency_id).toBe('MVX');
    expect(s().routes.find((r) => r.route_id === 'R2')?.agency_id).toBe('MVX');
  });

  it('adopts the blank-agency_id routes of a single-agency feed', () => {
    s().setAgencies([agency({ agency_id: '' })]);
    s().setRoutes([route({ route_id: 'R1', agency_id: '' })]);

    s().renameAgencyIdAt(0, 'SVT');

    expect(s().agencies[0].agency_id).toBe('SVT');
    expect(s().routes[0].agency_id).toBe('SVT');
  });
});

describe('deleting an agency', () => {
  beforeEach(() => {
    s().addAgency(agency({ agency_id: 'MVX', agency_name: 'Mountain View Express' }));
  });

  it('is blocked while routes still reference the agency', () => {
    s().setRoutes([route({ route_id: 'R2', agency_id: 'MVX' })]);

    const refs = agencyReferenceCount(s().agencies[1], s().routes, s().fareAttributes);
    expect(refs.routes).toBe(1);
    expect(refs.total).toBe(1); // > 0 → the panel hides Delete and says why
  });

  it('removes the selected row (and only that row) when nothing references it', () => {
    s().setRoutes([route({ route_id: 'R1', agency_id: 'SVT' })]);

    expect(agencyReferenceCount(s().agencies[1], s().routes, s().fareAttributes).total).toBe(0);
    s().removeAgencyAt(1);

    expect(s().agencies).toHaveLength(1);
    expect(s().agencies[0].agency_id).toBe('SVT');
    expect(s().routes).toHaveLength(1);
  });
});

describe('two agencies round-trip through export → import', () => {
  it('keeps each agency\'s own external_id, leading zeros and all', async () => {
    s().addAgency(agency({ agency_id: 'MVX', agency_name: 'Mountain View Express' }));
    s().updateAgencyAt(1, { external_id: '00567' });

    const blob = await exportGtfsZip();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const text = await new (await import('jszip')).default()
      .loadAsync(bytes)
      .then((zip) => zip.file('agency.txt')!.async('string'));
    expect(text).toContain('external_id');

    const reimported = await importGtfsZip(bytes as unknown as File);
    expect(reimported.agencies).toHaveLength(2);
    expect(reimported.agencies.find((a) => a.agency_id === 'SVT')?.external_id).toBe('01234');
    expect(reimported.agencies.find((a) => a.agency_id === 'MVX')?.external_id).toBe('00567');
  });
});
