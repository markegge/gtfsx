// Per-feed advanced-feature gating: defaults, data-driven auto-enable, explicit
// toggles, the in-use guard, data clearing, and the demand-response validation
// nudge. See src/store/featuresSlice.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { featureEnabled, featureHasData, clearFeatureData } from '../featuresSlice';
import { runValidation } from '../../services/validation';

function reset() {
  const s = useStore.getState();
  s.setFeatureSettings({});
  s.setFrequencies([]);
  s.setTransfers([]);
  s.setLevels([]);
  s.setPathways([]);
  s.setFlexZones([]);
  s.setTrips([]);
  s.setFareLegRules([]);
}
beforeEach(reset);
afterEach(reset);

describe('feature defaults', () => {
  it('demand response is on by default; the rest are off', () => {
    const s = useStore.getState();
    expect(featureEnabled(s, 'demandResponse')).toBe(true);
    for (const f of ['transfers', 'frequencies', 'stations', 'blocks'] as const) {
      expect(featureEnabled(s, f)).toBe(false);
    }
  });
});

describe('data-driven auto-enable', () => {
  it('a feature with data is enabled even without an explicit toggle', () => {
    useStore.getState().setFrequencies([{ trip_id: 't1', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 } as never]);
    const s = useStore.getState();
    expect(featureHasData(s, 'frequencies')).toBe(true);
    expect(featureEnabled(s, 'frequencies')).toBe(true);
  });

  it('blocks detect a trip with a block_id', () => {
    useStore.getState().setTrips([{ trip_id: 't1', route_id: 'r1', service_id: 's1', block_id: 'b1' } as never]);
    const s = useStore.getState();
    expect(featureHasData(s, 'blocks')).toBe(true);
    expect(featureEnabled(s, 'blocks')).toBe(true);
  });
});

describe('explicit toggles + in-use guard', () => {
  it('explicit on shows a feature with no data', () => {
    useStore.getState().setFeatureSetting('frequencies', true);
    expect(featureEnabled(useStore.getState(), 'frequencies')).toBe(true);
  });

  it('demand response can be turned off when there is no flex data', () => {
    useStore.getState().setFeatureSetting('demandResponse', false);
    expect(featureEnabled(useStore.getState(), 'demandResponse')).toBe(false);
  });

  it('a feature with data stays enabled even when explicitly turned off (no orphaning)', () => {
    const s = useStore.getState();
    s.setFlexZones([{ id: 'z1' } as never]);
    s.setFeatureSetting('demandResponse', false);
    expect(featureEnabled(useStore.getState(), 'demandResponse')).toBe(true);
  });
});

describe('clearFeatureData', () => {
  it('clears the rows a feature owns', () => {
    const s = useStore.getState();
    s.setFrequencies([{ trip_id: 't1', start_time: '08:00:00', end_time: '09:00:00', headway_secs: 600 } as never]);
    clearFeatureData(useStore.getState(), 'frequencies');
    expect(useStore.getState().frequencies.length).toBe(0);
  });

  it('strips block_id from trips (blocks has no file)', () => {
    const s = useStore.getState();
    s.setTrips([{ trip_id: 't1', route_id: 'r1', service_id: 's1', block_id: 'b1' } as never]);
    clearFeatureData(useStore.getState(), 'blocks');
    expect(useStore.getState().trips.every((t) => !t.block_id)).toBe(true);
  });
});

describe('demand-response validation nudge', () => {
  const flexNudge = (msgs: { message: string }[]) =>
    msgs.some((m) => m.message.includes('Demand-response service is on but no GTFS-Flex zones'));

  it('warns when demand-response is on and there are no flex zones', () => {
    expect(flexNudge(runValidation(useStore.getState()))).toBe(true);
  });

  it('does not warn once flex zones exist', () => {
    useStore.getState().setFlexZones([{ id: 'z1' } as never]);
    expect(flexNudge(runValidation(useStore.getState()))).toBe(false);
  });

  it('does not warn when demand-response is turned off', () => {
    useStore.getState().setFeatureSetting('demandResponse', false);
    expect(flexNudge(runValidation(useStore.getState()))).toBe(false);
  });
});
