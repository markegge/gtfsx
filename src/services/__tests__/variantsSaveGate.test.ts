// #66 stopgap — Save gate decision logic + feed-boundary variant clearing.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import {
  nonBaselineVariantActive,
  createVariantFromCurrent,
  switchToVariant,
  baselineVariant,
} from '../variants';
import { applySnapshotToStore, resetEditorState } from '../../db/serverPersistence';
import type { FeedVariant } from '../../store/variantSlice';
import type { Route } from '../../types/gtfs';

const v = (id: string, baseline: boolean): FeedVariant => ({
  id,
  name: id,
  baseline,
  createdAt: 0,
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

describe('nonBaselineVariantActive (Save gate decision)', () => {
  it('is false when there are no variants / none active', () => {
    expect(nonBaselineVariantActive([], null)).toBe(false);
  });

  it('is false when the active variant is the baseline', () => {
    const variants = [v('base', true), v('exp', false)];
    expect(nonBaselineVariantActive(variants, 'base')).toBe(false);
  });

  it('is true when a non-baseline variant is active', () => {
    const variants = [v('base', true), v('exp', false)];
    expect(nonBaselineVariantActive(variants, 'exp')).toBe(true);
  });

  it('is false when activeVariantId does not resolve to any variant', () => {
    const variants = [v('base', true)];
    expect(nonBaselineVariantActive(variants, 'ghost')).toBe(false);
  });
});

describe('feed-boundary variant clearing (#66 leak)', () => {
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

  it('applySnapshotToStore({ preserveVariants: true }) keeps the layer (variant switch)', () => {
    const layer = [v('base', true), v('exp', false)];
    useStore.getState().setVariants(layer);
    useStore.getState().setActiveVariantId('exp');
    applySnapshotToStore({ routes: [] }, { preserveVariants: true });
    expect(useStore.getState().variants.map((x) => x.id)).toEqual(['base', 'exp']);
    expect(useStore.getState().activeVariantId).toBe('exp');
  });
});

describe('switching a variant does not drop the layer (regression for the reset clear)', () => {
  it('keeps all variants across a switch and restores per-variant edits', () => {
    const vid = createVariantFromCurrent('Experiment');
    // Two variants now exist: Baseline + Experiment (active).
    expect(useStore.getState().variants).toHaveLength(2);

    const baseId = baselineVariant()!.id;
    switchToVariant(baseId);
    // The layer survives the feed reset inside applySnapshotToStore.
    expect(useStore.getState().variants).toHaveLength(2);
    expect(useStore.getState().activeVariantId).toBe(baseId);

    switchToVariant(vid);
    expect(useStore.getState().variants).toHaveLength(2);
    expect(useStore.getState().activeVariantId).toBe(vid);
  });
});
