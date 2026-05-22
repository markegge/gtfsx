import type { StateCreator } from 'zustand';
import type { FareAttribute, FareRule } from '../types/gtfs';

export interface FareSlice {
  fareAttributes: FareAttribute[];
  fareRules: FareRule[];
  addFareAttribute: (fare: FareAttribute) => void;
  updateFareAttribute: (fare_id: string, updates: Partial<FareAttribute>) => void;
  /** Rename a fare_id and cascade the change to any referencing fare_rules. */
  renameFareId: (oldId: string, newId: string) => void;
  removeFareAttribute: (fare_id: string) => void;
  /** Clone a fare attribute (and its fare_rules) under a new unique fare_id.
   * Returns the new fare_id, or null if the source doesn't exist. */
  duplicateFareAttribute: (fare_id: string) => string | null;
  setFareAttributes: (fares: FareAttribute[]) => void;
  addFareRule: (rule: FareRule) => void;
  updateFareRule: (index: number, updates: Partial<FareRule>) => void;
  removeFareRule: (fare_id: string, route_id?: string) => void;
  /** Remove a fare rule by its index in the array. Used by editors that
   *  manipulate origin/destination rules where (fare_id, route_id) isn't a
   *  unique key. */
  removeFareRuleAt: (index: number) => void;
  setFareRules: (rules: FareRule[]) => void;
}

export const createFareSlice: StateCreator<FareSlice, [['zustand/immer', never]], [], FareSlice> = (set, get) => ({
  fareAttributes: [],
  fareRules: [],
  addFareAttribute: (fare) => set((state) => { state.fareAttributes.push(fare); }),
  duplicateFareAttribute: (fare_id) => {
    const s0 = get();
    const orig = s0.fareAttributes.find((f) => f.fare_id === fare_id);
    if (!orig) return null;
    const existing = new Set(s0.fareAttributes.map((f) => f.fare_id));
    let newId = `${fare_id}_copy`;
    let n = 2;
    while (existing.has(newId)) newId = `${fare_id}_copy${n++}`;
    const ruleCopies = s0.fareRules
      .filter((r) => r.fare_id === fare_id)
      .map((r) => ({ ...r, fare_id: newId }));
    set((state) => {
      state.fareAttributes.push({ ...orig, fare_id: newId });
      state.fareRules.push(...ruleCopies);
    });
    return newId;
  },
  updateFareAttribute: (fare_id, updates) => set((state) => {
    const idx = state.fareAttributes.findIndex((f) => f.fare_id === fare_id);
    if (idx !== -1) Object.assign(state.fareAttributes[idx], updates);
  }),
  renameFareId: (oldId, newId) => set((state) => {
    if (oldId === newId) return;
    const idx = state.fareAttributes.findIndex((f) => f.fare_id === oldId);
    if (idx === -1) return;
    if (state.fareAttributes.some((f) => f.fare_id === newId)) return; // refuse collision
    state.fareAttributes[idx].fare_id = newId;
    for (const r of state.fareRules) {
      if (r.fare_id === oldId) r.fare_id = newId;
    }
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
  removeFareRuleAt: (index) => set((state) => {
    if (index >= 0 && index < state.fareRules.length) {
      state.fareRules.splice(index, 1);
    }
  }),
  setFareRules: (rules) => set((state) => { state.fareRules = rules; }),
});
