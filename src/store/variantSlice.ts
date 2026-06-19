import type { StateCreator } from 'zustand';

/**
 * A2 — Feed variants (feed forking).
 *
 * A "variant" is a forked, independently-editable copy of the whole feed,
 * branched from a baseline, so a planner can answer "what does this service
 * change cost vs. today?". Exactly one variant is the baseline.
 *
 * v1 is SESSION-SCOPED and CLIENT-SIDE: variants live in memory and are
 * deliberately NOT in serverPersistence's DATA_KEYS, so they never enter the
 * working-state blob and can't touch the existing save path. The live store
 * always holds the *active* variant's working copy; inactive variants keep a
 * frozen snapshot (the buildSnapshot() shape). The high-level fork / switch /
 * compare actions live in services/variants.ts (they need buildSnapshot +
 * applySnapshotToStore); this slice is just the state + low-level setters.
 *
 * Naming: "variants" is deliberately distinct from the basic per-route
 * visibility toggle (hiddenRouteIds) — a variant carries real, independent
 * edits, not just which routes are shown.
 */
export interface FeedVariant {
  id: string;
  name: string;
  /** Exactly one variant is the baseline (the comparison reference). */
  baseline: boolean;
  createdAt: number;
  /** Frozen feed snapshot (buildSnapshot() shape). For the ACTIVE variant this
   *  may be stale — the live store is its source of truth until you switch away
   *  or compare, at which point it's re-serialized. */
  snapshot: Record<string, unknown>;
}

export interface VariantSlice {
  variants: FeedVariant[];
  /** The variant the live store currently represents. null = no variants yet. */
  activeVariantId: string | null;
  setVariants: (v: FeedVariant[]) => void;
  setActiveVariantId: (id: string | null) => void;
  addVariant: (v: FeedVariant) => void;
  removeVariant: (id: string) => void;
  renameVariant: (id: string, name: string) => void;
  updateVariantSnapshot: (id: string, snapshot: Record<string, unknown>) => void;
  setBaselineVariant: (id: string) => void;
}

export const createVariantSlice: StateCreator<VariantSlice, [['zustand/immer', never]], [], VariantSlice> = (set) => ({
  variants: [],
  activeVariantId: null,
  setVariants: (v) => set((s) => { s.variants = v; }),
  setActiveVariantId: (id) => set((s) => { s.activeVariantId = id; }),
  addVariant: (v) => set((s) => { s.variants.push(v); }),
  removeVariant: (id) => set((s) => { s.variants = s.variants.filter((x) => x.id !== id); }),
  renameVariant: (id, name) => set((s) => {
    const v = s.variants.find((x) => x.id === id);
    if (v) v.name = name.trim() || v.name;
  }),
  updateVariantSnapshot: (id, snapshot) => set((s) => {
    const v = s.variants.find((x) => x.id === id);
    if (v) v.snapshot = snapshot;
  }),
  setBaselineVariant: (id) => set((s) => {
    for (const v of s.variants) v.baseline = v.id === id;
  }),
});
