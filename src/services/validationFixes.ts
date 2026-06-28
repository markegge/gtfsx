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
import type { ValidationFixId, ValidationMessage } from '../types/ui';
import { useStore } from '../store';

/** The result of applying a fix: a human label for the undo toast, whether
 *  anything actually changed (false → caller can skip the toast), and a closure
 *  that reverses the mutation. */
export interface ValidationFixResult {
  fixId: ValidationFixId;
  label: string;
  changed: boolean;
  undo: () => void;
}

export interface ValidationFix {
  id: ValidationFixId;
  /** Button label shown in the validation panel (e.g. "Fix"). */
  label: string;
  /** Tooltip / a11y description of what the fix does. */
  description: string;
  /** Mutate the store to resolve `message`; return an undo handle. */
  apply: (message: ValidationMessage) => ValidationFixResult;
}

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
      'Fill wheelchair_boarding on every board point that is missing a value. Choose '
      + 'which value to apply: 1 (accessible) or 2 (not accessible) records the status '
      + 'and clears the warning; 0 (no information) marks the stops reviewed without '
      + 'asserting a status. You can undo this.',
    // The validation panel renders a VALUE PICKER for this fix and calls
    // applyWheelchairFill(value) directly. This generic apply is the fallback
    // (e.g. the batch path): it fills 0 = "no information", the non-asserting
    // default.
    apply: () => applyWheelchairFill(0),
  },

  'remove-orphan-trips': {
    id: 'remove-orphan-trips',
    label: 'Fix',
    description:
      'Removes this trip (and its stop_times and any frequency windows) because its '
      + 'service_id does not match any calendar. The trip cannot run without a '
      + 'calendar — delete it or reassign it to a valid service_id first. You can undo this.',
    apply: (message) => {
      const tripId = message.entity_id ?? '';
      const snapshot = useStore.getState().removeTripWithSnapshot(tripId);
      const stCount = snapshot.stopTimes.length;
      const fqCount = snapshot.frequencies.length;
      return {
        fixId: 'remove-orphan-trips',
        changed: snapshot.trip !== undefined,
        label: snapshot.trip
          ? `Removed orphan trip "${tripId}" (${stCount} stop time${stCount === 1 ? '' : 's'}`
            + `${fqCount > 0 ? `, ${fqCount} frequency window${fqCount === 1 ? '' : 's'}` : ''}).`
          : `Trip "${tripId}" not found — nothing removed.`,
        undo: () => useStore.getState().restoreTrip(snapshot),
      };
    },
  },

  'delete-unused-stop': {
    id: 'delete-unused-stop',
    label: 'Fix',
    description:
      'Deletes this stop because no trip serves it (no stop_times reference it). '
      + 'Also removes any orphaned route_stops and transfers that reference it. '
      + 'You can undo this.',
    apply: (message) => {
      const stopId = message.entity_id ?? '';
      const snapshot = useStore.getState().removeStopWithSnapshot(stopId);
      const name = snapshot.stop?.stop_name || stopId;
      return {
        fixId: 'delete-unused-stop',
        changed: snapshot.stop !== undefined,
        label: snapshot.stop
          ? `Deleted unused stop "${name}".`
          : `Stop "${stopId}" not found — nothing deleted.`,
        undo: () => useStore.getState().restoreStop(snapshot),
      };
    },
  },
};

/** Look up a registered fix by id (undefined if the id isn't in the catalog —
 *  e.g. a message persisted with an id this build no longer ships). */
export function getValidationFix(id: ValidationFixId): ValidationFix | undefined {
  return FIXES[id];
}

/** Board-point stops (location_type 0) missing an authoritative
 *  wheelchair_boarding value — 0 OR absent both read as "no information". */
function wheelchairGapStopIds(): string[] {
  return useStore.getState().stops
    .filter((s) => (s.location_type ?? 0) === 0)
    .filter((s) => s.wheelchair_boarding !== 1 && s.wheelchair_boarding !== 2)
    .map((s) => s.stop_id);
}

export const WHEELCHAIR_VALUE_LABEL: Record<number, string> = {
  0: 'no info',
  1: 'accessible',
  2: 'not accessible',
};

/** Count of board points that would be filled (for the picker's button label). */
export function wheelchairGapCount(): number {
  return wheelchairGapStopIds().length;
}

/** Fill every board point missing wheelchair_boarding with `value` (0/1/2), for
 *  the Validation panel's wheelchair fix-recipe value picker. Returns a
 *  ValidationFixResult so the panel's undo toast reverses it. Note: filling 0
 *  ("no info") does not clear the validator warning (GTFS treats blank and 0
 *  identically); 1 or 2 does. */
export function applyWheelchairFill(value: number): ValidationFixResult {
  const ids = wheelchairGapStopIds();
  const snapshot = useStore.getState().fillMissingWheelchairBoarding(ids, value);
  const n = snapshot.length;
  const label = WHEELCHAIR_VALUE_LABEL[value] ?? String(value);
  return {
    fixId: 'fill-missing-wheelchair',
    changed: n > 0,
    label: n > 0
      ? `Set wheelchair_boarding = ${value} (${label}) on ${n} stop${n === 1 ? '' : 's'}.`
      : 'Nothing to fill — all board points already have a value.',
    undo: () => useStore.getState().restoreWheelchairBoarding(snapshot),
  };
}

/** Apply the fix a message carries, if any. Returns the undo result, or null
 *  when the message has no fix or its id isn't registered. */
export function applyValidationFix(message: ValidationMessage): ValidationFixResult | null {
  if (!message.fix) return null;
  const fix = FIXES[message.fix.id];
  if (!fix) return null;
  return fix.apply(message);
}

/**
 * Apply the relevant fix to EVERY message in a group that carries one, as a
 * single undoable step. Each per-message `apply` already returns its own undo;
 * we run them in order, count how many actually changed (vs were already fine),
 * and fold the per-message undos into one closure so the panel's existing
 * single-fix undo toast can reverse the whole batch.
 *
 * Returns a ValidationFixResult shaped exactly like the single-fix path (so the
 * toast component is unchanged): `label` reports "Fixed X of N" (with the
 * already-fine remainder), `changed` is true when at least one row changed, and
 * `undo()` reverses all of them. Returns null when no message in the batch has a
 * registered fix. Re-running validation after a batch is automatic: the fixes
 * mutate store slices the validation memo depends on, so the list refreshes.
 */
export function applyValidationFixBatch(messages: ValidationMessage[]): ValidationFixResult | null {
  const results: ValidationFixResult[] = [];
  let total = 0;
  let changed = 0;
  let fixId: ValidationFixId | null = null;
  for (const m of messages) {
    if (!m.fix) continue;
    const fix = FIXES[m.fix.id];
    if (!fix) continue;
    total++;
    fixId = m.fix.id;
    const r = fix.apply(m);
    results.push(r);
    if (r.changed) changed++;
  }
  if (total === 0 || fixId === null) return null;
  const alreadyFine = total - changed;
  const label = changed > 0
    ? `Fixed ${changed} of ${total}${alreadyFine > 0 ? ` (${alreadyFine} already fine)` : ''}.`
    : `Nothing to fix (all ${total} already fine).`;
  return {
    fixId,
    changed: changed > 0,
    label,
    // Reverse order so overlapping snapshots unwind cleanly (independent here,
    // but order-safe by construction).
    undo: () => { for (let i = results.length - 1; i >= 0; i--) results[i].undo(); },
  };
}
