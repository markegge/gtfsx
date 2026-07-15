// One-click "Fix" catalog for validation errors, entry #1 = fill-trip-edge-times.
//
// Covers: the store action (one-present endpoint → both filled; both-blank left
// alone; undo restores), the registry wrapper (apply + undo, label lookup),
// validation.ts attaching the fix on the one-present variant ONLY (blankBoth
// excluded), and the panel's render-predicate + click code path (a message with
// a registered fix shows a labelled button whose click applies the mutation).
//
// See services/validationFixes.ts, store/tripSlice.ts, services/validation.ts,
// components/validation/ValidationPanel.tsx.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { runValidation } from '../validation';
import { getValidationFix, applyValidationFix } from '../validationFixes';
import type { Trip, StopTime, RouteStop } from '../../types/gtfs';
import type { ValidationMessage } from '../../types/ui';

function reset() {
  const s = useStore.getState();
  s.setTrips([]);
  s.setStopTimes([]);
  s.setRouteStops([]);
  s.setShapes([]);
  s.setCalendars([
    { service_id: 'S1', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never,
  ]);
  s.setRoutes([{ route_id: 'R1', route_short_name: '1' } as never]);
}
beforeEach(reset);

// A trip whose FIRST stop has only a departure_time (one-present), a fully-timed
// middle, and a fully-timed last stop. Only the first endpoint is flagged.
function onePresentFirstStop() {
  useStore.getState().setTrips([
    { trip_id: 'T1', route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip,
  ]);
  useStore.getState().setStopTimes([
    { trip_id: 'T1', stop_id: 's1', stop_sequence: 1, arrival_time: '', departure_time: '08:00:00' },
    { trip_id: 'T1', stop_id: 's2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'T1', stop_id: 's3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
  ] as StopTime[]);
}

// A trip whose FIRST stop has NEITHER time (interpolated endpoint) — flagged,
// but there's no value to mirror, so no fix is offered / applied.
function blankBothFirstStop() {
  useStore.getState().setTrips([
    { trip_id: 'T2', route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip,
  ]);
  useStore.getState().setStopTimes([
    { trip_id: 'T2', stop_id: 's1', stop_sequence: 1, arrival_time: '', departure_time: '' },
    { trip_id: 'T2', stop_id: 's2', stop_sequence: 2, arrival_time: '08:05:00', departure_time: '08:05:00' },
    { trip_id: 'T2', stop_id: 's3', stop_sequence: 3, arrival_time: '08:10:00', departure_time: '08:10:00' },
  ] as StopTime[]);
}

const stOf = (tripId: string, seq: number): StopTime =>
  useStore.getState().stopTimes.find((st) => st.trip_id === tripId && st.stop_sequence === seq)!;

describe('fillTripEdgeTimes (store action)', () => {
  it('mirrors the present time into the blank field on a one-present endpoint', () => {
    onePresentFirstStop();
    const snapshot = useStore.getState().fillTripEdgeTimes('T1');

    // The first stop now has BOTH times = the value that was present.
    expect(stOf('T1', 1).arrival_time).toBe('08:00:00');
    expect(stOf('T1', 1).departure_time).toBe('08:00:00');
    // Snapshot captures exactly the row it changed, with its prior values.
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      trip_id: 'T1', stop_sequence: 1, prevArrival: '', prevDeparture: '08:00:00',
    });
    // Interior + already-timed last stop are untouched.
    expect(stOf('T1', 2).arrival_time).toBe('08:05:00');
    expect(stOf('T1', 3).departure_time).toBe('08:10:00');
  });

  it('does NOT touch a both-blank (interpolated) endpoint — no value to mirror', () => {
    blankBothFirstStop();
    const snapshot = useStore.getState().fillTripEdgeTimes('T2');
    expect(snapshot).toHaveLength(0);
    expect(stOf('T2', 1).arrival_time).toBe('');
    expect(stOf('T2', 1).departure_time).toBe('');
  });

  it('restoreTripEdgeTimes reverts the fill to the captured values', () => {
    onePresentFirstStop();
    const snapshot = useStore.getState().fillTripEdgeTimes('T1');
    expect(stOf('T1', 1).arrival_time).toBe('08:00:00');

    useStore.getState().restoreTripEdgeTimes(snapshot);
    expect(stOf('T1', 1).arrival_time).toBe('');        // restored to blank
    expect(stOf('T1', 1).departure_time).toBe('08:00:00'); // restored to original
  });
});

describe('fix registry', () => {
  it('exposes the trip-edge fix with a label + description', () => {
    const fix = getValidationFix('fill-trip-edge-times');
    expect(fix).toBeDefined();
    expect(fix!.label).toBeTruthy();
    expect(fix!.description).toBeTruthy();
  });

  it('applyValidationFix fills the endpoint and returns a working undo', () => {
    onePresentFirstStop();
    const message: ValidationMessage = {
      id: '1', severity: 'error', message: 'x', entity_type: 'trip', entity_id: 'T1',
      fix: { id: 'fill-trip-edge-times' },
    };
    const result = applyValidationFix(message);
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.label).toContain('T1');
    expect(stOf('T1', 1).arrival_time).toBe('08:00:00');

    result!.undo();
    expect(stOf('T1', 1).arrival_time).toBe('');
  });

  it('returns null for a message that carries no fix', () => {
    const message: ValidationMessage = {
      id: '1', severity: 'error', message: 'x', entity_type: 'trip', entity_id: 'T1',
    };
    expect(applyValidationFix(message)).toBeNull();
  });

  it('reports changed=false when there is nothing to fix (re-click is a no-op)', () => {
    onePresentFirstStop();
    useStore.getState().fillTripEdgeTimes('T1'); // already fixed
    const message: ValidationMessage = {
      id: '1', severity: 'error', message: 'x', entity_type: 'trip', entity_id: 'T1',
      fix: { id: 'fill-trip-edge-times' },
    };
    expect(applyValidationFix(message)!.changed).toBe(false);
  });
});

// The trip-edge error messages, identified by their two text variants.
const onePresentMsg = (msgs: ValidationMessage[]) =>
  msgs.find((m) => m.message.includes('missing arrival_time or departure_time'));
const blankBothMsg = (msgs: ValidationMessage[]) =>
  msgs.find((m) => m.message.includes('has no time'));

describe('validation.ts attaches the fix on the correct variant only', () => {
  it('the one-present message carries fix=fill-trip-edge-times', () => {
    onePresentFirstStop();
    const msgs = runValidation(useStore.getState());
    const m = onePresentMsg(msgs);
    expect(m).toBeDefined();
    expect(m!.fix).toEqual({ id: 'fill-trip-edge-times' });
  });

  it('the both-blank (interpolated) message has NO fix', () => {
    blankBothFirstStop();
    const msgs = runValidation(useStore.getState());
    const m = blankBothMsg(msgs);
    expect(m).toBeDefined();
    expect(m!.fix).toBeUndefined();
  });
});

// "Ghost" trip cleanup recipe (Trent Wiesner forum report). A shapeless trip on
// a route that ALSO has a shape is unreachable in the timetable grid; the rule
// flags it with remove-ghost-trips so it can be bulk-deleted with its stop_times.
function ghostTripScenario() {
  const s = useStore.getState();
  // Outbound trip made before any shape existed → empty shape_id.
  s.setTrips([{ trip_id: 'GHOST', route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip]);
  s.setStopTimes([
    { trip_id: 'GHOST', stop_id: 's1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    { trip_id: 'GHOST', stop_id: 's2', stop_sequence: 2, arrival_time: '08:10:00', departure_time: '08:10:00' },
  ] as StopTime[]);
  // Inbound direction later drawn + stopped → the route now has a shape pattern,
  // flipping the grid into shape-filter mode where GHOST matches nothing.
  s.setRouteStops([
    { route_id: 'R1', stop_id: 's3', stop_sequence: 0, direction_id: 1, shape_id: 'in' } as RouteStop,
  ]);
}
const ghostMsg = (msgs: ValidationMessage[]) =>
  msgs.find((m) => m.message.includes("can't be reached in the timetable editor"));

describe('remove-ghost-trips (unreachable timetable trips)', () => {
  it('exposes the fix in the registry with a label + description', () => {
    const fix = getValidationFix('remove-ghost-trips');
    expect(fix).toBeDefined();
    expect(fix!.label).toBeTruthy();
    expect(fix!.description).toBeTruthy();
  });

  it('validation.ts flags the shapeless trip and attaches remove-ghost-trips', () => {
    ghostTripScenario();
    const m = ghostMsg(runValidation(useStore.getState()));
    expect(m).toBeDefined();
    expect(m!.entity_id).toBe('GHOST');
    expect(m!.fix).toEqual({ id: 'remove-ghost-trips' });
  });

  it('does NOT flag trips on a route with no shapes (direction fallback is reachable)', () => {
    const s = useStore.getState();
    s.setTrips([{ trip_id: 'OK', route_id: 'R1', service_id: 'S1', direction_id: 0 } as Trip]);
    s.setStopTimes([
      { trip_id: 'OK', stop_id: 's1', stop_sequence: 1, arrival_time: '08:00:00', departure_time: '08:00:00' },
    ] as StopTime[]);
    s.setRouteStops([]); // no shape anywhere
    expect(ghostMsg(runValidation(useStore.getState()))).toBeUndefined();
  });

  it('applying the fix removes the trip + its stop_times, and undo restores both', () => {
    ghostTripScenario();
    const m = ghostMsg(runValidation(useStore.getState()))!;

    const result = applyValidationFix(m)!;
    expect(result.changed).toBe(true);
    expect(useStore.getState().trips.find((t) => t.trip_id === 'GHOST')).toBeUndefined();
    expect(useStore.getState().stopTimes.filter((st) => st.trip_id === 'GHOST')).toHaveLength(0);
    // Re-validating (panel memo recomputes) clears the resolved warning.
    expect(ghostMsg(runValidation(useStore.getState()))).toBeUndefined();

    result.undo();
    expect(useStore.getState().trips.find((t) => t.trip_id === 'GHOST')).toBeDefined();
    expect(useStore.getState().stopTimes.filter((st) => st.trip_id === 'GHOST')).toHaveLength(2);
  });
});

describe('ValidationPanel Fix button (render predicate + click code path)', () => {
  // The panel renders a Fix button iff `m.fix && getValidationFix(m.fix.id)`,
  // labelled from the registry, and its onClick calls applyValidationFix(m).
  // Mirror that exact predicate + click here (the suite runs in node, no DOM).
  const fixButtonShown = (m: ValidationMessage) => !!(m.fix && getValidationFix(m.fix.id));

  it('shows a labelled Fix button on the flagged one-present message and clicking it applies', () => {
    onePresentFirstStop();
    let msgs = runValidation(useStore.getState());
    const m = onePresentMsg(msgs)!;

    // Button would render with the registry label.
    expect(fixButtonShown(m)).toBe(true);
    expect(getValidationFix(m.fix!.id)!.label).toBe('Fix');

    // Click → apply (the panel's onClick body).
    const result = applyValidationFix(m);
    expect(result?.changed).toBe(true);

    // Re-running validation (panel's memo recomputes on stopTimes change) clears
    // the resolved error.
    msgs = runValidation(useStore.getState());
    expect(onePresentMsg(msgs)).toBeUndefined();
  });

  it('does NOT show a Fix button on the both-blank message', () => {
    blankBothFirstStop();
    const msgs = runValidation(useStore.getState());
    expect(fixButtonShown(blankBothMsg(msgs)!)).toBe(false);
  });
});
