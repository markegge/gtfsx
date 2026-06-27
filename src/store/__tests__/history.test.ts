// Undo / redo edit history (GitHub #49). Exercises the patch-based history
// module against the real store: round-trip undo/redo, redo-stack clearing,
// coalescing of rapid same-target edits, the bounded depth cap, the feed-switch
// reset, and the ephemeral-UI exclusion.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import {
  undo, redo, resetHistory, historyDepths, loadingFeed,
  useHistoryUi, HISTORY_LIMIT,
} from '../history';
import type { Stop } from '../../types/gtfs';

function stop(id: string, lat = 45, lon = -111): Stop {
  return {
    stop_id: id, stop_name: id, stop_lat: lat, stop_lon: lon,
    location_type: 0, wheelchair_boarding: 0,
  };
}

const s = () => useStore.getState();
const ids = () => s().stops.map((x) => x.stop_id);

beforeEach(() => {
  // Clear the entities we touch, then wipe history so each test starts clean
  // (the clear itself records, so resetHistory must come after).
  useStore.getState().setStops([]);
  useStore.getState().setRoutes([]);
  useStore.getState().setTrips([]);
  resetHistory();
});

describe('undo/redo history', () => {
  it('undoes and redoes a representative mutation (add stop)', () => {
    expect(s().stops.length).toBe(0);
    s().addStop(stop('a'));
    expect(ids()).toEqual(['a']);
    expect(historyDepths().undo).toBe(1);

    undo();
    expect(s().stops.length).toBe(0);
    expect(historyDepths()).toEqual({ undo: 0, redo: 1 });

    redo();
    expect(ids()).toEqual(['a']);
    expect(historyDepths()).toEqual({ undo: 1, redo: 0 });
  });

  it('undo restores a field edit', () => {
    s().setStops([stop('a', 45, -111)]);
    resetHistory();
    s().updateStop('a', { stop_name: 'Renamed' });
    expect(s().stops[0].stop_name).toBe('Renamed');
    undo();
    expect(s().stops[0].stop_name).toBe('a');
  });

  it('a new edit clears the redo stack', () => {
    s().addStop(stop('a'));
    undo();
    expect(historyDepths().redo).toBe(1);

    s().addStop(stop('b')); // diverging edit invalidates the redo branch
    expect(historyDepths().redo).toBe(0);
    expect(ids()).toEqual(['b']);
    expect(redo()).toBeNull(); // nothing to redo
    expect(ids()).toEqual(['b']);
  });

  it('coalesces rapid same-target edits into one undo step', () => {
    s().setStops([stop('a', 45, -111)]);
    resetHistory();

    // A stop drag: many position writes to the same stop in quick succession.
    s().updateStop('a', { stop_lat: 45.1 });
    s().updateStop('a', { stop_lat: 45.2 });
    s().updateStop('a', { stop_lat: 45.3 });
    expect(historyDepths().undo).toBe(1); // merged into one step
    expect(s().stops[0].stop_lat).toBeCloseTo(45.3);

    undo(); // one undo reverts the whole gesture
    expect(s().stops[0].stop_lat).toBe(45);
    expect(historyDepths().undo).toBe(0);
  });

  it('does not coalesce edits to different entities', () => {
    s().setStops([stop('a'), stop('b')]);
    resetHistory();
    s().updateStop('a', { stop_name: 'A2' });
    s().updateStop('b', { stop_name: 'B2' });
    expect(historyDepths().undo).toBe(2);
  });

  it('does not coalesce discrete add operations', () => {
    s().addStop(stop('a'));
    s().addStop(stop('b'));
    expect(historyDepths().undo).toBe(2);
  });

  it('labels a coordinate-only change "move stop"', () => {
    s().setStops([stop('a', 45, -111)]);
    resetHistory();
    s().updateStop('a', { stop_lat: 46, stop_lon: -110 });
    expect(useHistoryUi.getState().undoLabel).toBe('move stop');
  });

  it('caps history depth at HISTORY_LIMIT, dropping the oldest steps', () => {
    const extra = 10;
    for (let i = 0; i < HISTORY_LIMIT + extra; i++) s().addStop(stop(`s${i}`));
    expect(historyDepths().undo).toBe(HISTORY_LIMIT);

    // Undoing the whole (capped) stack leaves the `extra` earliest stops, whose
    // add-steps were dropped and are no longer reversible.
    for (let i = 0; i < HISTORY_LIMIT; i++) undo();
    expect(historyDepths().undo).toBe(0);
    expect(undo()).toBeNull();
    expect(s().stops.length).toBe(extra);
    expect(ids()).toEqual(Array.from({ length: extra }, (_, i) => `s${i}`));
  });

  it('loading a feed resets history (no cross-feed undo)', () => {
    s().addStop(stop('a'));
    expect(historyDepths().undo).toBe(1);

    // The import / snapshot-load paths run their bulk apply through loadingFeed.
    loadingFeed(() => { s().setStops([stop('x'), stop('y')]); });

    expect(historyDepths()).toEqual({ undo: 0, redo: 0 });
    expect(undo()).toBeNull();            // can't reach across the boundary
    expect(ids()).toEqual(['x', 'y']);    // the load itself wasn't recorded
  });

  it('never records ephemeral UI state', () => {
    s().selectRoute('r1');
    s().setMapMode('place_stop');
    s().setSidebarSection('stops');
    s().setRightRailOpen(true);
    s().setBottomPanelTab('validation');
    expect(historyDepths().undo).toBe(0);
    expect(useHistoryUi.getState().canUndo).toBe(false);
  });

  it('keeps the reactive UI store in sync', () => {
    expect(useHistoryUi.getState().canUndo).toBe(false);
    s().addStop(stop('a'));
    expect(useHistoryUi.getState().canUndo).toBe(true);
    expect(useHistoryUi.getState().undoLabel).toBe('edit stop');

    undo();
    expect(useHistoryUi.getState().canUndo).toBe(false);
    expect(useHistoryUi.getState().canRedo).toBe(true);
    expect(useHistoryUi.getState().toast?.text).toBe('Undo: edit stop');
  });

  it('undo/redo are no-ops on empty stacks', () => {
    expect(undo()).toBeNull();
    expect(redo()).toBeNull();
  });
});
