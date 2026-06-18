/**
 * A2 — feed variant actions (the orchestration the variantSlice can't hold
 * because it needs buildSnapshot / applySnapshotToStore).
 *
 * Model (see variantSlice): the live store is always the ACTIVE variant's
 * working copy. Inactive variants hold a frozen buildSnapshot(). Switching
 * serializes the live store into the outgoing variant, then loads the incoming
 * one. Comparing diffs the baseline's snapshot against the live store.
 *
 * Session-scoped + client-side: nothing here touches the server or the
 * working-state blob (variants aren't in DATA_KEYS). Server projects only
 * persist on an explicit Save, so an experimental variant never auto-clobbers a
 * saved feed — though saving WHILE a non-baseline variant is active will save
 * that variant (the active-variant banner makes that state obvious).
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
    st.addVariant({
      id: generateId('variant'),
      name: 'Baseline',
      baseline: true,
      createdAt: nowMs(),
      snapshot: buildSnapshot(),
    });
  }

  const count = useStore.getState().variants.filter((v) => !v.baseline).length;
  const id = generateId('variant');
  st.addVariant({
    id,
    name: (name && name.trim()) || `Variant ${count + 1}`,
    baseline: false,
    createdAt: nowMs(),
    snapshot: buildSnapshot(),
  });
  // The new variant's content == current live feed, so no reload needed — just
  // route future edits to it.
  st.setActiveVariantId(id);
  return id;
}

/** Switch which variant the live store represents (saving the outgoing one). */
export function switchToVariant(id: string): void {
  const st = useStore.getState();
  if (id === st.activeVariantId) return;
  if (st.activeVariantId) st.updateVariantSnapshot(st.activeVariantId, buildSnapshot());
  const target = useStore.getState().variants.find((v) => v.id === id);
  if (!target) return;
  applySnapshotToStore(target.snapshot);
  useStore.getState().setActiveVariantId(id);
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
      applySnapshotToStore(baseline.snapshot);
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
}

/** Discard the variant layer entirely, returning the feed to the baseline. */
export function discardVariants(): void {
  const baseline = baselineVariant();
  if (baseline) applySnapshotToStore(baseline.snapshot);
  const st = useStore.getState();
  st.setVariants([]);
  st.setActiveVariantId(null);
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
