import type { StateCreator } from 'zustand';
import type { BlockGroupData } from '../services/demographics';
import type { CoverageResult } from '../services/coverageAnalysis';

export interface CoverageData {
  blockGroups: BlockGroupData[];
  systemResult: CoverageResult;
  routeResults: { routeId: string; result: CoverageResult }[];
  bufferGeoJSON: GeoJSON.FeatureCollection;
  /** Walkshed geometry used: straight-line buffer (default) or, for paid users,
   *  a Mapbox street-network isochrone with the chosen walk-time in minutes. */
  walkshed?: { mode: 'buffer' } | { mode: 'network'; minutes: number };
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
