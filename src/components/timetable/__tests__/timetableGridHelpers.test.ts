import { describe, it, expect } from 'vitest';
import {
  actColWidth,
  computeRowErrors,
  defaultColWidth,
  generateExistingIds,
  nextCell,
  nextTabCell,
  nextCompanionShapeId,
  planCascade,
  type GridProbe,
} from '../timetableGridHelpers';

// ── Row-order validation (the red-highlight / computeBad logic) ──────────────
describe('computeRowErrors', () => {
  it('never flags blank or skipped cells', () => {
    expect(computeRowErrors(['', null, ''])).toEqual([false, false, false]);
  });

  it('accepts an ascending row', () => {
    expect(computeRowErrors(['08:00', '08:05', '08:12'])).toEqual([false, false, false]);
  });

  it('flags a time that is <= the previous non-blank time', () => {
    // 08:04 comes after 08:05 → out of order.
    expect(computeRowErrors(['08:00', '08:05', '08:04'])).toEqual([false, false, true]);
  });

  it('flags an equal (non-increasing) time', () => {
    expect(computeRowErrors(['08:00', '08:00'])).toEqual([false, true]);
  });

  it('flags an unparseable time', () => {
    expect(computeRowErrors(['08:00', 'abc', '08:10'])).toEqual([false, true, false]);
  });

  it('ignores blanks between times without breaking the ordering', () => {
    expect(computeRowErrors(['08:00', '', '08:10'])).toEqual([false, false, false]);
  });

  it('checks arrival/departure pairs in order', () => {
    // dep 08:02 then next arr 08:01 → the second cell is out of order.
    expect(computeRowErrors(['08:00/08:02', '08:01/08:05'])).toEqual([false, true]);
  });
});

// ── Column widths ────────────────────────────────────────────────────────────
describe('defaultColWidth', () => {
  it('floors a short single-time column at 64px', () => {
    expect(defaultColWidth('A', false, false)).toBe(64);
  });
  it('floors an arr/dep column at 74px', () => {
    expect(defaultColWidth('A', false, true)).toBe(74);
  });
  it('caps a very long stop name at 136px', () => {
    expect(defaultColWidth('A very long transit center name that overflows', false, false)).toBe(136);
  });
  it('widens for a timepoint marker', () => {
    const name = 'Midtown Station';
    expect(defaultColWidth(name, true, false)).toBeGreaterThan(defaultColWidth(name, false, false));
  });
});

describe('actColWidth', () => {
  it('is compact for the menu/flyout presentations and wide for the icon strip', () => {
    expect(actColWidth('menu')).toBe(34);
    expect(actColWidth('flyout')).toBe(34);
    expect(actColWidth('strip')).toBe(140);
  });
});

// ── Keyboard navigation math (skip-hopping + row wrapping) ────────────────────
// A 3-trip × 3-stop grid where trip 1 skips stop 1 (no input there).
function probe(present: boolean[][]): GridProbe {
  return {
    hasInput: (t, s) => !!present[t]?.[s],
    rowExists: (t) => !!present[t]?.some(Boolean),
  };
}
const GRID = probe([
  [true, true, true],
  [true, false, true], // trip 1 skips stop 1
  [true, true, true],
]);

// A grid whose middle row exists but has NO inputs — a read-only frequency
// build-out row (item #8). Nav must hop over it, not stop at it.
const GRID_WITH_VIRTUAL: GridProbe = {
  hasInput: (t, s) => (t === 0 || t === 2) && s >= 0 && s < 3, // rows 0 and 2 are real
  rowExists: (t) => t >= 0 && t <= 2,                          // row 1 exists (the tr) but has no inputs
};

describe('nextCell (↑↓ / ←→)', () => {
  it('moves down within a column', () => {
    expect(nextCell(GRID, { t: 0, s: 0 }, 1, 0)).toEqual({ t: 1, s: 0 });
  });
  it('hops over a read-only (input-less) build-out row when moving down', () => {
    expect(nextCell(GRID_WITH_VIRTUAL, { t: 0, s: 1 }, 1, 0)).toEqual({ t: 2, s: 1 });
  });
  it('hops over a SKIP cell when moving down a column', () => {
    // From trip 0 stop 1, down: trip 1 stop 1 is skipped → land on trip 2 stop 1.
    expect(nextCell(GRID, { t: 0, s: 1 }, 1, 0)).toEqual({ t: 2, s: 1 });
  });
  it('returns null past the last trip row', () => {
    expect(nextCell(GRID, { t: 2, s: 0 }, 1, 0)).toBeNull();
  });
  it('moves right across stops', () => {
    expect(nextCell(GRID, { t: 0, s: 0 }, 0, 1)).toEqual({ t: 0, s: 1 });
  });
});

