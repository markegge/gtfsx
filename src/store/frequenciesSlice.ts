import type { StateCreator } from 'zustand';
import type { Frequency } from '../types/gtfs';

export interface FrequenciesSlice {
  frequencies: Frequency[];
  addFrequency: (frequency: Frequency) => void;
  updateFrequency: (index: number, updates: Partial<Frequency>) => void;
  removeFrequency: (index: number) => void;
  setFrequencies: (frequencies: Frequency[]) => void;
}

export const createFrequenciesSlice: StateCreator<FrequenciesSlice, [['zustand/immer', never]], [], FrequenciesSlice> = (set) => ({
  frequencies: [],
  addFrequency: (frequency) => set((state) => { state.frequencies.push(frequency); }),
  updateFrequency: (index, updates) => set((state) => {
    if (index >= 0 && index < state.frequencies.length) {
      Object.assign(state.frequencies[index], updates);
    }
  }),
  removeFrequency: (index) => set((state) => {
    if (index >= 0 && index < state.frequencies.length) {
      state.frequencies.splice(index, 1);
    }
  }),
  setFrequencies: (frequencies) => set((state) => { state.frequencies = frequencies; }),
});
