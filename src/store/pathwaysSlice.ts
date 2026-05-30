import type { StateCreator } from 'zustand';
import type { Pathway } from '../types/gtfs';

export interface PathwaysSlice {
  pathways: Pathway[];
  addPathway: (pathway: Pathway) => void;
  updatePathway: (index: number, updates: Partial<Pathway>) => void;
  removePathway: (index: number) => void;
  setPathways: (pathways: Pathway[]) => void;
}

export const createPathwaysSlice: StateCreator<PathwaysSlice, [['zustand/immer', never]], [], PathwaysSlice> = (set) => ({
  pathways: [],
  addPathway: (pathway) => set((state) => { state.pathways.push(pathway); }),
  updatePathway: (index, updates) => set((state) => {
    if (index >= 0 && index < state.pathways.length) {
      Object.assign(state.pathways[index], updates);
    }
  }),
  removePathway: (index) => set((state) => {
    if (index >= 0 && index < state.pathways.length) {
      state.pathways.splice(index, 1);
    }
  }),
  setPathways: (pathways) => set((state) => { state.pathways = pathways; }),
});
