import type { StateCreator } from 'zustand';
import type { WalkshedProfileResult } from '../services/walkshedProfile';

/**
 * Walkshed demographic PROFILE state (services/walkshedProfile.ts).
 *
 * Deliberately separate from `coverageSlice`: that slice holds the block-GROUP
 * coverage estimate (tract-centroid discs), this one holds the exact
 * census-block profile. They are different methodologies and must never be
 * silently mixed, so they never share a field.
 *
 * The result is computed once for the WHOLE feed (one range read of the block
 * layer over the feed bbox) and read by both the stop sub-panel and the route
 * sub-panel — no per-stop fetching.
 */
export interface WalkshedProfileSlice {
  walkshedProfiles: WalkshedProfileResult | null;
  isProfilingWalksheds: boolean;
  walkshedProfileError: string | null;
  setWalkshedProfiles: (r: WalkshedProfileResult | null) => void;
  setIsProfilingWalksheds: (v: boolean) => void;
  setWalkshedProfileError: (err: string | null) => void;
}

export const createWalkshedProfileSlice: StateCreator<
  WalkshedProfileSlice,
  [['zustand/immer', never]],
  [],
  WalkshedProfileSlice
> = (set) => ({
  walkshedProfiles: null,
  isProfilingWalksheds: false,
  walkshedProfileError: null,
  setWalkshedProfiles: (r) =>
    set((s) => {
      s.walkshedProfiles = r;
    }),
  setIsProfilingWalksheds: (v) =>
    set((s) => {
      s.isProfilingWalksheds = v;
    }),
  setWalkshedProfileError: (err) =>
    set((s) => {
      s.walkshedProfileError = err;
    }),
});