describe('nextTabCell (Tab / Shift-Tab)', () => {
  it('tabs to the next stop in the same row', () => {
    expect(nextTabCell(GRID, { t: 0, s: 0 }, 1, 3)).toEqual({ t: 0, s: 1 });
  });
  it('wraps to the next trip row at the end of a row', () => {
    expect(nextTabCell(GRID, { t: 0, s: 2 }, 1, 3)).toEqual({ t: 1, s: 0 });
  });
  it('skips a SKIP cell when wrapping', () => {
    // trip 1 stop 0 → next is trip 1 stop 1 (skipped) → trip 1 stop 2.
    expect(nextTabCell(GRID, { t: 1, s: 0 }, 1, 3)).toEqual({ t: 1, s: 2 });
  });
  it('runs off the grid after the last cell', () => {
    expect(nextTabCell(GRID, { t: 2, s: 2 }, 1, 3)).toBeNull();
  });
  it('shift-tabs backward and wraps to the previous row', () => {
    expect(nextTabCell(GRID, { t: 1, s: 0 }, -1, 3)).toEqual({ t: 0, s: 2 });
  });
});

// ── Cascade planning ─────────────────────────────────────────────────────────
describe('planCascade', () => {
  const ids = ['t0', 't1', 't2', 't3'];
  const hasTimeAll = () => true;

  it('offers to shift the later trips that have a time in the column', () => {
    const plan = planCascade({ orderedTripIds: ids, editedTripId: 't1', prevSec: 8 * 3600, newSec: 8 * 3600 + 300, hasTimeAt: hasTimeAll });
    expect(plan).toEqual({ deltaMin: 5, laterIds: ['t2', 't3'] });
  });

  it('returns null when the cell had no prior time (first entry, not an edit)', () => {
    expect(planCascade({ orderedTripIds: ids, editedTripId: 't1', prevSec: null, newSec: 8 * 3600, hasTimeAt: hasTimeAll })).toBeNull();
  });

  it('returns null when the time did not change', () => {
    expect(planCascade({ orderedTripIds: ids, editedTripId: 't1', prevSec: 8 * 3600, newSec: 8 * 3600 + 20, hasTimeAt: hasTimeAll })).toBeNull();
  });

  it('excludes later trips that have no time in the column', () => {
    const plan = planCascade({ orderedTripIds: ids, editedTripId: 't0', prevSec: 100, newSec: 100 - 120, hasTimeAt: (id) => id === 't2' });
    expect(plan).toEqual({ deltaMin: -2, laterIds: ['t2'] });
  });

  it('returns null when the edited trip is the last one', () => {
    expect(planCascade({ orderedTripIds: ids, editedTripId: 't3', prevSec: 100, newSec: 400, hasTimeAt: hasTimeAll })).toBeNull();
  });
});

// ── Companion (right) pane pattern preservation in Both view (item #7) ────────
describe('nextCompanionShapeId', () => {
  const patterns = ['out', 'in', 'branch'];

  it('stays derived (null) when already derived and the left changes', () => {
    expect(nextCompanionShapeId(null, 'in', patterns)).toBeNull();
  });

  it('keeps an explicit right choice when the left moves to a different pattern', () => {
    // left → 'out', right explicitly 'branch' (≠ left, valid) → preserved.
    expect(nextCompanionShapeId('branch', 'out', patterns)).toBe('branch');
  });

  it('falls back to derived when the left collides with the right choice', () => {
    // user drives the left onto the right pane's pattern → right re-derives.
    expect(nextCompanionShapeId('in', 'in', patterns)).toBeNull();
  });

  it('falls back to derived when the explicit choice is no longer a valid pattern', () => {
    expect(nextCompanionShapeId('gone', 'out', patterns)).toBeNull();
  });

  it('models a swap: old-left becomes the explicit right and survives the left change', () => {
    // Swap sets left='in', right=old-left='out'. After the left-change effect,
    // 'out' ≠ 'in' and valid → the right keeps the swapped pattern.
    expect(nextCompanionShapeId('out', 'in', patterns)).toBe('out');
  });
});

// ── Generate: which existing ids new trips must dodge (item #9) ───────────────
describe('generateExistingIds', () => {
  const all = ['Blue-1', 'Blue-2', 'Blue-3', 'Blue-4-in']; // -in kept in the other direction
  const scope = ['Blue-1', 'Blue-2', 'Blue-3'];

  it('Add alongside keeps every existing id (new names take next-highest)', () => {
    expect(generateExistingIds(all, scope, false)).toEqual(new Set(all));
  });

  it('Replace frees the scope ids for reuse but still dodges kept trips', () => {
    // The three scope trips go away → only the other-direction trip is left, so
    // the fresh batch can re-mint Blue-1..3.
    expect(generateExistingIds(all, scope, true)).toEqual(new Set(['Blue-4-in']));
  });

  it('Replace with nothing else in the feed frees all numbers', () => {
    expect(generateExistingIds(scope, scope, true)).toEqual(new Set());
  });
});
