// Fix catalog entry #2 = fill-missing-wheelchair (GUIDED / interactive).
//
// Covers: validation.ts emitting ONE dismissible warning for board points with
// no wheelchair_boarding value (carrying the missing-wheelchair code + the
// fill-missing-wheelchair fix id), the warning being dismissible feed-wide by
// code, the registry exposing the fix as interactive (options + applyWithValue,
// NO deterministic apply), the deterministic applyValidationFix declining it,
// and the guided applyValidationFixWithValue routing the user-chosen value into
// fillMissingWheelchairBoarding over the canonical gap stop ids (the same set
// Stop Analysis → Accessibility shows) with a working undo.
//
// See services/validationFixes.ts, store/stopSlice.ts, services/validation.ts,
// services/stopAnalysis.ts, components/validation/ValidationPanel.tsx.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { runValidation, VALIDATION_CODES, DISMISSIBLE_RULE_LABELS } from '../validation';
import {
  getValidationFix, applyValidationFix, applyValidationFixWithValue,
} from '../validationFixes';
import { computeAccessibilityAudit } from '../stopAnalysis';
import type { Stop } from '../../types/gtfs';
import type { ValidationMessage } from '../../types/ui';

function stop(id: string, wb?: number, location_type = 0): Stop {
  return {
    stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111,
    location_type, wheelchair_boarding: wb as number,
  };
}

const wbOf = (id: string) =>
  useStore.getState().stops.find((s) => s.stop_id === id)!.wheelchair_boarding;

// The single aggregate wheelchair warning, found by its stable rule code.
const wcMsg = (msgs: ValidationMessage[]) =>
  msgs.find((m) => m.code === VALIDATION_CODES.missingWheelchair);

// Mirror of ValidationPanel's dismiss filter (a message is hidden when its code
// is in the per-feed dismissed set).
const visibleAfterDismiss = (msgs: ValidationMessage[], dismissed: string[]) =>
  msgs.filter((m) => !(m.code && dismissed.includes(m.code)));

function reset() {
  const s = useStore.getState();
  s.setStops([]);
  s.setRoutes([]);
  s.setDismissedValidations([]);
}
beforeEach(reset);

describe('validation.ts — missing wheelchair_boarding warning', () => {
  it('emits ONE dismissible warning carrying the code + the guided fix id', () => {
    useStore.getState().setStops([
      stop('a', 0),         // 0 = no information → gap
      stop('b', undefined), // unset → gap
      stop('c', 1),         // accessible → populated
    ]);
    const msgs = runValidation(useStore.getState());
    const all = msgs.filter((m) => m.code === VALIDATION_CODES.missingWheelchair);
    expect(all).toHaveLength(1); // aggregate, not one-per-stop

    const m = all[0];
    expect(m.severity).toBe('warning');
    expect(m.entity_type).toBe('stop');
    expect(m.fix).toEqual({ id: 'fill-missing-wheelchair' });
    // Registered with a human label for the dismissed drawer.
    expect(DISMISSIBLE_RULE_LABELS[VALIDATION_CODES.missingWheelchair]).toBeTruthy();
    // Message reflects the 2 of 3 gap.
    expect(m.message).toContain('2 of 3');
  });

  it('does NOT fire when every board point already declares accessibility', () => {
    useStore.getState().setStops([stop('a', 1), stop('b', 2)]);
    expect(wcMsg(runValidation(useStore.getState()))).toBeUndefined();
  });

  it('counts board points only — stations/entrances are not gaps', () => {
    // A station (1) + entrance (2) with no wheelchair value must NOT be counted;
    // only the single location_type-0 board point (also a gap) drives the warning.
    useStore.getState().setStops([
      stop('plat', 0),         // board point, gap
      stop('stn', undefined, 1), // station — excluded
      stop('ent', undefined, 2), // entrance — excluded
    ]);
    const m = wcMsg(runValidation(useStore.getState()));
    expect(m).toBeDefined();
    expect(m!.message).toContain('1 of 1'); // only the board point is in scope
  });

  it('dismissing the missing-wheelchair code hides the warning per feed', () => {
    useStore.getState().setStops([stop('a', 0)]);
    const msgs = runValidation(useStore.getState());
    expect(wcMsg(msgs)).toBeDefined();

    useStore.getState().dismissValidation(VALIDATION_CODES.missingWheelchair);
    const visible = visibleAfterDismiss(msgs, useStore.getState().dismissedValidations);
    expect(wcMsg(visible)).toBeUndefined();

    useStore.getState().restoreValidation(VALIDATION_CODES.missingWheelchair);
    const back = visibleAfterDismiss(msgs, useStore.getState().dismissedValidations);
    expect(wcMsg(back)).toBeDefined();
  });
});

