import { describe, expect, it } from 'vitest';
import { summarizeDiff, rowActions } from '../variantPanelHelpers';
import type { FeedDiff } from '../../../services/feedDiff';

// Minimal FeedDiff shape for the summary — only the fields summarizeDiff reads.
function diff(over: Partial<FeedDiff> = {}): FeedDiff {
  const empty = { added: 0, removed: 0, changed: 0, addedIds: [], removedIds: [] };
  return {
    kpi: { a: {} as never, b: {} as never, delta: {} as never },
    routes: { ...empty },
    stops: { ...empty },
    calendars: { ...empty },
    frequencies: { ...empty },
    patterns: { ...empty },
    trips: { a: 0, b: 0, delta: 0 },
    routeChanges: [],
    identical: false,
    ...over,
  } as FeedDiff;
}

describe('summarizeDiff', () => {
  it('is empty for a null or identical diff', () => {
    expect(summarizeDiff(null)).toEqual([]);
    expect(summarizeDiff(diff({ identical: true }))).toEqual([]);
  });

  it('summarizes trips, routes, stops, frequencies and patterns compactly', () => {
    const chips = summarizeDiff(diff({
      trips: { a: 10, b: 13, delta: 3 },
      routes: { added: 1, removed: 0, changed: 2, addedIds: [], removedIds: [] },
      stops: { added: 1, removed: 1, changed: 0, addedIds: [], removedIds: [] },
      frequencies: { added: 0, removed: 0, changed: 1, addedIds: [], removedIds: [] },
      patterns: { added: 2, removed: 0, changed: 0, addedIds: [], removedIds: [] },
    }));
    expect(chips).toEqual([
      '+3 trips',
      '+1 route',
      '2 routes changed',
      '2 stop edits',
      '1 frequency edit',
      '2 pattern changes',
    ]);
  });

  it('uses a real minus glyph for negative/removed counts', () => {
    const chips = summarizeDiff(diff({
      trips: { a: 5, b: 3, delta: -2 },
      routes: { added: 0, removed: 1, changed: 0, addedIds: [], removedIds: [] },
    }));
    expect(chips[0]).toBe('−2 trips'); // U+2212
    expect(chips[1]).toBe('−1 route');
  });
});

describe('rowActions', () => {
  it('protects the baseline (no delete/promote/compare) and hides switch on the active row', () => {
    expect(rowActions({ baseline: true }, true)).toEqual({
      canSwitch: false, canRename: true, canDuplicate: true,
      canDelete: false, canPromote: false, canCompare: false,
    });
    expect(rowActions({ baseline: false }, false)).toEqual({
      canSwitch: true, canRename: true, canDuplicate: true,
      canDelete: true, canPromote: true, canCompare: true,
    });
    expect(rowActions({ baseline: false }, true).canSwitch).toBe(false);
  });
});
