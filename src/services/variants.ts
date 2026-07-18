/**
 * A2 — feed variant actions (the orchestration the variantSlice can't hold
 * because it needs buildSnapshot / applySnapshotToStore).
 *
 * Model (see variantSlice): the live store is always the ACTIVE variant's
 * working copy. Inactive variants hold a frozen buildSnapshot(). Switching
 * serializes the live store into the outgoing variant, then loads the incoming
 * one. Comparing diffs the baseline's snapshot against the live store.
 *
 * These actions mutate only the in-memory store; nothing here writes to the
 * server. Persistence happens on an explicit Save (#66): saveProjectNow always
 * writes the BASELINE as the project's canonical feed and stores the variant
 * layer (as diffs) in the working-state envelope, so saving while a non-baseline
 * variant is active never clobbers the baseline — it saves baseline + every
 * variant together, and a reload restores them. Because these mutations are
 * unsaved until then, each marks the editor dirty.
 */
import { useStore } from '../store';
import { buildSnapshot, applySnapshotToStore } from '../db/serverPersistence';
import { diffFeedState, type FeedState, type FeedDiff, type DiffOptions } from './feedDiff';
import { generateId } from './idGenerator';
import type { FeedVariant } from '../store/variantSlice';

function nowMs(): number {
  // App runtime (not a workflow script) — Date.now() is allowed here.
  return Date.now();
}

function toFeedState(snap: Record<string, unknown>): FeedState {
  const arr = <T>(k: string): T[] => (Array.isArray(snap[k]) ? (snap[k] as T[]) : []);
  return {
    routes: arr('routes'),
    routeStops: arr('routeStops'),
    trips: arr('trips'),
    stopTimes: arr('stopTimes'),
    stops: arr('stops'),
    calendars: arr('calendars'),
    calendarDates: arr('calendarDates'),
    frequencies: arr('frequencies'),
  };
}

export function activeVariant(): FeedVariant | null {
  const st = useStore.getState();
  return st.variants.find((v) => v.id === st.activeVariantId) ?? null;
}

export function baselineVariant(): FeedVariant | null {
  return useStore.getState().variants.find((v) => v.baseline) ?? null;
}

/**
 * Fork a new variant from the current live feed. The first fork also captures
 * the current feed as the "Baseline" (the comparison reference). The new
 * variant starts identical to the feed and becomes active. Returns its id.
 */
export function createVariantFromCurrent(name?: string): string {
  const st = useStore.getState();
  // Don't lose unsaved edits on the variant we're leaving.
  if (st.activeVariantId) st.updateVariantSnapshot(st.activeVariantId, buildSnapshot());

  if (st.variants.length === 0) {
    const t0 = nowMs();
    st.addVariant({
      id: generateId('variant'),
      name: 'Baseline',
      baseline: true,
      createdAt: t0,
      modifiedAt: t0,
      snapshot: buildSnapshot(),
    });
  }

  const count = useStore.getState().variants.filter((v) => !v.baseline).length;
  const id = generateId('variant');
  const t1 = nowMs();
  st.addVariant({
    id,
    name: (name && name.trim()) || `Variant ${count + 1}`,
    baseline: false,
    createdAt: t1,
    modifiedAt: t1,
    snapshot: buildSnapshot(),
  });
  // The new variant's content == current live feed, so no reload needed — just
  // route future edits to it.
  st.setActiveVariantId(id);
  // The variant layer is persisted state now (#66), so forking is unsaved work.
  useStore.getState().markDirty();
  return id;
}

/** Switch which variant the live store represents (saving the outgoing one). */
export function switchToVariant(id: string): void {
  const st = useStore.getState();
  if (id === st.activeVariantId) return;
  if (st.activeVariantId) st.updateVariantSnapshot(st.activeVariantId, buildSnapshot());
  const target = useStore.getState().variants.find((v) => v.id === id);
  if (!target) return;
  // Within-set switch — keep the variant layer across the feed reset (#66).
  applySnapshotToStore(target.snapshot, { preserveVariants: true });
  useStore.getState().setActiveVariantId(id);
  // applySnapshotToStore marked the store clean; the active-pointer change is
  // itself unsaved variant state, so re-mark dirty.
  useStore.getState().markDirty();
}

