// Pure presentation logic for the variants management panel — kept out of the
// component so it's unit-testable without rendering.
import type { FeedDiff } from '../../services/feedDiff';

const MINUS = '−'; // U+2212, matches the compare dialog's delta glyph

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${MINUS}${Math.abs(n)}`;
}
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Compact per-variant change chips vs baseline, from a feedDiff. Empty when the
 * variant is identical to baseline (the caller shows "No changes"). Cheap — uses
 * only the diff's entity counts, no spatial/network work.
 */
export function summarizeDiff(diff: FeedDiff | null): string[] {
  if (!diff || diff.identical) return [];
  const out: string[] = [];
  if (diff.trips.delta !== 0) out.push(`${signed(diff.trips.delta)} trips`);
  if (diff.routes.added) out.push(`+${plural(diff.routes.added, 'route')}`);
  if (diff.routes.removed) out.push(`${MINUS}${plural(diff.routes.removed, 'route')}`);
  if (diff.routes.changed) out.push(`${plural(diff.routes.changed, 'route')} changed`);
  const stopEdits = diff.stops.added + diff.stops.removed + diff.stops.changed;
  if (stopEdits) out.push(plural(stopEdits, 'stop edit'));
  const freqEdits = diff.frequencies.added + diff.frequencies.removed + diff.frequencies.changed;
  if (freqEdits) out.push(plural(freqEdits, 'frequency edit'));
  const patternEdits = diff.patterns.added + diff.patterns.removed;
  if (patternEdits) out.push(plural(patternEdits, 'pattern change'));
  return out;
}

export interface RowActions {
  canSwitch: boolean;
  canRename: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  canPromote: boolean;
  canCompare: boolean;
}

/**
 * Which actions a variant row exposes. The baseline is protected (no delete /
 * promote) and comparing it to itself is meaningless (no compare); the active
 * variant has no "switch" (you're already on it). Everything is renameable and
 * duplicable, including the baseline.
 */
export function rowActions(variant: { baseline: boolean }, isActive: boolean): RowActions {
  return {
    canSwitch: !isActive,
    canRename: true,
    canDuplicate: true,
    canDelete: !variant.baseline,
    canPromote: !variant.baseline,
    canCompare: !variant.baseline,
  };
}
