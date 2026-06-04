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
 * GTFS-Fares v2 store. Holds parsed entities so they round-trip through
 * import/export, plus authoring CRUD for the editors that have shipped.
 *
 * Authoring status (see docs/REQUIREMENTS.md §1.6.2):
 *   • areas.txt + stop_areas.txt — Areas editor (Phase 2, shipped).
 *   • everything else — round-trip only; setters used by the import pipeline.
 *     Add CRUD here as each subsequent editor lands (networks, rider
 *     categories, fare media/products, timeframes, leg/transfer rules).
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

  // ── Areas authoring (areas.txt + stop_areas.txt) ──────────────────────────
  /** Create an area. No-op if area_id already exists (area_id is unique). */
  addFareArea: (area: FareArea) => void;
  /** Update area_name (and any other fields) for an existing area. */
  updateFareArea: (areaId: string, updates: Partial<Omit<FareArea, 'area_id'>>) => void;
  /** Rename an area_id, cascading the change to its stop_areas mappings.
   *  No-op on collision (newId already in use) — merging areas is never silent. */
  renameFareAreaId: (oldId: string, newId: string) => void;
  /** Delete an area and every stop_areas mapping that references it. */
  removeFareArea: (areaId: string) => void;
  /** Assign a stop to an area. No-op if the (area_id, stop_id) pair exists. */
  addStopToArea: (areaId: string, stopId: string) => void;
  /** Remove a stop from an area. */
  removeStopFromArea: (areaId: string, stopId: string) => void;
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

  addFareArea: (area) => set((state) => {
    if (state.fareAreas.some((a) => a.area_id === area.area_id)) return;
    state.fareAreas.push(area);
  }),
  updateFareArea: (areaId, updates) => set((state) => {
    const area = state.fareAreas.find((a) => a.area_id === areaId);
    if (area) Object.assign(area, updates);
  }),
  renameFareAreaId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    if (state.fareAreas.some((a) => a.area_id === newId)) return;
    const area = state.fareAreas.find((a) => a.area_id === oldId);
    if (!area) return;
    area.area_id = newId;
    for (const sa of state.stopAreas) {
      if (sa.area_id === oldId) sa.area_id = newId;
    }
  }),
  removeFareArea: (areaId) => set((state) => {
    state.fareAreas = state.fareAreas.filter((a) => a.area_id !== areaId);
    state.stopAreas = state.stopAreas.filter((sa) => sa.area_id !== areaId);
  }),
  addStopToArea: (areaId, stopId) => set((state) => {
    if (state.stopAreas.some((sa) => sa.area_id === areaId && sa.stop_id === stopId)) return;
    state.stopAreas.push({ area_id: areaId, stop_id: stopId });
  }),
  removeStopFromArea: (areaId, stopId) => set((state) => {
    state.stopAreas = state.stopAreas.filter(
      (sa) => !(sa.area_id === areaId && sa.stop_id === stopId),
    );
  }),
});
