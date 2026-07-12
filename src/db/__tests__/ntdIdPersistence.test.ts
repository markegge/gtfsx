import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../../store';
import { applySnapshotToStore, buildSnapshot, resetStoreEntities } from '../serverPersistence';
import { ntdIdExportStatus } from '../../services/gtfsExport';
import type { Agency } from '../../types/gtfs';

const AGENCY: Agency = {
  agency_id: 'SVT',
  agency_name: 'Sample Valley Transit',
  agency_url: 'https://example.org',
  agency_timezone: 'America/Denver',
};

describe('NTD ID + license feed-state persistence', () => {
  beforeEach(() => {
    resetStoreEntities();
  });

  it('an NTD ID set from the export dialog (setNtdId) survives a persistence round-trip and drives the export', () => {
    // What ExportDialog's inline input does — the same store setter PublishPanel
    // uses. Leading zero is significant: NTD IDs are strings, never numbers.
    const s = useStore.getState();
    s.setAgencies([AGENCY]);
    s.setNtdId('01234');
    s.setExportNtdIdColumn(true);

    expect(ntdIdExportStatus(useStore.getState())).toBe('written');

    // Round-trip through the persisted snapshot (the same key list the
    // IndexedDB autosave and the server working-state both write).
    const snapshot = buildSnapshot();
    expect(snapshot.ntdId).toBe('01234');
    expect(JSON.parse(JSON.stringify(snapshot)).ntdId).toBe('01234');

    resetStoreEntities();
    expect(useStore.getState().ntdId).toBeNull();
    expect(ntdIdExportStatus(useStore.getState())).toBe('off');

    applySnapshotToStore(snapshot);

    const restored = useStore.getState();
    expect(restored.ntdId).toBe('01234');
    expect(restored.exportNtdIdColumn).toBe(true);
    expect(restored.agencies).toHaveLength(1);
    expect(ntdIdExportStatus(restored)).toBe('written');
  });

  it('normalizes a blank NTD ID to null and suppresses the column for a multi-agency feed', () => {
    const s = useStore.getState();
    s.setNtdId('  ');
    expect(useStore.getState().ntdId).toBeNull();

    s.setNtdId('01234');
    s.setExportNtdIdColumn(true);
    s.setAgencies([AGENCY, { ...AGENCY, agency_id: 'MTA', agency_name: 'Metro' }]);
    expect(ntdIdExportStatus(useStore.getState())).toBe('multi-agency-suppressed');
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
    expect(useStore.getState().ntdId).toBeNull();

    applySnapshotToStore(snapshot);
    expect(useStore.getState().licenseSpdx).toBe('CC-BY-4.0');
  });
});
