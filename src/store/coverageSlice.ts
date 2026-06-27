import type { StateCreator } from 'zustand';
import type { BlockGroupData } from '../services/demographics';
import type { CoverageResult } from '../services/coverageAnalysis';
import type { BlockCoverageResult } from '../services/blockCoverage';

export interface CoverageData {
  blockGroups: BlockGroupData[];
  systemResult: CoverageResult;
  routeResults: { routeId: string; result: CoverageResult }[];
  bufferGeoJSON: GeoJSON.FeatureCollection;
  /** EXACT census-block-level system tabulation, present only for block-level
   *  POC regions (Montana). When set, the System Summary + demographic profile
   *  + per-route breakdown + CSV all render from the exact block counts (with a
   *  jobs count) instead of the block-group estimate. */
  blockResult?: BlockCoverageResult;
  /** Per-route EXACT census-block tabulation, parallel to `routeResults` but
   *  block-level. Present only alongside `blockResult` (block-level regions). */
  routeBlockResults?: { routeId: string; result: BlockCoverageResult }[];
  /** Walkshed geometry used: straight-line buffer (default) or, for paid users,
   *  a Mapbox street-network isochrone. In network mode `auto` true means each
   *  stop's walk-time was chosen by its service frequency (10 min when frequent,
   *  else 5 min) and `minutes` is null; otherwise `minutes` is the fixed
   *  walk-time applied to every stop. */
  walkshed?:
    | { mode: 'buffer' }
    | { mode: 'network'; auto: boolean; minutes: number | null };
}

export interface CoverageSlice {
  coverageData: CoverageData | null;
  isFetchingCoverage: boolean;
  coverageError: string | null;
  setCoverageData: (data: CoverageData | null) => void;
  setIsFetchingCoverage: (v: boolean) => void;
  setCoverageError: (err: string | null) => void;
}

export const createCoverageSlice: StateCreator<
  CoverageSlice,
  [['zustand/immer', never]],
  [],
  CoverageSlice
> = (set) => ({
  coverageData: null,
  isFetchingCoverage: false,
  coverageError: null,
  setCoverageData: (data) =>
    set((state) => {
      state.coverageData = data;
    }),
  setIsFetchingCoverage: (v) =>
    set((state) => {
      state.isFetchingCoverage = v;
    }),
  setCoverageError: (err) =>
    set((state) => {
      state.coverageError = err;
    }),
});
