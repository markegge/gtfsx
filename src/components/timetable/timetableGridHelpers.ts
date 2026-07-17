import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import { normalizeTimeInput } from '../../utils/time';

/* ============================================================================
   Layout constants + content-based column widths (HANDOFF §5)
   ========================================================================== */

export const TRIP_COL_MIN = 58;
export const TRIP_COL_DEFAULT = 78;
export const COL_MIN = 58;
export const COL_MAX = 300;

/* ============================================================================
   Split-view divider ratio (draggable pane resize)
   ========================================================================== */

/** Neither split pane may drop below this — a timetable narrower than this is
 *  unusable (Trip + actions + a couple of stop columns). */
export const SPLIT_MIN_PANE_PX = 300;
export const SPLIT_DEFAULT_RATIO = 0.5;

/** Clamp a left-pane width fraction so both panes keep SPLIT_MIN_PANE_PX. When
 *  the container can't fit two min-width panes (narrow / 390px mobile), the split
 *  is pinned even (0.5) — the caller also disables dragging there. Pure. */
export function clampSplitRatio(ratio: number, containerWidth: number, minPanePx = SPLIT_MIN_PANE_PX): number {
  if (!(containerWidth > 0) || containerWidth < 2 * minPanePx) return SPLIT_DEFAULT_RATIO;
  const min = minPanePx / containerWidth;
  return Math.min(1 - min, Math.max(min, ratio));
}

/** Whether the divider can be dragged at a given container width (both panes can
 *  still meet the minimum). Below this the split is a fixed even 50/50. */
export function splitResizable(containerWidth: number, minPanePx = SPLIT_MIN_PANE_PX): boolean {
  return containerWidth >= 2 * minPanePx;
}

/** The left-pane fraction for a pointer x within the container, clamped. Pure. */
export function splitRatioFromPointer(pointerX: number, containerLeft: number, containerWidth: number, minPanePx = SPLIT_MIN_PANE_PX): number {
  return clampSplitRatio((pointerX - containerLeft) / containerWidth, containerWidth, minPanePx);
}

/* ============================================================================
   Default direction on route select — the direction that begins service first
   ========================================================================== */

/** The direction a freshly selected route should default to: the one with the
 *  earliest first departure among the given trips (each carries its first-stop
 *  time in seconds, or null if untimed). Direction 1 wins only when it is
 *  STRICTLY earlier; ties and no-times fall back to 0. Pure. */
export function earliestDepartureDirection(trips: { directionId: 0 | 1; firstSec: number | null }[]): 0 | 1 {
  let min0: number | null = null;
  let min1: number | null = null;
  for (const t of trips) {
    if (t.firstSec == null) continue;
    if (t.directionId === 1) { if (min1 == null || t.firstSec < min1) min1 = t.firstSec; }
    else { if (min0 == null || t.firstSec < min0) min0 = t.firstSec; }
  }
  if (min1 != null && (min0 == null || min1 < min0)) return 1;
  return 0;
}

/** Flip direction_id (0↔1) on every item of one route, leaving other routes
 *  untouched. Works for trips and route_stops alike (both carry route_id +
 *  direction_id). Pure — returns a new array. */
export function swapRouteDirections<T extends { route_id: string; direction_id: 0 | 1 }>(items: T[], routeId: string): T[] {
  return items.map((it) => (it.route_id === routeId ? { ...it, direction_id: (it.direction_id === 0 ? 1 : 0) as 0 | 1 } : it));
}

export type RowActionStyle = 'menu' | 'strip' | 'flyout';

/** Width of the sticky actions column for a given presentation. */
export function actColWidth(mode: RowActionStyle): number {
  return mode === 'strip' ? 140 : 34;
}

/** Content-based default column width: a time is ~5ch of mono (the floor); the
 *  header ellipsizes; the cap keeps a long stop name from eating the viewport.
 *  Widens to fit two stacked inputs when the column authors arr/dep. */
export function defaultColWidth(name: string, isTimepoint: boolean, arrDep: boolean): number {
  const label = 22 + name.length * 5.9 + (isTimepoint ? 13 : 0);
  return Math.round(Math.max(arrDep ? 74 : 64, Math.min(136, label)));
}

/* ============================================================================
   Row-order validation (HANDOFF §8 — computeBad)
   ========================================================================== */

