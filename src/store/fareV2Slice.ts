import type { StateCreator } from 'zustand';
import type {
  FareArea,
  StopArea,
  FareNetwork,
  RouteNetwork,
  Timeframe,
  RiderCategory,
  FareMedia,
  FareProduct,
  FareLegRule,
  FareTransferRule,
} from '../types/gtfs';

/**
 * GTFS-Fares v2 — Phase 1 store: holds parsed entities so they round-trip
 * through import/export. There is no authoring UI yet (Phase 2); these
 * setters are used by the import pipeline and may be used by future editors.
 */
export interface FareV2Slice {
  fareAreas: FareArea[];
  stopAreas: StopArea[];
  fareNetworks: FareNetwork[];
  routeNetworks: RouteNetwork[];
  timeframes: Timeframe[];
  riderCategories: RiderCategory[];
  fareMedia: FareMedia[];
  fareProducts: FareProduct[];
  fareLegRules: FareLegRule[];
  fareTransferRules: FareTransferRule[];

  setFareAreas: (rows: FareArea[]) => void;
  setStopAreas: (rows: StopArea[]) => void;
  setFareNetworks: (rows: FareNetwork[]) => void;
  setRouteNetworks: (rows: RouteNetwork[]) => void;
  setTimeframes: (rows: Timeframe[]) => void;
  setRiderCategories: (rows: RiderCategory[]) => void;
  setFareMedia: (rows: FareMedia[]) => void;
  setFareProducts: (rows: FareProduct[]) => void;
  setFareLegRules: (rows: FareLegRule[]) => void;
  setFareTransferRules: (rows: FareTransferRule[]) => void;
}

export const createFareV2Slice: StateCreator<FareV2Slice, [['zustand/immer', never]], [], FareV2Slice> = (set) => ({
  fareAreas: [],
  stopAreas: [],
  fareNetworks: [],
  routeNetworks: [],
  timeframes: [],
  riderCategories: [],
  fareMedia: [],
  fareProducts: [],
  fareLegRules: [],
  fareTransferRules: [],

  setFareAreas: (rows) => set((state) => { state.fareAreas = rows; }),
  setStopAreas: (rows) => set((state) => { state.stopAreas = rows; }),
  setFareNetworks: (rows) => set((state) => { state.fareNetworks = rows; }),
  setRouteNetworks: (rows) => set((state) => { state.routeNetworks = rows; }),
  setTimeframes: (rows) => set((state) => { state.timeframes = rows; }),
  setRiderCategories: (rows) => set((state) => { state.riderCategories = rows; }),
  setFareMedia: (rows) => set((state) => { state.fareMedia = rows; }),
  setFareProducts: (rows) => set((state) => { state.fareProducts = rows; }),
  setFareLegRules: (rows) => set((state) => { state.fareLegRules = rows; }),
  setFareTransferRules: (rows) => set((state) => { state.fareTransferRules = rows; }),
});
