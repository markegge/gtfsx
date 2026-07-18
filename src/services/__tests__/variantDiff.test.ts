// #66 — lossless variant override diff: apply is the exact inverse of diff.
import { describe, expect, it } from 'vitest';
import { diffVariant, applyVariantDiff } from '../variantDiff';

// Every entity key a variant snapshot can carry (mirrors buildSnapshot()).
const ALL_KEYS = [
  'agencies', 'calendars', 'calendarDates', 'routes', 'routeStops', 'stops',
  'trips', 'stopTimes', 'shapes', 'feedInfo', 'fareAttributes', 'fareRules',
  'fareAreas', 'stopAreas', 'fareNetworks', 'routeNetworks', 'timeframes',
  'riderCategories', 'fareMedia', 'fareProducts', 'fareLegRules',
  'fareTransferRules', 'frequencies', 'levels', 'pathways', 'flexZones',
  'featureSettings', 'dismissedValidations', 'licenseSpdx',
] as const;

function baseSnap(): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const k of ALL_KEYS) s[k] = k === 'feedInfo' ? null : k === 'licenseSpdx' ? null : [];
  s.routes = [{ route_id: 'R1' }];
  s.stops = [{ stop_id: 's1' }];
  s.trips = [{ trip_id: 't1' }];
  return s;
}

describe('diffVariant / applyVariantDiff', () => {
  it('an identical variant has an empty diff and reconstructs exactly', () => {
    const base = baseSnap();
    const variant = { ...base }; // same slice references
    const diff = diffVariant(base, variant);
    expect(Object.keys(diff.changed)).toEqual([]);
    expect(applyVariantDiff(base, diff)).toEqual(variant);
  });

  it('stores only the changed slice (reference identity) and inherits the rest', () => {
    const base = baseSnap();
    const variant = { ...base, trips: [{ trip_id: 't1' }, { trip_id: 't2' }] };
    const diff = diffVariant(base, variant);
    expect(Object.keys(diff.changed)).toEqual(['trips']); // only trips differs by ref
    const back = applyVariantDiff(base, diff);
    expect(back.trips).toEqual([{ trip_id: 't1' }, { trip_id: 't2' }]);
    expect(back.stops).toBe(base.stops); // unchanged slices inherited from baseline
  });

  it('round-trips fidelity across EVERY entity key that changed', () => {
    const base = baseSnap();
    // Change every key to a distinct new value/reference.
    const variant: Record<string, unknown> = {};
    for (const k of ALL_KEYS) {
      variant[k] = k === 'feedInfo'
        ? { feed_publisher_name: 'X' }
        : k === 'licenseSpdx'
          ? 'CC-BY-4.0'
          : k === 'featureSettings'
            ? { foo: true }
            : [{ id: `${k}-1` }];
    }
    const diff = diffVariant(base, variant);
    expect(new Set(Object.keys(diff.changed))).toEqual(new Set(ALL_KEYS));
    expect(applyVariantDiff(base, diff)).toEqual(variant);
  });

  it('applyVariantDiff does not mutate the baseline', () => {
    const base = baseSnap();
    const frozen = JSON.parse(JSON.stringify(base));
    applyVariantDiff(base, { changed: { trips: [{ trip_id: 'z' }] } });
    expect(base).toEqual(frozen);
  });

  it('handles a large slice by value', () => {
    const base = baseSnap();
    const big = Array.from({ length: 5000 }, (_, i) => ({ trip_id: `t${i}`, stop_sequence: i }));
    const variant = { ...base, stopTimes: big };
    const back = applyVariantDiff(base, diffVariant(base, variant));
    expect(back.stopTimes).toEqual(big);
    expect((back.stopTimes as unknown[]).length).toBe(5000);
  });
});
