import type { StateCreator } from 'zustand';
import type { FareAttribute, FareRule } from '../types/gtfs';

export interface FareSlice {
  fareAttributes: FareAttribute[];
  fareRules: FareRule[];
  addFareAttribute: (fare: FareAttribute) => void;
  updateFareAttribute: (fare_id: string, updates: Partial<FareAttribute>) => void;
  removeFareAttribute: (fare_id: string) => void;
  setFareAttributes: (fares: FareAttribute[]) => void;
  addFareRule: (rule: FareRule) => void;
  updateFareRule: (index: number, updates: Partial<FareRule>) => void;
  removeFareRule: (fare_id: string, route_id?: string) => void;
  setFareRules: (rules: FareRule[]) => void;
}

export const createFareSlice: StateCreator<FareSlice, [['zustand/immer', never]], [], FareSlice> = (set) => ({
  fareAttributes: [],
  fareRules: [],
  addFareAttribute: (fare) => set((state) => { state.fareAttributes.push(fare); }),
  updateFareAttribute: (fare_id, updates) => set((state) => {
    const idx = state.fareAttributes.findIndex((f) => f.fare_id === fare_id);
    if (idx !== -1) Object.assign(state.fareAttributes[idx], updates);
  }),
  removeFareAttribute: (fare_id) => set((state) => {
    state.fareAttributes = state.fareAttributes.filter((f) => f.fare_id !== fare_id);
    state.fareRules = state.fareRules.filter((r) => r.fare_id !== fare_id);
  }),
  setFareAttributes: (fares) => set((state) => { state.fareAttributes = fares; }),
  addFareRule: (rule) => set((state) => { state.fareRules.push(rule); }),
  updateFareRule: (index, updates) => set((state) => {
    if (index >= 0 && index < state.fareRules.length) {
      Object.assign(state.fareRules[index], updates);
    }
  }),
  removeFareRule: (fare_id, route_id) => set((state) => {
    state.fareRules = state.fareRules.filter(
      (r) => !(r.fare_id === fare_id && r.route_id === route_id)
    );
  }),
  setFareRules: (rules) => set((state) => { state.fareRules = rules; }),
});
