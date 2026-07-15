import type { StateCreator } from 'zustand';
import type { WalkMinutes } from '../services/networkWalkshed';
import type { AccessIsochroneResult, LngLat } from '../services/accessIsochrone/types';

/** UI-controlled parameters for the access-isochrone analysis (origin is held
 *  separately so a map click can set it without touching the rest). */
export interface AccessParamsState {
  /** Ascending minutes thresholds — one contour ring each. */
  budgetsMin: number[];
  /** Departure clock time, seconds since midnight. */
  departureSec: number;
  /** Walk-time budget for the access + egress legs. */
  walkMinutes: WalkMinutes;
  /** Chosen calendar service_id, or null = the feed's busiest representative day. */
  serviceId: string | null;
}

export const DEFAULT_ACCESS_PARAMS: AccessParamsState = {
  budgetsMin: [15, 30, 45],
  departureSec: 8 * 3600, // 08:00
  walkMinutes: 10,
  serviceId: null,
};

export interface AccessIsochroneSlice {
  /** Origin pin (null until placed). */
  accessOrigin: LngLat | null;
  accessParams: AccessParamsState;
  accessResult: AccessIsochroneResult | null;
  accessRunning: boolean;
  accessError: string | null;
  setAccessOrigin: (origin: LngLat | null) => void;
  setAccessParams: (patch: Partial<AccessParamsState>) => void;
  setAccessResult: (result: AccessIsochroneResult | null) => void;
  setAccessRunning: (v: boolean) => void;
  setAccessError: (err: string | null) => void;
  /** Reset the whole analysis (pin, result, error) — leaves params as-is. */
  clearAccessIsochrone: () => void;
}

export const createAccessIsochroneSlice: StateCreator<
  AccessIsochroneSlice,
  [['zustand/immer', never]],
  [],
  AccessIsochroneSlice
> = (set) => ({
  accessOrigin: null,
  accessParams: DEFAULT_ACCESS_PARAMS,
  accessResult: null,
  accessRunning: false,
  accessError: null,
  setAccessOrigin: (origin) => set((s) => { s.accessOrigin = origin; }),
  setAccessParams: (patch) => set((s) => { Object.assign(s.accessParams, patch); }),
  setAccessResult: (result) => set((s) => { s.accessResult = result; }),
  setAccessRunning: (v) => set((s) => { s.accessRunning = v; }),
  setAccessError: (err) => set((s) => { s.accessError = err; }),
  clearAccessIsochrone: () => set((s) => {
    s.accessOrigin = null;
    s.accessResult = null;
    s.accessError = null;
    s.accessRunning = false;
  }),
});
