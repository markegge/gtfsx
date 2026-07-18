// #67 — transfers.txt must persist (save/reload) and not leak across feeds.
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { buildSnapshot, applySnapshotToStore, resetEditorState } from '../../db/serverPersistence';
import { exportGtfsZip } from '../gtfsExport';
import type { Transfer, Stop } from '../../types/gtfs';

const T: Transfer[] = [
  { from_stop_id: 's1', to_stop_id: 's2', transfer_type: 2, min_transfer_time: 300 },
  { from_stop_id: 's2', to_stop_id: 's1', transfer_type: 1 },
];

function seed() {
  const s = useStore.getState();
  resetEditorState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
  s.setStops([
    { stop_id: 's1', stop_name: 'One', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
    { stop_id: 's2', stop_name: 'Two', stop_lat: 45.05, stop_lon: -111, wheelchair_boarding: 0 } as Stop,
  ]);
  s.setTransfers(T);
}

beforeEach(seed);

describe('transfers persistence (#67 silent-drop)', () => {
  it('buildSnapshot() carries transfers, and applySnapshotToStore restores them', () => {
    const snap = buildSnapshot();
    expect(snap.transfers).toEqual(T);

    // A fresh page load rebuilds the store purely from the persisted snapshot.
    useStore.getState().setTransfers([]);
    applySnapshotToStore(snap);
    expect(useStore.getState().transfers).toEqual(T);
  });

  it('resetEditorState() clears transfers (cross-feed leak)', () => {
    resetEditorState();
    expect(useStore.getState().transfers).toEqual([]);
  });

  it('a legacy snapshot with no transfers key loads clean (empty, no crash)', () => {
    useStore.getState().setTransfers(T);
    applySnapshotToStore({ routes: [], stops: [] }); // no `transfers` key
    expect(useStore.getState().transfers).toEqual([]);
  });

  it('transfers survive a snapshot round-trip into the exported transfers.txt', async () => {
    // store → snapshot → (persist) → store → export
    const snap = buildSnapshot();
    useStore.getState().setTransfers([]);
    applySnapshotToStore(snap);

    const blob = await exportGtfsZip();
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
    const file = zip.file('transfers.txt');
    expect(file).toBeTruthy();
    const parsed = Papa.parse<Record<string, string>>(await file!.async('string'), {
      header: true,
      skipEmptyLines: true,
    }).data;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ from_stop_id: 's1', to_stop_id: 's2', transfer_type: '2', min_transfer_time: '300' });
    expect(parsed[1]).toMatchObject({ from_stop_id: 's2', to_stop_id: 's1', transfer_type: '1' });
  });
});
