// GTFS-Fares v2 — Areas editor (#32, Phase 1): areas.txt + stop_areas.txt
// CRUD, the faresV2 feature gating, and validation of area/stop_area integrity.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { featureEnabled, featureHasData, clearFeatureData } from '../featuresSlice';
import { runValidation } from '../../services/validation';
import type { Stop } from '../../types/gtfs';

function stop(id: string, name = id): Stop {
  return { stop_id: id, stop_name: name, stop_lat: 45, stop_lon: -111 } as Stop;
}

function reset() {
  const s = useStore.getState();
  s.setFeatureSettings({});
  s.setFareAreas([]);
  s.setStopAreas([]);
  s.setFareNetworks([]);
  s.setRouteNetworks([]);
  s.setTimeframes([]);
  s.setRiderCategories([]);
  s.setFareMedia([]);
  s.setFareProducts([]);
  s.setFareLegRules([]);
  s.setFareTransferRules([]);
  s.setStops([]);
}
beforeEach(reset);
afterEach(reset);

describe('areas CRUD', () => {
  it('adds an area and rejects a duplicate area_id', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1', area_name: 'Downtown' });
    s.addFareArea({ area_id: 'a1', area_name: 'Duplicate' });
    const areas = useStore.getState().fareAreas;
    expect(areas).toHaveLength(1);
    expect(areas[0].area_name).toBe('Downtown');
  });

  it('updates area_name (optional field)', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.updateFareArea('a1', { area_name: 'Renamed' });
    expect(useStore.getState().fareAreas[0].area_name).toBe('Renamed');
  });

  it('renames area_id and cascades to stop_areas', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addStopToArea('a1', 's1');
    s.renameFareAreaId('a1', 'a1-new');
    const st = useStore.getState();
    expect(st.fareAreas[0].area_id).toBe('a1-new');
    expect(st.stopAreas.every((sa) => sa.area_id === 'a1-new')).toBe(true);
  });

  it('refuses a rename that collides with an existing area_id', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addFareArea({ area_id: 'a2' });
    s.renameFareAreaId('a1', 'a2'); // collision → no-op
    const ids = useStore.getState().fareAreas.map((a) => a.area_id).sort();
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('deletes an area and its stop_areas mappings', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addFareArea({ area_id: 'a2' });
    s.addStopToArea('a1', 's1');
    s.addStopToArea('a2', 's2');
    s.removeFareArea('a1');
    const st = useStore.getState();
    expect(st.fareAreas.map((a) => a.area_id)).toEqual(['a2']);
    expect(st.stopAreas).toEqual([{ area_id: 'a2', stop_id: 's2' }]);
  });
});

describe('stop assignment', () => {
  it('adds a stop to an area and dedups the (area, stop) pair', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addStopToArea('a1', 's1');
    s.addStopToArea('a1', 's1'); // duplicate → no-op
    expect(useStore.getState().stopAreas).toHaveLength(1);
  });

  it('allows a stop in multiple areas', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addFareArea({ area_id: 'a2' });
    s.addStopToArea('a1', 's1');
    s.addStopToArea('a2', 's1');
    expect(useStore.getState().stopAreas).toHaveLength(2);
  });

  it('removes a stop from an area', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addStopToArea('a1', 's1');
    s.addStopToArea('a1', 's2');
    s.removeStopFromArea('a1', 's1');
    expect(useStore.getState().stopAreas).toEqual([{ area_id: 'a1', stop_id: 's2' }]);
  });
});

describe('faresV2 feature gating', () => {
  it('is off by default and on once any v2 file has data', () => {
    expect(featureEnabled(useStore.getState(), 'faresV2')).toBe(false);
    useStore.getState().addFareArea({ area_id: 'a1' });
    const s = useStore.getState();
    expect(featureHasData(s, 'faresV2')).toBe(true);
    expect(featureEnabled(s, 'faresV2')).toBe(true);
  });

  it('an explicit off hides v2 but keeps the data (hide, not delete)', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.setFeatureSetting('faresV2', false);
    expect(featureEnabled(useStore.getState(), 'faresV2')).toBe(false);
    expect(useStore.getState().fareAreas).toHaveLength(1);
  });

  it('clearFeatureData wipes every v2 file', () => {
    const s = useStore.getState();
    s.addFareArea({ area_id: 'a1' });
    s.addStopToArea('a1', 's1');
    s.setFareNetworks([{ network_id: 'n1' }]);
    clearFeatureData(useStore.getState(), 'faresV2');
    const st = useStore.getState();
    expect(st.fareAreas).toHaveLength(0);
    expect(st.stopAreas).toHaveLength(0);
    expect(st.fareNetworks).toHaveLength(0);
  });
});

describe('areas validation', () => {
  const errs = () => runValidation(useStore.getState()).filter((m) => m.severity === 'error');
  const warns = () => runValidation(useStore.getState()).filter((m) => m.severity === 'warning');

  it('flags a duplicate area_id', () => {
    const s = useStore.getState();
    // Bypass the slice's uniqueness guard to simulate an imported feed with dupes.
    s.setFareAreas([{ area_id: 'a1' }, { area_id: 'a1' }]);
    expect(errs().some((m) => m.message.includes('must be unique'))).toBe(true);
  });

  it('flags a stop_area referencing a non-existent area (orphan)', () => {
    const s = useStore.getState();
    s.setStops([stop('s1')]);
    s.setStopAreas([{ area_id: 'ghost', stop_id: 's1' }]);
    expect(errs().some((m) => m.message.includes('non-existent area'))).toBe(true);
  });

  it('flags a stop_area referencing a non-existent stop', () => {
    const s = useStore.getState();
    s.setFareAreas([{ area_id: 'a1' }]);
    s.setStopAreas([{ area_id: 'a1', stop_id: 'ghost' }]);
    expect(errs().some((m) => m.message.includes('non-existent stop'))).toBe(true);
  });

  it('warns on a duplicate (area, stop) mapping', () => {
    const s = useStore.getState();
    s.setStops([stop('s1')]);
    s.setFareAreas([{ area_id: 'a1' }]);
    s.setStopAreas([{ area_id: 'a1', stop_id: 's1' }, { area_id: 'a1', stop_id: 's1' }]);
    expect(warns().some((m) => m.message.includes('more than once'))).toBe(true);
  });

  it('is clean for a well-formed area + stop_area set', () => {
    const s = useStore.getState();
    s.setStops([stop('s1'), stop('s2')]);
    s.setFareAreas([{ area_id: 'a1', area_name: 'Downtown' }]);
    s.setStopAreas([{ area_id: 'a1', stop_id: 's1' }, { area_id: 'a1', stop_id: 's2' }]);
    const v2Errors = errs().filter((m) => m.entity_type === 'area' || m.entity_type === 'stop_area');
    expect(v2Errors).toHaveLength(0);
  });
});