function hmsToSec(hms: string): number {
  const [h = 0, m = 0, s = 0] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

/** Mark a cell red when its time is unparseable or ≤ the previous non-blank time
 *  in the row (typo / inversion catch). Arr/dep pairs are checked in order. */
export function computeRowErrors(times: (string | null)[]): boolean[] {
  let prev = -1;
  return times.map((t) => {
    if (t == null || t === '') return false; // blank / skipped — no error
    let bad = false;
    for (const part of String(t).split('/')) {
      if (part === '') continue;
      const norm = normalizeTimeInput(part);
      if (!norm) { bad = true; continue; }
      const sec = hmsToSec(norm);
      if (sec <= prev) bad = true;
      else prev = sec;
    }
    return bad;
  });
}

/* ============================================================================
   Spreadsheet keyboard navigation (HANDOFF §5 — navFrom / Tab)
   ========================================================================== */

/** A grid coordinate (trip row index, stop column index). */
export interface CellCoord { t: number; s: number }

/** Predicates over the live grid: does an input exist at (t, s)? does trip row t
 *  have any input at all? Pulled out so the navigation MATH (skip-hopping, row
 *  wrapping) is pure and unit-testable, independent of the DOM. */
export interface GridProbe {
  hasInput: (t: number, s: number) => boolean;
  rowExists: (t: number) => boolean;
}

/** Single-axis move (↑/↓ within a stop column, ←/→ across stops). A cell with no
 *  input is a SKIP — hop over it. Returns the next focusable coord, or null off
 *  the grid. Pure. */
export function nextCell(probe: GridProbe, from: CellCoord, dTrip: number, dStop: number): CellCoord | null {
  let { t, s } = from;
  for (let guard = 0; guard < 4000; guard++) {
    t += dTrip;
    s += dStop;
    if (t < 0 || s < 0) return null;
    if (probe.hasInput(t, s)) return { t, s };
    if (dTrip && !probe.rowExists(t)) return null;
    if (dStop && s > 400) return null;
    if (dTrip && t > 4000) return null;
  }
  return null;
}

/** Tab / Shift-Tab in reading order: next/prev stop, wrapping to the next/prev
 *  trip row at the grid edge, skipping SKIP cells. Returns the next focusable
 *  coord, or null off the grid. Pure. */
export function nextTabCell(probe: GridProbe, from: CellCoord, step: number, totalStops: number): CellCoord | null {
  let { t, s } = from;
  for (let guard = 0; guard < 8000; guard++) {
    s += step;
    if (s >= totalStops) { s = 0; t++; }
    else if (s < 0) { s = totalStops - 1; t--; }
    if (t < 0) return null;
    if (!probe.rowExists(t)) return null; // past the last / first trip row
    if (probe.hasInput(t, s)) return { t, s };
  }
  return null;
}

// Focus lands on the input at (t, s[, part]) after React has committed the
// current edit's re-render. A commit can rename a `_new` trip (row key changes →
// remount), so the element is re-queried on the next frame rather than captured.
function focusCell(table: HTMLTableElement, t: number, s: number, part?: string) {
  const sel = `input[data-ti="${t}"][data-si="${s}"]` + (part ? `[data-part="${part}"]` : '');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const el = table.querySelector<HTMLInputElement>(sel);
      if (el) { el.focus(); el.select(); }
    });
  });
}

function domProbe(table: HTMLTableElement, part?: string): GridProbe {
  return {
    hasInput: (t, s) => !!table.querySelector(`input[data-ti="${t}"][data-si="${s}"]` + (part ? `[data-part="${part}"]` : '')),
    // Match the row element (tr[data-ti]), not just inputs, so a read-only
    // frequency build-out row (item #8) counts as an existing row: keyboard nav
    // then hops OVER it (no input to land on) instead of halting at it.
    rowExists: (t) => !!table.querySelector(`[data-ti="${t}"]`),
  };
}

/** DOM wrapper for {@link nextCell}: ↑↓ within a column, ←→ across stops. */
export function navFrom(el: HTMLInputElement, dTrip: number, dStop: number): boolean {
  const table = el.closest('table');
  if (!table) return false;
  const part = el.dataset.part || undefined;
  const to = nextCell(domProbe(table, part), { t: Number(el.dataset.ti), s: Number(el.dataset.si) }, dTrip, dStop);
  if (!to) return false;
  focusCell(table, to.t, to.s, part);
  return true;
}

