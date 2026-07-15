import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store';
import { applySnapshotToStore, buildSnapshot, resetStoreEntities } from '../serverPersistence';
import type { Agency } from '../../types/gtfs';

const AGENCY: Agency = {
  agency_id: 'SVT',
  agency_name: 'Sample Valley Transit',
  agency_url: 'https://example.org',
  agency_timezone: 'America/Denver',
};

describe('feed-state persistence (license + agency external_id)', () => {
  beforeEach(() => {
    resetStoreEntities();
  });

  it("round-trips each agency's own external_id inside the agencies entity (no persistence key of its own)", () => {
    // The NTD / external ID belongs to the AGENCY, so it rides along in the
    // already-persisted `agencies` array. Leading zeros are significant: it is a
    // string end-to-end and must never be Number()-coerced.
    useStore.getState().setAgencies([
      { ...AGENCY, external_id: '01234' },
      { ...AGENCY, agency_id: 'MTA', agency_name: 'Metro', external_id: '00567' },
      { ...AGENCY, agency_id: 'RID', agency_name: 'Ridge' }, // none set
    ]);

    // Survives JSON serialization (what actually goes over the wire / to disk).
    const wire = JSON.parse(JSON.stringify(buildSnapshot()));
    expect(wire.agencies.map((a: Agency) => a.external_id)).toEqual(['01234', '00567', undefined]);

    resetStoreEntities();
    expect(useStore.getState().agencies).toHaveLength(0);

    applySnapshotToStore(wire);

    const restored = useStore.getState().agencies;
    expect(restored).toHaveLength(3);
    expect(restored[0].external_id).toBe('01234');
    expect(restored[1].external_id).toBe('00567');
    expect(restored[2].external_id).toBeUndefined();
    // A string, not a number — a Number() coercion anywhere would drop the zero.
    expect(typeof restored[0].external_id).toBe('string');
  });

  it('normalizes a cleared external_id to undefined, never an empty string', () => {
    const s = useStore.getState();
    s.setAgencies([{ ...AGENCY, external_id: '01234' }]);
    // What AgencyEditor's onChange does when the input is emptied. An '' here
    // would make the exporter emit an empty external_id column.
    s.updateAgency('SVT', { external_id: undefined });
    expect(useStore.getState().agencies[0].external_id).toBeUndefined();
    expect(JSON.parse(JSON.stringify(buildSnapshot())).agencies[0].external_id).toBeUndefined();
  });

  it('round-trips licenseSpdx as feed state and does not leak it across projects', () => {
    const s = useStore.getState();
    s.setLicenseSpdx('CC-BY-4.0');
    expect(useStore.getState().licenseSpdx).toBe('CC-BY-4.0');

    const snapshot = buildSnapshot();
    expect(snapshot.licenseSpdx).toBe('CC-BY-4.0');

    // Loading a *different* project whose snapshot has no license must clear it,
    // not inherit the previous project's terms.
    applySnapshotToStore({});
    expect(useStore.getState().licenseSpdx).toBeNull();

    applySnapshotToStore(snapshot);
    expect(useStore.getState().licenseSpdx).toBe('CC-BY-4.0');
  });

  it('normalizes a blank licenseSpdx to null', () => {
    useStore.getState().setLicenseSpdx('  ');
    expect(useStore.getState().licenseSpdx).toBeNull();
  });
});
