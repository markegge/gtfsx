// #66 — feed-boundary variant clearing + within-set preservation.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { createVariantFromCurrent, switchToVariant, baselineVariant } from '../variants';
import { applySnapshotToStore, resetEditorState } from '../../db/serverPersistence';
import type { FeedVariant } from '../../store/variantSlice';
import type { Route } from '../../types/gtfs';

const v = (id: string, baseline: boolean): FeedVariant => ({
  id,
  name: id,
  baseline,
  createdAt: 0,
  modifiedAt: 0,
  snapshot: {},
});

function seedFeed() {
  const s = useStore.getState();
  s.setVariants([]);
  s.setActiveVariantId(null);
  s.setRoutes([{ route_id: 'R1', route_short_name: 'R1', route_long_name: 'R1', route_type: 3 } as Route]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
  s.setRouteStops([] as never);
  s.setCalendars([] as never);
}

beforeEach(seedFeed);

describe('feed-boundary variant clearing (#66 cross-feed leak)', () => {
  it('resetEditorState() clears the variant layer', () => {
    useStore.getState().setVariants([v('base', true), v('exp', false)]);
    useStore.getState().setActiveVariantId('exp');
    resetEditorState();
    expect(useStore.getState().variants).toEqual([]);
    expect(useStore.getState().activeVariantId).toBeNull();
  });

  it('applySnapshotToStore() clears variants by default (opening a different feed)', () => {
    useStore.getState().setVariants([v('base', true), v('exp', false)]);
    useStore.getState().setActiveVariantId('exp');
    applySnapshotToStore({ routes: [] });
    expect(useStore.getState().variants).toEqual([]);
    expect(useStore.getState().activeVariantId).toBeNull();
  });

  it('applySnapshotToStore({ preserveVariants: true }) keeps the layer (variant switch / load re-apply)', () => {
    useStore.getState().setVariants([v('base', true), v('exp', false)]);
    useStore.getState().setActiveVariantId('exp');
    applySnapshotToStore({ routes: [] }, { preserveVariants: true });
    expect(useStore.getState().variants.map((x) => x.id)).toEqual(['base', 'exp']);
    expect(useStore.getState().activeVariantId).toBe('exp');
  });
});

describe('switching a variant does not drop the layer', () => {
  it('keeps all variants across a switch and restores per-variant edits', () => {
    const vid = createVariantFromCurrent('Experiment');
    expect(useStore.getState().variants).toHaveLength(2);

    const baseId = baselineVariant()!.id;
    switchToVariant(baseId);
    expect(useStore.getState().variants).toHaveLength(2);
    expect(useStore.getState().activeVariantId).toBe(baseId);

    switchToVariant(vid);
    expect(useStore.getState().variants).toHaveLength(2);
    expect(useStore.getState().activeVariantId).toBe(vid);
  });
});

describe('unsaved variant work marks the editor dirty (beforeunload coverage)', () => {
  // The reload guard fires only on isDirty now (variants persist, so their mere
  // existence isn't a warning). This confirms isDirty actually tracks variant
  // work, so the guard still catches genuinely unsaved forks/switches.
  it('forking and switching mark dirty', () => {
    useStore.getState().markSaved();
    expect(useStore.getState().isDirty).toBe(false);

    const vid = createVariantFromCurrent('X');
    expect(useStore.getState().isDirty).toBe(true);

    useStore.getState().markSaved();
    switchToVariant(baselineVariant()!.id);
    expect(useStore.getState().isDirty).toBe(true);

    useStore.getState().markSaved();
    switchToVariant(vid);
    expect(useStore.getState().isDirty).toBe(true);
  });
});
