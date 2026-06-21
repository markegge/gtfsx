// Per-feed dismissible validation rules: the holiday-exception nudge carries a
// stable rule code, the store tracks a per-feed dismissed set, and the panel's
// filter logic hides dismissed messages. See store/validationSlice.ts +
// services/validation.ts + components/validation/ValidationPanel.tsx.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { runValidation, VALIDATION_CODES, DISMISSIBLE_RULE_LABELS } from '../../services/validation';
import type { ValidationMessage } from '../../types/ui';

// A calendar that runs every day across all of next year — every US holiday in
// range matches a service day, so the #17 holiday-exception nudge fires. Next
// year keeps end_date in the future, so the "expired pattern" warning never
// muddies the picture, no matter when the test runs.
const NEXT_YEAR = new Date().getFullYear() + 1;
const everydayCalendar = {
  service_id: 'WEEKDAY',
  monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 1, sunday: 1,
  start_date: `${NEXT_YEAR}0101`,
  end_date: `${NEXT_YEAR}1231`,
};

function reset() {
  const s = useStore.getState();
  s.setCalendars([]);
  s.setCalendarDates([]);
  s.setDismissedValidations([]);
}
beforeEach(reset);
afterEach(reset);

// Mirror of ValidationPanel's filter: a message is hidden when its rule code is
// in the per-feed dismissed set.
function visibleAfterDismiss(msgs: ValidationMessage[], dismissed: string[]) {
  return msgs.filter((m) => !(m.code && dismissed.includes(m.code)));
}
const holidayMsgs = (msgs: ValidationMessage[]) =>
  msgs.filter((m) => m.code === VALIDATION_CODES.holidayExceptions);

describe('holiday-exception rule code', () => {
  it('the holiday nudge carries the stable holiday-exceptions code', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    const holiday = holidayMsgs(msgs);
    expect(holiday.length).toBeGreaterThan(0);
    expect(holiday[0].severity).toBe('warning');
    expect(holiday[0].entity_type).toBe('calendar');
    // The code is registered with a human label for the "dismissed" drawer.
    expect(DISMISSIBLE_RULE_LABELS[VALIDATION_CODES.holidayExceptions]).toBeTruthy();
  });

  it('an adjacent rule (no code) stays non-dismissible', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    // "No routes defined" is a plain warning with no rule code.
    const noRoutes = msgs.find((m) => m.message === 'No routes defined');
    expect(noRoutes).toBeDefined();
    expect(noRoutes!.code).toBeUndefined();
  });
});

describe('dismissed-validations slice', () => {
  it('dismiss adds the code; restore removes it; both are idempotent', () => {
    const s = useStore.getState();
    s.dismissValidation(VALIDATION_CODES.holidayExceptions);
    s.dismissValidation(VALIDATION_CODES.holidayExceptions); // no duplicate
    expect(useStore.getState().dismissedValidations).toEqual([VALIDATION_CODES.holidayExceptions]);
    s.restoreValidation(VALIDATION_CODES.holidayExceptions);
    s.restoreValidation(VALIDATION_CODES.holidayExceptions); // no throw / no-op
    expect(useStore.getState().dismissedValidations).toEqual([]);
  });

  it('setDismissedValidations replaces the set and de-dups', () => {
    useStore.getState().setDismissedValidations(['a', 'a', 'b']);
    expect(useStore.getState().dismissedValidations).toEqual(['a', 'b']);
    // A non-array (malformed snapshot) resets to empty rather than throwing.
    useStore.getState().setDismissedValidations(undefined as never);
    expect(useStore.getState().dismissedValidations).toEqual([]);
  });
});

describe('dismiss filtering (panel logic)', () => {
  it('dismissing the holiday code hides every holiday message but nothing else', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    expect(holidayMsgs(msgs).length).toBeGreaterThan(0);

    useStore.getState().dismissValidation(VALIDATION_CODES.holidayExceptions);
    const dismissed = useStore.getState().dismissedValidations;
    const visible = visibleAfterDismiss(msgs, dismissed);

    // Holiday messages are gone from the visible list…
    expect(holidayMsgs(visible).length).toBe(0);
    // …but the underlying validation still produced them (restorable), and every
    // non-holiday message is untouched.
    expect(visible.length).toBe(msgs.length - holidayMsgs(msgs).length);
  });

  it('restore brings the holiday warning back', () => {
    useStore.getState().setCalendars([everydayCalendar as never]);
    const msgs = runValidation(useStore.getState());
    useStore.getState().dismissValidation(VALIDATION_CODES.holidayExceptions);
    useStore.getState().restoreValidation(VALIDATION_CODES.holidayExceptions);
    const visible = visibleAfterDismiss(msgs, useStore.getState().dismissedValidations);
    expect(holidayMsgs(visible).length).toBeGreaterThan(0);
  });
});
