// #66 — variant persistence envelope: build → parse round-trip fidelity,
// legacy/empty handling, and baseline-moved semantics.
import { describe, expect, it } from 'vitest';
import {
  buildVariantsEnvelope,
  parseVariantsEnvelope,
  VARIANTS_ENVELOPE_KEY,
  VARIANTS_ENVELOPE_VERSION,
} from '../variantPersistence';
import type { FeedVariant } from '../../store/variantSlice';

// Minimal buildSnapshot()-shaped snapshot; only the keys a test touches matter.
function snap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    routes: [{ route_id: 'R1' }],
    stops: [{ stop_id: 's1' }],
    trips: [{ trip_id: 't1' }],
    stopTimes: [{ trip_id: 't1', stop_id: 's1' }],
    calendars: [{ service_id: 'wk' }],
    ...over,
  };
}

function variant(id: string, name: string, baseline: boolean, snapshot: Record<string, unknown>): FeedVariant {
  return { id, name, baseline, createdAt: 1, modifiedAt: 1, snapshot };
}

describe('buildVariantsEnvelope + parseVariantsEnvelope round-trip', () => {
  it('baseline + 3 variants survive save→load by value (identity)', () => {
    const base = snap();
    // Each variant shares baseline's unchanged slices by reference, changes some.
    const vBase = variant('b', 'Baseline', true, base);
    const v1 = variant('v1', 'More AM', false, { ...base, trips: [{ trip_id: 't1' }, { trip_id: 't2' }] });
    const v2 = variant('v2', 'Extra stop', false, { ...base, stops: [{ stop_id: 's1' }, { stop_id: 's2' }] });
    const v3 = variant('v3', 'Both', false, {
      ...base,
      trips: [{ trip_id: 't1' }, { trip_id: 't9' }],
      routes: [{ route_id: 'R1' }, { route_id: 'R2' }],
    });
    const variants = [vBase, v1, v2, v3];

    const env = buildVariantsEnvelope(variants, 'v2', base);
    // Only non-baseline changed keys are stored (blob economy).
    expect(env.variants.find((e) => e.id === 'b')!.diff).toBeNull();
    expect(Object.keys(env.variants.find((e) => e.id === 'v1')!.diff!.changed)).toEqual(['trips']);
    expect(new Set(Object.keys(env.variants.find((e) => e.id === 'v3')!.diff!.changed))).toEqual(
      new Set(['routes', 'trips']),
    );

    // Simulate the blob: flat baseline keys + envelope.
    const blob = { ...base, [VARIANTS_ENVELOPE_KEY]: env };
    const baseFlat = { ...base };
    const parsed = parseVariantsEnvelope(blob, baseFlat)!;

    expect(parsed.activeVariantId).toBe('v2');
    expect(parsed.variants.map((v) => [v.id, v.name, v.baseline])).toEqual([
      ['b', 'Baseline', true],
      ['v1', 'More AM', false],
      ['v2', 'Extra stop', false],
      ['v3', 'Both', false],
    ]);
    // Every reconstructed snapshot equals the original by value.
    for (const orig of variants) {
      const got = parsed.variants.find((v) => v.id === orig.id)!;
      expect(got.snapshot).toEqual(orig.snapshot);
    }
  });

  it('returns null for a legacy snapshot with no envelope', () => {
    expect(parseVariantsEnvelope(snap(), snap())).toBeNull();
  });

  it('returns null for an empty / unversioned / mismatched envelope', () => {
    const base = snap();
    expect(parseVariantsEnvelope({ ...base, [VARIANTS_ENVELOPE_KEY]: { version: 1, activeVariantId: null, variants: [] } }, base)).toBeNull();
    expect(parseVariantsEnvelope({ ...base, [VARIANTS_ENVELOPE_KEY]: { version: 99, activeVariantId: null, variants: [{ id: 'b', name: 'B', baseline: true, createdAt: 0, diff: null }] } }, base)).toBeNull();
  });

  it('does not write an envelope smaller than version constant drift', () => {
    const env = buildVariantsEnvelope([variant('b', 'Baseline', true, snap())], null, snap());
    expect(env.version).toBe(VARIANTS_ENVELOPE_VERSION);
  });

  it('baseline-moved: a reconstructed variant keeps its forked value, not the moved baseline', () => {
    // Save v1 (changed trips) against baseline B0.
    const b0 = snap();
    const v1 = variant('v1', 'V1', false, { ...b0, trips: [{ trip_id: 't1' }, { trip_id: 't2' }] });
    const env0 = buildVariantsEnvelope([variant('b', 'Baseline', true, b0), v1], 'v1', b0);

    // Later the baseline moves (a stop added on the baseline) and we re-diff v1
    // against the NEW baseline. Model the store faithfully: only the edited
    // slice's reference is replaced; every other slice keeps b0's reference (so
    // v1 and the moved baseline still SHARE those). v1 never touched stops, so
    // its stops now DIFFER from the moved baseline and are stored — i.e. v1
    // retains its forked stops rather than silently rebasing.
    const b1 = { ...b0, stops: [{ stop_id: 's1' }, { stop_id: 'sNEW' }] };
    // v1's in-memory snapshot is still the full forked snapshot (independent).
    const env1 = buildVariantsEnvelope([variant('b', 'Baseline', true, b1), v1], 'v1', b1);
    const v1entry = env1.variants.find((e) => e.id === 'v1')!;
    expect(new Set(Object.keys(v1entry.diff!.changed))).toEqual(new Set(['stops', 'trips']));

    // Reconstructing against the moved baseline gives v1 its OWN stops (s1 only),
    // not the baseline's sNEW — the fork does not silently rebase.
    const parsed = parseVariantsEnvelope({ ...b1, [VARIANTS_ENVELOPE_KEY]: env1 }, { ...b1 })!;
    const got = parsed.variants.find((v) => v.id === 'v1')!;
    expect(got.snapshot.stops).toEqual([{ stop_id: 's1' }]);
    expect(got.snapshot.trips).toEqual([{ trip_id: 't1' }, { trip_id: 't2' }]);
    // And the baseline entry reflects the moved baseline.
    expect(parsed.variants.find((v) => v.baseline)!.snapshot.stops).toEqual([{ stop_id: 's1' }, { stop_id: 'sNEW' }]);
    void env0;
  });
});