describe('fix registry — fill-missing-wheelchair (guided)', () => {
  it('is registered as interactive, with 0/1/2 options and NO deterministic apply', () => {
    const fix = getValidationFix('fill-missing-wheelchair');
    expect(fix).toBeDefined();
    expect(fix!.label).toBe('Fix');
    expect(fix!.description).toBeTruthy();
    expect(fix!.interactive).toBe(true);
    expect(fix!.apply).toBeUndefined();          // not deterministic
    expect(fix!.applyWithValue).toBeTypeOf('function');
    expect(fix!.options?.map((o) => o.value)).toEqual([0, 1, 2]);
  });

  it('applyValidationFix (deterministic path) declines the interactive fix', () => {
    useStore.getState().setStops([stop('a', 0)]);
    const message: ValidationMessage = {
      id: '1', severity: 'warning', message: 'x', entity_type: 'stop',
      fix: { id: 'fill-missing-wheelchair' },
    };
    // The panel routes interactive fixes through the picker, never this path.
    expect(applyValidationFix(message)).toBeNull();
    // …and nothing was mutated.
    expect(wbOf('a')).toBe(0);
  });
});

describe('guided flow — applyValidationFixWithValue reaches the store fill', () => {
  const message: ValidationMessage = {
    id: '1', severity: 'warning', message: 'x', entity_type: 'stop',
    fix: { id: 'fill-missing-wheelchair' },
  };

  it('fills the canonical gap stops with the chosen value and undo restores', () => {
    useStore.getState().setStops([
      stop('a', 0),         // gap → filled
      stop('b', undefined), // gap → filled
      stop('c', 1),         // accessible → untouched
      stop('d', 2),         // not accessible → untouched
    ]);
    // The fix should target exactly the audit's gap set (what Stop Analysis shows).
    const gaps = computeAccessibilityAudit(useStore.getState()).gapStopIds.sort();
    expect(gaps).toEqual(['a', 'b']);

    const result = applyValidationFixWithValue(message, 1); // user picks Accessible
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.label).toContain('Accessible');

    expect(wbOf('a')).toBe(1);
    expect(wbOf('b')).toBe(1);
    expect(wbOf('c')).toBe(1); // already populated — never overwritten
    expect(wbOf('d')).toBe(2); // already populated — never overwritten

    // The warning clears on re-validate (no gaps left).
    expect(wcMsg(runValidation(useStore.getState()))).toBeUndefined();

    // Undo restores the prior (gap) values.
    result!.undo();
    expect(wbOf('a')).toBe(0);
    expect(wbOf('b')).toBe(0);
    expect(wcMsg(runValidation(useStore.getState()))).toBeDefined();
  });

  it('reports changed=false when there is no gap to fill (re-click is a no-op)', () => {
    useStore.getState().setStops([stop('a', 1), stop('b', 2)]);
    const result = applyValidationFixWithValue(message, 1);
    expect(result!.changed).toBe(false);
  });

  it('honours the user-chosen value (2 = Not accessible)', () => {
    useStore.getState().setStops([stop('a', 0)]);
    const result = applyValidationFixWithValue(message, 2);
    expect(result!.changed).toBe(true);
    expect(wbOf('a')).toBe(2);
  });
});