/** Delete a variant. Can't delete the baseline. Collapses the layer when only
 *  the baseline would remain (a lone baseline is just the feed). */
export function deleteVariant(id: string): void {
  const st = useStore.getState();
  const v = st.variants.find((x) => x.id === id);
  if (!v || v.baseline) return;
  const wasActive = st.activeVariantId === id;
  st.removeVariant(id);
  if (wasActive) {
    const baseline = useStore.getState().variants.find((x) => x.baseline);
    if (baseline) {
      applySnapshotToStore(baseline.snapshot, { preserveVariants: true });
      useStore.getState().setActiveVariantId(baseline.id);
    }
  }
  const remaining = useStore.getState().variants;
  if (remaining.length <= 1) {
    // Only the baseline (or nothing) left — drop the variant layer; the live
    // feed stays as whatever is currently loaded.
    useStore.getState().setVariants([]);
    useStore.getState().setActiveVariantId(null);
  }
  // Deleting/collapsing is an unsaved change to the persisted variant layer.
  useStore.getState().markDirty();
}

/** Discard the variant layer entirely, returning the feed to the baseline. */
export function discardVariants(): void {
  const baseline = baselineVariant();
  // Feed boundary back to a variant-free feed — let the reset clear the layer.
  if (baseline) applySnapshotToStore(baseline.snapshot);
  const st = useStore.getState();
  st.setVariants([]);
  st.setActiveVariantId(null);
  useStore.getState().markDirty();
}

/** The snapshot a variant currently represents: the LIVE store for the active
 *  variant (its frozen snapshot may be stale), else its frozen snapshot. */
function snapshotOf(id: string): Record<string, unknown> | null {
  const st = useStore.getState();
  if (id === st.activeVariantId) return buildSnapshot();
  return st.variants.find((v) => v.id === id)?.snapshot ?? null;
}

/**
 * Duplicate any variant (baseline or not) into a new non-baseline variant that
 * starts identical to the source and becomes active. The copy is independent:
 * because editing replaces slice references, later edits to the copy never
 * mutate the source. Returns the new id (or null for an unknown source).
 */
export function duplicateVariant(sourceId: string, name?: string): string | null {
  const st = useStore.getState();
  const source = st.variants.find((v) => v.id === sourceId);
  if (!source) return null;
  // Flush the outgoing active variant so nothing in-flight is lost.
  if (st.activeVariantId) st.updateVariantSnapshot(st.activeVariantId, buildSnapshot());
  const srcSnap = snapshotOf(sourceId) ?? source.snapshot;
  const id = generateId('variant');
  const t = nowMs();
  st.addVariant({
    id,
    name: (name && name.trim()) || `${source.name} copy`,
    baseline: false,
    createdAt: t,
    modifiedAt: t,
    // Shallow clone so the copy's snapshot object isn't shared with the source
    // (array slices stay shared until an edit replaces them — copy-on-write).
    snapshot: { ...srcSnap },
  });
  // Route the live store to the copy (within-set — keep the layer).
  applySnapshotToStore(srcSnap, { preserveVariants: true });
  useStore.getState().setActiveVariantId(id);
  useStore.getState().markDirty();
  return id;
}

/** Auto-name for the old baseline once a variant is promoted over it. */
export function priorBaselineName(promotedName: string): string {
  return `Baseline (before ${promotedName})`;
}

/**
 * Promote a variant to be the new baseline (#66 panel headline).
 *
 * Data is never destroyed:
 *  - the chosen variant's snapshot BECOMES the new baseline (fresh baseline
 *    entry, active),
 *  - the OLD baseline is preserved as a normal variant, auto-named
 *    "Baseline (before {variant})",
 *  - every OTHER variant keeps its forked state verbatim (snapshot-fallback:
 *    they are independent snapshots, re-diffed against the new baseline on the
 *    next save — see variantPersistence),
 *  - the promoted variant is removed from the list (it IS the baseline now).
 *
 * No-op if the id is unknown or already the baseline. Marks dirty; Save persists
 * the new arrangement through the envelope.
 */
