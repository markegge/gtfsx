/**
 * A2 / #66 — lossless variant serialization diff.
 *
 * A "variant" is a full independent fork of the feed (a buildSnapshot() shape).
 * Persisting every variant's full feed would N× the working-state blob, so on
 * save we store non-baseline variants as an OVERRIDE diff from the baseline:
 * only the entity slices that actually differ from baseline are kept; every
 * unchanged slice is inherited from baseline at load time.
 *
 * Why not services/feedDiff.ts? That is a lossy *summary* (per-entity add/
 * remove/change counts + KPI deltas for the compare UI) — it cannot reconstruct
 * a variant. This is a lossless, reconstructable encoding: `applyVariantDiff` is
 * the exact inverse of `diffVariant` for round-trip fidelity.
 *
 * Granularity is per-entity-key (the buildSnapshot() keys — routes, stopTimes,
 * …), detected by reference identity: the store replaces a slice's array by
 * reference on every edit, so `variant[k] !== baseline[k]` is a reliable "this
 * slice changed" signal (the same trick persistence.ts uses for bulk writes).
 * Worst case (a slice replaced by an equal-but-new reference) stores an
 * unchanged slice — larger blob, never wrong. Repeated near-identical slices
 * across variants also compress away under the gzip transport.
 */

/** An override diff: the baseline-relative changed entity slices, keyed by the
 *  buildSnapshot() key. Absent keys are inherited from baseline on apply. */
export interface VariantDiff {
  changed: Record<string, unknown>;
}

/**
 * Diff a variant snapshot against the baseline snapshot. Both are
 * buildSnapshot()-shaped objects. Keeps only keys whose value differs from
 * baseline by reference. Pure.
 */
export function diffVariant(
  baseline: Record<string, unknown>,
  variant: Record<string, unknown>,
): VariantDiff {
  const changed: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(baseline), ...Object.keys(variant)]);
  for (const k of keys) {
    // Reference inequality = the slice was edited on this variant. Undefined vs
    // present also counts (both snapshots share the buildSnapshot key set, so
    // this is just defensive).
    if (variant[k] !== baseline[k]) changed[k] = variant[k];
  }
  return { changed };
}

/**
 * Reconstruct a variant snapshot from the baseline snapshot and an override
 * diff. The exact inverse of `diffVariant`: unchanged keys come from baseline,
 * changed keys from the diff. Pure; does not mutate baseline.
 */
export function applyVariantDiff(
  baseline: Record<string, unknown>,
  diff: VariantDiff,
): Record<string, unknown> {
  return { ...baseline, ...(diff?.changed ?? {}) };
}
