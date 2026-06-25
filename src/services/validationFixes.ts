// One-click "Fix" catalog for validation errors.
//
// A ValidationMessage can carry an optional `fix: { id }` descriptor (see
// types/ui.ts). This registry maps that stable id → a ValidationFix with a
// human label/description and an `apply(message)` that mutates the store (via
// store actions) and returns an undo handle. The validation panel renders a
// "Fix" button for any message whose id is registered here; clicking it applies
// the fix and shows an undo toast.
//
// The undo-snapshot pattern mirrors the wheelchair bulk-fill (store/stopSlice.ts
// `fillMissingWheelchairBoarding` + `restoreWheelchairBoarding`): the store
// action returns a data snapshot of what it changed, and a paired restore action
// reverses it. Here `apply` wraps that into a generic `{ changed, label, undo }`
// so the panel stays fix-agnostic.
//
// Two kinds of fix live here:
//   • DETERMINISTIC (fill-trip-edge-times): a single right answer, so the panel
//     calls `apply(message)` directly and shows the returned undo handle.
//   • GUIDED / INTERACTIVE (fill-missing-wheelchair): no safe blind default, so
//     `interactive: true` + `options` tell the panel to open a small value
//     picker, and the chosen value is passed to `applyWithValue(message, value)`
//     (same undo-handle shape). The wheelchair fill reuses the existing store
//     action + undo (store/stopSlice.ts) and reads the gap stop ids from the
//     canonical audit (computeAccessibilityAudit — the same set Stop Analysis →
//     Accessibility shows), so the catalog stays the single source of the value
//     choice while the panel stays fix-agnostic.
import type { ValidationFixId, ValidationMessage } from '../types/ui';
import { useStore } from '../store';
import { computeAccessibilityAudit } from './stopAnalysis';

/** The result of applying a fix: a human label for the undo toast, whether
 *  anything actually changed (false → caller can skip the toast), and a closure
 *  that reverses the mutation. */
export interface ValidationFixResult {
  fixId: ValidationFixId;
  label: string;
  changed: boolean;
  undo: () => void;
}

/** One discrete choice offered by a guided fix's value picker. */
export interface ValidationFixOption {
  value: number;
  label: string;
}

export interface ValidationFix {
  id: ValidationFixId;
  /** Button label shown in the validation panel (e.g. "Fix"). */
  label: string;
  /** Tooltip / a11y description of what the fix does. */
  description: string;
  /** DETERMINISTIC fix: mutate the store to resolve `message` and return an undo
   *  handle. Present on non-interactive fixes; the panel calls it on click.
   *  Absent on guided fixes (use `applyWithValue` instead). */
  apply?: (message: ValidationMessage) => ValidationFixResult;
  /** GUIDED fix: true when the fix needs a user-chosen value before it can run
   *  (no safe blind default). The panel opens a picker over `options` instead of
   *  applying on click. */
  interactive?: boolean;
  /** The discrete choices the panel renders in its picker for a guided fix. */
  options?: ValidationFixOption[];
  /** GUIDED fix: apply with the user's chosen value; returns the same undo-handle
   *  shape as `apply` so the panel's undo toast stays fix-agnostic. */
  applyWithValue?: (message: ValidationMessage, value: number) => ValidationFixResult;
}

// Bulk-fill choices for wheelchair_boarding (GTFS 0/1/2), labelled per the spec
// (0 is "no information", not "unknown"). Mirrors StopAnalysisPanel's picker so
// the validation-panel guided fix and the Stop Analysis bulk-fill agree.
const WHEELCHAIR_FILL_OPTIONS: ValidationFixOption[] = [
  { value: 0, label: '0 — No information' },
  { value: 1, label: '1 — Accessible' },
  { value: 2, label: '2 — Not accessible' },
];

const FIXES: Record<ValidationFixId, ValidationFix> = {
  'fill-trip-edge-times': {
    id: 'fill-trip-edge-times',
    label: 'Fix',
    description:
      "Copy the one present time into the blank field on the trip's first/last "
      + 'stop, so arrival_time and departure_time both have a value (the '
      + "recommended remedy for a partially-timed trip endpoint). You can undo this.",
    apply: (message) => {
      const tripId = message.entity_id ?? '';
      // fillTripEdgeTimes touches ONLY endpoints with exactly one of
      // arrival/departure set — the both-blank (interpolated) endpoint the
      // validator flags separately is left untouched here.
      const snapshot = useStore.getState().fillTripEdgeTimes(tripId);
      return {
        fixId: 'fill-trip-edge-times',
        changed: snapshot.length > 0,
        label: snapshot.length > 0
          ? `Filled trip-edge time${snapshot.length === 1 ? '' : 's'} on trip "${tripId}".`
          : 'Nothing to fix on this trip.',
        undo: () => useStore.getState().restoreTripEdgeTimes(snapshot),
      };
    },
  },
  'fill-missing-wheelchair': {
    id: 'fill-missing-wheelchair',
    label: 'Fix',
    description:
      'Set wheelchair_boarding on every board point that has no value yet. Pick '
      + 'the value to apply (0 = no information, 1 = accessible, 2 = not '
      + 'accessible) — there is no safe blind default, so you choose it. Stops '
      + 'that already declare accessibility (1 or 2) are left untouched. You can '
      + 'undo this.',
    interactive: true,
    options: WHEELCHAIR_FILL_OPTIONS,
    applyWithValue: (_message, value) => {
      // Read the gap stop ids from the canonical audit so they match exactly what
      // Stop Analysis → Accessibility shows; the store action re-checks each stop
      // (never overwrites 1/2), so a slightly stale set is still safe.
      const gapStopIds = computeAccessibilityAudit(useStore.getState()).gapStopIds;
      const snapshot = useStore.getState().fillMissingWheelchairBoarding(gapStopIds, value);
      const label = WHEELCHAIR_FILL_OPTIONS.find((o) => o.value === value)?.label ?? String(value);
      return {
        fixId: 'fill-missing-wheelchair',
        changed: snapshot.length > 0,
        label: snapshot.length > 0
          ? `Set ${snapshot.length} stop${snapshot.length === 1 ? '' : 's'} to "${label}".`
          : 'No stops needed a wheelchair_boarding value.',
        undo: () => useStore.getState().restoreWheelchairBoarding(snapshot),
      };
    },
  },
};

/** Look up a registered fix by id (undefined if the id isn't in the catalog —
 *  e.g. a message persisted with an id this build no longer ships). */
export function getValidationFix(id: ValidationFixId): ValidationFix | undefined {
  return FIXES[id];
}

/** Apply a DETERMINISTIC fix the message carries, if any. Returns the undo
 *  result, or null when the message has no fix, its id isn't registered, or the
 *  fix is interactive (use applyValidationFixWithValue for those). */
export function applyValidationFix(message: ValidationMessage): ValidationFixResult | null {
  if (!message.fix) return null;
  const fix = FIXES[message.fix.id];
  if (!fix || !fix.apply) return null;
  return fix.apply(message);
}

/** Apply a GUIDED/interactive fix with the user's chosen value. Returns the undo
 *  result, or null when the message has no fix, its id isn't registered, or the
 *  fix isn't interactive (use applyValidationFix for deterministic fixes). */
export function applyValidationFixWithValue(
  message: ValidationMessage,
  value: number,
): ValidationFixResult | null {
  if (!message.fix) return null;
  const fix = FIXES[message.fix.id];
  if (!fix || !fix.applyWithValue) return null;
  return fix.applyWithValue(message, value);
}
