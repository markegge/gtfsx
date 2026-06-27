// Validation grouping + batch-fix coverage.
//
// Covers: collapsing many messages of the same rule into one group (the "832×"
// case), the template key (quoted ids / numbers blanked), per-group fixable
// counts, error-first ordering, code-based groups, and the batch fix (applies to
// every fixable message in a group, a single combined undo, and the
// "Fixed X of N" accounting incl. the already-fine remainder).
//
// See services/validationGrouping.ts, services/validationFixes.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { runValidation } from '../validation';
import {
  groupValidationMessages, groupKeyOf, templateOfMessage,
} from '../validationGrouping';
import { applyValidationFixBatch } from '../validationFixes';
import type { Trip, StopTime } from '../../types/gtfs';
import type { ValidationMessage } from '../../types/ui';

function reset() {
  const s = useStore.getState();
  s.setTrips([]);
  s.setStopTimes([]);
}
beforeEach(reset);

// N trips whose FIRST stop has only departure_time (one-present) → N identical
// edge-time errors, each carrying the fill-trip-edge-times fix.
function manyOnePresentTrips(n: number) {
  const trips: Trip[] = [];
  const sts: StopTime[] = [];
  for (let i = 0; i < n; i++) {
    const id = `T${i}`;
    trips.push({ trip_id: id, route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip);
    sts.push(
      { trip_id: id, stop_id: 's1', stop_sequence: 1, arrival_time: '', departure_time: '08:00:00' },
      { trip_id: id, stop_id: 's2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' },
      { trip_id: id, stop_id: 's3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
    );
  }
  useStore.getState().setTrips(trips);
  useStore.getState().setStopTimes(sts as StopTime[]);
}

const m = (over: Partial<ValidationMessage>): ValidationMessage => ({
  id: Math.random().toString(36).slice(2), severity: 'error', message: 'x', ...over,
});

describe('templateOfMessage / groupKeyOf', () => {
  it('blanks quoted ids and numbers so per-entity messages collapse to one template', () => {
    const a = 'First served stop of trip "T1" is missing arrival_time or departure_time.';
    const b = 'First served stop of trip "T999" is missing arrival_time or departure_time.';
    expect(templateOfMessage(a)).toBe(templateOfMessage(b));
  });

  it('blanks numeric/percentage counts', () => {
    expect(templateOfMessage('23 of 45 stops (51%) are missing wheelchair_boarding.'))
      .toBe(templateOfMessage('7 of 9 stops (78%) are missing wheelchair_boarding.'));
  });

  it('keeps genuinely different rules apart', () => {
    const a = m({ message: 'First served stop of trip "T1" has no time.' });
    const b = m({ message: 'Last served stop of trip "T1" is missing arrival_time or departure_time.' });
    expect(groupKeyOf(a)).not.toBe(groupKeyOf(b));
  });

  it('prefers the rule code as the key when present', () => {
    expect(groupKeyOf(m({ code: 'holiday-exceptions', message: 'whatever "X"' })))
      .toBe('code:holiday-exceptions');
  });
});

describe('groupValidationMessages', () => {
  it('collapses many identical errors into one group with the full count', () => {
    manyOnePresentTrips(832);
    const msgs = runValidation(useStore.getState())
      .filter((x) => x.message.includes('missing arrival_time or departure_time'));
    expect(msgs).toHaveLength(832);

    const groups = groupValidationMessages(msgs);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(832);
    expect(groups[0].fixableCount).toBe(832);
    expect(groups[0].fixId).toBe('fill-trip-edge-times');
    expect(groups[0].messages).toHaveLength(832);
  });

  it('counts only registered fixes as fixable', () => {
    const msgs = [
      m({ message: 'A "1"', fix: { id: 'fill-trip-edge-times' } }),
      m({ message: 'A "2"', fix: { id: 'fill-trip-edge-times' } }),
      m({ message: 'A "3"' }), // same template, but no fix
    ];
    const [g] = groupValidationMessages(msgs);
    expect(g.count).toBe(3);
    expect(g.fixableCount).toBe(2);
  });

  it('orders errors before warnings, then by descending count', () => {
    const msgs = [
      m({ severity: 'warning', message: 'warn "a"' }),
      m({ severity: 'warning', message: 'warn "b"' }),
      m({ severity: 'error', message: 'err "1"' }),
    ];
    const groups = groupValidationMessages(msgs);
    expect(groups[0].severity).toBe('error');
    // The 2-message warning group sorts above any 1-message group of equal severity.
    const warnGroups = groups.filter((x) => x.severity === 'warning');
    expect(warnGroups[0].count).toBe(2);
  });

  it('exposes a shared code on a code-based group (so it can be dismissed as a class)', () => {
    const msgs = [
      m({ severity: 'warning', code: 'holiday-exceptions', message: 'h "A"' }),
      m({ severity: 'warning', code: 'holiday-exceptions', message: 'h "B"' }),
    ];
    const [g] = groupValidationMessages(msgs);
    expect(g.code).toBe('holiday-exceptions');
    expect(g.count).toBe(2);
  });
});

describe('applyValidationFixBatch', () => {
  it('fixes every fixable message in a group in one combined, undoable step', () => {
    manyOnePresentTrips(10);
    const msgs = runValidation(useStore.getState())
      .filter((x) => x.message.includes('missing arrival_time or departure_time'));
    const [g] = groupValidationMessages(msgs);

    const result = applyValidationFixBatch(g.messages);
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.label).toContain('Fixed 10 of 10');

    // Every flagged endpoint now has both times → no edge-time errors remain.
    const after = runValidation(useStore.getState())
      .filter((x) => x.message.includes('missing arrival_time or departure_time'));
    expect(after).toHaveLength(0);

    // One undo reverses ALL of them.
    result!.undo();
    const restored = runValidation(useStore.getState())
      .filter((x) => x.message.includes('missing arrival_time or departure_time'));
    expect(restored).toHaveLength(10);
  });

  it('reports how many actually changed vs were already fine', () => {
    manyOnePresentTrips(5);
    const msgs = runValidation(useStore.getState())
      .filter((x) => x.message.includes('missing arrival_time or departure_time'));
    const [g] = groupValidationMessages(msgs);

    // Pre-fix 2 of the 5 trips so the batch only changes 3.
    useStore.getState().fillTripEdgeTimes('T0');
    useStore.getState().fillTripEdgeTimes('T1');

    const result = applyValidationFixBatch(g.messages);
    expect(result!.changed).toBe(true);
    expect(result!.label).toContain('Fixed 3 of 5');
    expect(result!.label).toContain('2 already fine');
  });

  it('returns null when no message in the batch carries a registered fix', () => {
    const msgs = [m({ message: 'no fix "1"' }), m({ message: 'no fix "2"' })];
    expect(applyValidationFixBatch(msgs)).toBeNull();
  });

  it('reports an all-already-fine batch as changed=false (no undo needed)', () => {
    manyOnePresentTrips(3);
    const msgs = runValidation(useStore.getState())
      .filter((x) => x.message.includes('missing arrival_time or departure_time'));
    const [g] = groupValidationMessages(msgs);
    useStore.getState().fillTripEdgeTimes('T0');
    useStore.getState().fillTripEdgeTimes('T1');
    useStore.getState().fillTripEdgeTimes('T2');

    const result = applyValidationFixBatch(g.messages);
    expect(result!.changed).toBe(false);
    expect(result!.label).toContain('already fine');
  });
});
