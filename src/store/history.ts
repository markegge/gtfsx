// Undo / redo edit history for the editor (GitHub #49).
//
// Strategy: Immer inverse-patches. The store's Immer middleware is replaced by
// `immerWithHistory` (historyMiddleware.ts), which runs every recipe through
// `produceWithPatches` and hands the forward + inverse patch sets here. We keep
// only the patches (not full snapshots), so memory is bounded by the *size of
// each change*, not the size of the feed — important for large feeds (#30).
//
// Only FEED DATA enters the history (HISTORY_KEYS). Ephemeral UI state
// (selection, panels, map mode, hover), auth/orgs, feed variants, validation
// results, feature toggles and project metadata are excluded — a patch that
// only touches those keys records nothing.
//
// The undo/redo stacks live in module scope (NOT in the Zustand store) so the
// patch payloads never enter the autosave subscription or React's feed-data
// reactivity. A tiny separate store (`useHistoryUi`) carries just the reactive
// metadata the buttons + toast need. Session-scoped: nothing is persisted to
// IndexedDB (Dexie remains the durability source of truth).

import { applyPatches, enablePatches, type Patch } from 'immer';
import { create } from 'zustand';

enablePatches();

/**
 * Feed-data state keys that participate in undo/redo. Mirrors the GTFS entity
 * arrays the persistence layer treats as durable data (db/persistence.ts
 * DATA_KEYS) MINUS project metadata, feature settings and dismissed-validation
 * bookkeeping, which are deliberately not undoable.
 */
export const HISTORY_KEYS: ReadonlySet<string> = new Set<string>([
  'agencies', 'calendars', 'calendarDates', 'routes', 'routeStops',
  'stops', 'trips', 'stopTimes', 'shapes', 'feedInfo',
  'fareAttributes', 'fareRules',
  'fareAreas', 'stopAreas', 'fareNetworks', 'routeNetworks',
  'timeframes', 'riderCategories', 'fareMedia', 'fareProducts',
  'fareLegRules', 'fareTransferRules',
  'frequencies', 'levels', 'pathways', 'transfers', 'flexZones',
]);

/** Max undo steps retained. Oldest are dropped past this — bounds memory on
 *  large feeds (#30, #49). */
export const HISTORY_LIMIT = 100;

/** Rapid same-target edits (a stop drag, typing in a field) within this window
 *  collapse into a single undo step. */
export const COALESCE_WINDOW_MS = 500;

interface HistoryEntry {
  /** Forward patches (redo): base → state-after-edit. */
  patches: Patch[];
  /** Inverse patches (undo): state-after-edit → base. */
  inverse: Patch[];
  /** Human label for the toast, e.g. "move stop". */
  label: string;
  /** Coalescing key, or null for a discrete (non-coalescing) edit. */
  coalesceKey: string | null;
  ts: number;
}

let undoStack: HistoryEntry[] = [];
let redoStack: HistoryEntry[] = [];
let suppressDepth = 0;

// The store is bound after creation (bindHistory) to avoid an import cycle and
// to keep this module independently unit-testable.
interface BoundStore {
  getState: () => Record<string, unknown>;
  setState: (next: Record<string, unknown>, replace: true) => void;
}
let bound: BoundStore | null = null;
export function bindHistory(store: BoundStore) {
  bound = store;
}

/** Reactive metadata for the undo/redo buttons + toast. Kept OUT of the main
 *  store so patch payloads never touch autosave / feed-data subscriptions. */
export interface HistoryUiState {
  canUndo: boolean;
  canRedo: boolean;
  /** Label of the step the next undo would revert (null when empty). */
  undoLabel: string | null;
  /** Label of the step the next redo would re-apply (null when empty). */
  redoLabel: string | null;
  /** Transient toast text; `nonce` re-triggers identical messages. */
  toast: { text: string; nonce: number } | null;
}

export const useHistoryUi = create<HistoryUiState>(() => ({
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  toast: null,
}));

function syncUi(toastText?: string) {
  const undoTop = undoStack[undoStack.length - 1];
  const redoTop = redoStack[redoStack.length - 1];
  useHistoryUi.setState((s) => ({
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoLabel: undoTop ? undoTop.label : null,
    redoLabel: redoTop ? redoTop.label : null,
    toast: toastText ? { text: toastText, nonce: (s.toast?.nonce ?? 0) + 1 } : s.toast,
  }));
}

export function isSuppressed(): boolean {
  return suppressDepth > 0;
}

/** Run `fn` without recording its store mutations into history. */
export function runWithoutHistory<T>(fn: () => T): T {
  suppressDepth += 1;
  try {
    return fn();
  } finally {
    suppressDepth -= 1;
  }
}

/** Clear both stacks — called when a different feed is imported/loaded so undo
 *  can't cross a feed boundary. */
export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  syncUi();
}

/** Suppress history while `fn` runs (a bulk feed load), then reset both stacks.
 *  The idiom for every "load a different feed into the store" path. */
export function loadingFeed<T>(fn: () => T): T {
  const result = runWithoutHistory(fn);
  resetHistory();
  return result;
}

// Friendly entity labels, by the top-level state key a patch touches.
const KEY_LABEL: Record<string, string> = {
  stops: 'stop', routes: 'route', routeStops: 'route stops',
  trips: 'timetable', stopTimes: 'timetable', frequencies: 'frequencies',
  shapes: 'shape', agencies: 'agency', calendars: 'calendar',
  calendarDates: 'calendar', feedInfo: 'feed info', flexZones: 'flex zone',
  transfers: 'transfer', levels: 'station', pathways: 'station',
  fareAttributes: 'fares', fareRules: 'fares',
  fareAreas: 'fare area', stopAreas: 'fare area', fareNetworks: 'fares',
  routeNetworks: 'fares', timeframes: 'fares', riderCategories: 'fares',
  fareMedia: 'fares', fareProducts: 'fares', fareLegRules: 'fares',
  fareTransferRules: 'fares',
};

