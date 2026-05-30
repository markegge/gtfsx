import type { StateCreator } from 'zustand';
import type { Level } from '../types/gtfs';

export interface LevelsSlice {
  levels: Level[];
  addLevel: (level: Level) => void;
  updateLevel: (index: number, updates: Partial<Level>) => void;
  removeLevel: (index: number) => void;
  setLevels: (levels: Level[]) => void;
}

export const createLevelsSlice: StateCreator<LevelsSlice, [['zustand/immer', never]], [], LevelsSlice> = (set) => ({
  levels: [],
  addLevel: (level) => set((state) => { state.levels.push(level); }),
  updateLevel: (index, updates) => set((state) => {
    if (index >= 0 && index < state.levels.length) {
      Object.assign(state.levels[index], updates);
    }
  }),
  removeLevel: (index) => set((state) => {
    if (index >= 0 && index < state.levels.length) {
      state.levels.splice(index, 1);
    }
  }),
  setLevels: (levels) => set((state) => { state.levels = levels; }),
});