export function promoteToBaseline(variantId: string): void {
  const st = useStore.getState();
  const promoted = st.variants.find((v) => v.id === variantId);
  const oldBaseline = st.variants.find((v) => v.baseline);
  if (!promoted || promoted.baseline || !oldBaseline) return;

  // Flush the active variant's live edits so we promote its true current state.
  if (st.activeVariantId) st.updateVariantSnapshot(st.activeVariantId, buildSnapshot());
  const promotedSnap = snapshotOf(variantId) ?? promoted.snapshot;
  const t = nowMs();
  const newBaselineId = generateId('variant');

  const rebuilt: FeedVariant[] = [
    { id: newBaselineId, name: 'Baseline', baseline: true, createdAt: t, modifiedAt: t, snapshot: { ...promotedSnap } },
  ];
  for (const v of useStore.getState().variants) {
    if (v.id === variantId) continue; // promoted → dropped (it is the baseline)
    if (v.baseline) {
      // Old baseline → a normal variant, keeping its snapshot (data preserved).
      rebuilt.push({ ...v, baseline: false, name: priorBaselineName(promoted.name), modifiedAt: t });
    } else {
      rebuilt.push(v); // other variants keep their forked state
    }
  }
  useStore.getState().setVariants(rebuilt);
  // The new baseline becomes active and loads into the live store.
  applySnapshotToStore(promotedSnap, { preserveVariants: true });
  useStore.getState().setActiveVariantId(newBaselineId);
  useStore.getState().markDirty();
}

/**
 * Diff the active variant (live store) against the baseline. Returns null when
 * there are no variants. Keeps the active variant's snapshot fresh first, so
 * comparing while ON the baseline correctly shows "no changes".
 */
export function compareActiveToBaseline(opts?: DiffOptions): FeedDiff | null {
  const st = useStore.getState();
  if (!st.activeVariantId) return null;
  const liveSnap = buildSnapshot();
  st.updateVariantSnapshot(st.activeVariantId, liveSnap);
  const baseline = useStore.getState().variants.find((v) => v.baseline);
  if (!baseline) return null;
  return diffFeedState(toFeedState(baseline.snapshot), toFeedState(liveSnap), opts);
}

/**
 * Feed state for any variant by id, for the A-vs-B compare (compareVariants) and
 * its spatial metrics (variantSpatialMetrics.ts read stops/routes/routeStops off
 * this).
 *
 * The active variant's stored snapshot is deliberately allowed to go stale (the
 * live store is its source of truth), so for it we read the LIVE store via
 * buildSnapshot() rather than its frozen snapshot; every inactive variant reads
 * its frozen snapshot. buildSnapshot() only READS the store, so this is a pure
 * read that never mutates state — safe to call from a component's render or an
 * effect. Returns null for an unknown id.
 */
export function variantFeedState(id: string): FeedState | null {
  const st = useStore.getState();
  if (id === st.activeVariantId) return toFeedState(buildSnapshot());
  const v = st.variants.find((x) => x.id === id);
  return v ? toFeedState(v.snapshot) : null;
}

/**
 * Diff any two variants (A vs B), delta = B − A. The generalization of
 * compareActiveToBaseline: with a = baseline and b = the active variant it
 * produces the identical result, so the compare modal's default picker values
 * reproduce the old "compare to baseline" view exactly. Reads live for the
 * active side (see variantFeedState) so it reflects unsaved edits without
 * mutating any snapshot. Returns null if either id is unknown.
 */
export function compareVariants(aId: string, bId: string, opts?: DiffOptions): FeedDiff | null {
  const a = variantFeedState(aId);
  const b = variantFeedState(bId);
  if (!a || !b) return null;
  return diffFeedState(a, b, opts);
}