// When several keys change at once (e.g. a stop delete cascades into stop_times
// + route_stops + transfers), the primary key — earliest in this list — names
// the step. `routes` wins for a route delete (it cascades into everything);
// `stops` is placed ahead of trips/stop_times so a stop delete (which cascades
// into those) still reads as a stop edit.
const KEY_PRIORITY = [
  'routes', 'stops', 'trips', 'stopTimes', 'routeStops', 'shapes',
  'flexZones', 'calendars', 'calendarDates', 'agencies', 'transfers',
  'levels', 'pathways', 'frequencies', 'feedInfo',
  'fareAttributes', 'fareRules', 'fareAreas', 'stopAreas', 'fareNetworks',
  'routeNetworks', 'timeframes', 'riderCategories', 'fareMedia',
  'fareProducts', 'fareLegRules', 'fareTransferRules',
];

function primaryKey(keys: Set<string>): string {
  for (const k of KEY_PRIORITY) if (keys.has(k)) return k;
  return [...keys][0];
}

function deriveLabel(patches: Patch[]): string {
  const keys = new Set(patches.map((p) => String(p.path[0])));
  // Pure positional change to a single stop → "move stop".
  if (keys.size === 1 && keys.has('stops')) {
    const coordOnly = patches.every((p) => {
      const field = p.path[2];
      return field === 'stop_lat' || field === 'stop_lon';
    });
    if (coordOnly && patches.length > 0) return 'move stop';
  }
  // Pure geometry change to a single shape → "reshape route".
  if (keys.size === 1 && keys.has('shapes')) {
    const pointsOnly = patches.every((p) => p.path[2] === 'points');
    if (pointsOnly && patches.length > 0) return 'reshape route';
  }
  const key = primaryKey(keys);
  return `edit ${KEY_LABEL[key] ?? key}`;
}

/**
 * Coalescing key for an edit, or null if it must be its own undo step.
 *
 * Only fine-grained edits to a SINGLE existing entity coalesce: every patch
 * must be a deep field write (path length ≥ 3) on the same (key, index). That
 * captures the high-frequency cases the issue calls out — dragging a stop emits
 * many `stops[i].stop_lat/lon` writes; typing in a field emits many
 * `stops[i].name` writes — while keeping discrete operations (add/remove, whole
 * array replaces, multi-entity cascades) as separate steps.
 */
function deriveCoalesceKey(patches: Patch[]): string | null {
  let key: string | null = null;
  for (const p of patches) {
    if (p.path.length < 3) return null; // array-level op → discrete
    const k = `${String(p.path[0])}#${String(p.path[1])}`;
    if (key === null) key = k;
    else if (key !== k) return null; // touches >1 entity → discrete
  }
  return key;
}

/**
 * Record one store mutation's patches. Called by the store middleware on every
 * non-suppressed recipe `set`. Filters to feed-data keys, derives a label +
 * coalescing key, and pushes (or merges) an undo entry. A new edit always
 * clears the redo stack.
 */
export function recordChange(patches: Patch[], inverse: Patch[]): void {
  if (suppressDepth > 0) return;

  const fwd = patches.filter((p) => HISTORY_KEYS.has(String(p.path[0])));
  const inv = inverse.filter((p) => HISTORY_KEYS.has(String(p.path[0])));
  if (inv.length === 0) return; // nothing undoable changed

  const label = deriveLabel(inv);
  const coalesceKey = deriveCoalesceKey(inv);
  const now = Date.now();

  const top = undoStack[undoStack.length - 1];
  if (
    top &&
    coalesceKey !== null &&
    top.coalesceKey === coalesceKey &&
    now - top.ts <= COALESCE_WINDOW_MS
  ) {
    // Merge into the previous step so the whole gesture is one undo. To undo
    // the combined step we apply the NEW inverse first (state_n → state_{n-1}),
    // then the OLD inverse (→ base). Redo applies OLD forward then NEW forward.
    top.inverse = [...inv, ...top.inverse];
    top.patches = [...top.patches, ...fwd];
    top.label = label;
    top.ts = now;
    redoStack = [];
    syncUi();
    return;
  }

  undoStack.push({ patches: fwd, inverse: inv, label, coalesceKey, ts: now });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  syncUi();
}

/** Revert the most recent edit. Returns its label, or null if nothing to undo. */
export function undo(): string | null {
  if (!bound || undoStack.length === 0) return null;
  const entry = undoStack.pop()!;
  runWithoutHistory(() => {
    bound!.setState(applyPatches(bound!.getState(), entry.inverse), true);
  });
  redoStack.push(entry);
  syncUi(`Undo: ${entry.label}`);
  return entry.label;
}

/** Re-apply the most recently undone edit. Returns its label, or null. */
export function redo(): string | null {
  if (!bound || redoStack.length === 0) return null;
  const entry = redoStack.pop()!;
  runWithoutHistory(() => {
    bound!.setState(applyPatches(bound!.getState(), entry.patches), true);
  });
  undoStack.push(entry);
  syncUi(`Redo: ${entry.label}`);
  return entry.label;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Test/debug helper: current stack depths. */
export function historyDepths(): { undo: number; redo: number } {
  return { undo: undoStack.length, redo: redoStack.length };
}
