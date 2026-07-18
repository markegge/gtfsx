/**
 * A2 / #66 — variant persistence envelope.
 *
 * The working-state blob stays a flat buildSnapshot() object whose top-level
 * keys are the BASELINE feed (canonical — Save always writes the baseline into
 * the project's feed slot, never a variant). The variant layer rides along in a
 * single namespaced `__variants` key alongside those flat keys.
 *
 * Compatibility (both directions):
 *  - Old snapshot (no `__variants`): loads as a plain feed, no variants — exactly
 *    as before. Adding this key is additive.
 *  - New snapshot read by an OLD client: it reads the flat keys (the baseline)
 *    and shows the baseline feed — never a variant — and ignores the unknown
 *    `__variants` key (applySnapshotToStore only re-applies known DATA_KEYS,
 *    like it already ignores the retired `visibilitySets`). An old client that
 *    then saves drops `__variants` (its buildSnapshot has no such key): variants
 *    are lost but the feed is intact — no corruption.
 *  - New client reads a new snapshot: full rehydration below.
 *
 * `version` gates the shape so a future format can be migrated or ignored
 * rather than mis-parsed.
 */
import type { FeedVariant } from '../store/variantSlice';
import { diffVariant, applyVariantDiff, type VariantDiff } from './variantDiff';

/** Top-level key carrying the variant layer in the working-state blob. */
export const VARIANTS_ENVELOPE_KEY = '__variants';
export const VARIANTS_ENVELOPE_VERSION = 1;

interface SerializedVariant {
  id: string;
  name: string;
  baseline: boolean;
  createdAt: number;
  /** Optional for backward compatibility: envelopes written before the panel
   *  work have no modifiedAt, and load with modifiedAt = createdAt. */
  modifiedAt?: number;
  /** Override diff from the baseline snapshot; null for the baseline entry
   *  itself (it IS the flat top-level feed). */
  diff: VariantDiff | null;
}

export interface VariantsEnvelope {
  version: number;
  activeVariantId: string | null;
  variants: SerializedVariant[];
}

/**
 * Build the `__variants` envelope from the live variant layer. `baseSnap` is
 * the baseline variant's snapshot (also written to the flat top-level keys), so
 * non-baseline variants are stored as diffs against it. Pure over its args.
 */
export function buildVariantsEnvelope(
  variants: FeedVariant[],
  activeVariantId: string | null,
  baseSnap: Record<string, unknown>,
): VariantsEnvelope {
  return {
    version: VARIANTS_ENVELOPE_VERSION,
    activeVariantId,
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      baseline: v.baseline,
      createdAt: v.createdAt,
      modifiedAt: v.modifiedAt,
      diff: v.baseline ? null : diffVariant(baseSnap, v.snapshot),
    })),
  };
}

/**
 * Reconstruct the variant layer from a loaded snapshot. `baseFlat` is the flat
 * baseline feed (the snapshot's DATA_KEYS). Returns null when there is no valid
 * envelope (old/plain snapshots), so the caller leaves the feed variant-free.
 * Non-baseline variants are rebuilt as FULL independent snapshots by overlaying
 * their diff onto the baseline — see the baseline-moved semantics note in
 * serverPersistence.loadProjectFromServer. Pure over its args.
 */
export function parseVariantsEnvelope(
  snapshot: Record<string, unknown>,
  baseFlat: Record<string, unknown>,
): { variants: FeedVariant[]; activeVariantId: string | null } | null {
  const env = snapshot?.[VARIANTS_ENVELOPE_KEY] as VariantsEnvelope | undefined;
  if (
    !env ||
    env.version !== VARIANTS_ENVELOPE_VERSION ||
    !Array.isArray(env.variants) ||
    env.variants.length === 0
  ) {
    return null;
  }
  const variants: FeedVariant[] = env.variants.map((e) => ({
    id: e.id,
    name: e.name,
    baseline: !!e.baseline,
    createdAt: e.createdAt,
    modifiedAt: e.modifiedAt ?? e.createdAt,
    // Baseline (or a defensive missing diff) IS the flat feed; others overlay.
    snapshot: e.baseline || !e.diff ? { ...baseFlat } : applyVariantDiff(baseFlat, e.diff),
  }));
  return { variants, activeVariantId: env.activeVariantId ?? null };
}