/** DOM wrapper for {@link nextTabCell}: Tab / Shift-Tab in reading order. */
export function navTab(el: HTMLInputElement, step: number, totalStops: number): boolean {
  const table = el.closest('table');
  if (!table) return false;
  const to = nextTabCell(domProbe(table), { t: Number(el.dataset.ti), s: Number(el.dataset.si) }, step, totalStops);
  if (!to) return false;
  focusCell(table, to.t, to.s);
  return true;
}

/* ============================================================================
   Anchored menu positioning — flip up / clamp so a fixed dropdown stays on-screen
   ========================================================================== */

/** Position a fixed-position dropdown anchored to a trigger's rect. Opens below
 *  by default, but flips above when it would overflow the viewport bottom (the
 *  bottom panel is often short), and clamps horizontally. Measured in a layout
 *  effect so the flip lands before paint (no flash). */
export function useAnchoredMenuPosition(
  ref: RefObject<HTMLElement | null>,
  rect: DOMRect,
  gap = 6,
): { top: number; left: number } {
  const [style, setStyle] = useState<{ top: number; left: number }>({ top: rect.bottom + gap, left: rect.left });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = rect.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - gap - h);
    let left = rect.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    setStyle({ top, left });
  }, [ref, rect, gap]);
  return style;
}

/* ============================================================================
   Cascade planning (HANDOFF §5) — pure decision for the "shift later trips" pill
   ========================================================================== */

export interface CascadePlan {
  /** Change to the edited time, in whole minutes (may be negative). */
  deltaMin: number;
  /** Trip ids after the edited one that have a time in the edited column. */
  laterIds: string[];
}

/** After a cell edit changed a previously-set time by Δ, decide whether to offer
 *  shifting the later trips that also have a time in that column. Returns null
 *  when there's nothing to offer (no prior time, Δ = 0, or no later trips with a
 *  time there). Pure — the orchestrator does the store writes. */
export function planCascade(params: {
  orderedTripIds: string[];
  editedTripId: string;
  prevSec: number | null;
  newSec: number;
  hasTimeAt: (tripId: string) => boolean;
}): CascadePlan | null {
  const { orderedTripIds, editedTripId, prevSec, newSec } = params;
  if (prevSec == null) return null;
  const deltaMin = Math.round((newSec - prevSec) / 60);
  if (deltaMin === 0) return null;
  const idx = orderedTripIds.indexOf(editedTripId);
  if (idx < 0) return null;
  const laterIds = orderedTripIds.slice(idx + 1).filter((id) => params.hasTimeAt(id));
  if (laterIds.length === 0) return null;
  return { deltaMin, laterIds };
}

/** Resolve the companion (right) pane's pattern after the main (left) pane's
 *  pattern changes in Both view: keep the user's EXPLICIT right choice unless it
 *  now collides with the new left pattern or is no longer a valid pattern — then
 *  fall back to derived-opposite (null). `prev === null` means already derived.
 *  Pure state-machine step for the pane direction control (item #7). */
export function nextCompanionShapeId(
  prev: string | null,
  leftShapeId: string | null,
  patternShapeIds: readonly string[],
): string | null {
  if (prev && prev !== leftShapeId && patternShapeIds.includes(prev)) return prev;
  return null;
}

/** Trip ids a freshly generated batch must avoid colliding with, for minting
 *  pithy names (item #9). "Add alongside" keeps every existing trip, so new
 *  names take the next-highest numbers. "Replace" first drops the scope's own
 *  trips, freeing their numbers for reuse while still dodging trips kept in
 *  other directions/services. Pure. */
export function generateExistingIds(
  allTripIds: readonly string[],
  scopeTripIds: readonly string[],
  replace: boolean,
): Set<string> {
  if (!replace) return new Set(allTripIds);
  const doomed = new Set(scopeTripIds);
  return new Set(allTripIds.filter((id) => !doomed.has(id)));
}

/* ============================================================================
   Dismiss-on-outside hook for menus / popovers (HANDOFF §5, §6)
   ========================================================================== */

/** Close on Escape, on a mousedown outside `ref` (unless the target matches
 *  `ignoreSelector`, e.g. the trigger button), and on any scroll — a
 *  fixed-position menu would otherwise go stale when the grid scrolls under it. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  ignoreSelector?: string,
) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current && ref.current.contains(target)) return;
      if (ignoreSelector && target.closest(ignoreSelector)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [ref, onClose, ignoreSelector]);
}
