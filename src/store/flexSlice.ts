import type { StateCreator } from 'zustand';

export interface FlexZone {
  id: string;
  name: string;
  bufferMiles: number;
  /** GeoJSON FeatureCollection of Polygon features making up the service area. */
  geojson: GeoJSON.FeatureCollection;
}

export interface FlexSlice {
  flexZones: FlexZone[];
  addFlexZone: (zone: FlexZone) => void;
  updateFlexZone: (id: string, updates: Partial<FlexZone>) => void;
  removeFlexZone: (id: string) => void;
  setFlexZones: (zones: FlexZone[]) => void;
}

export const createFlexSlice: StateCreator<FlexSlice, [['zustand/immer', never]], [], FlexSlice> = (set) => ({
  flexZones: [],
  addFlexZone: (zone) => set((state) => { state.flexZones.push(zone); }),
  updateFlexZone: (id, updates) => set((state) => {
    const idx = state.flexZones.findIndex((z) => z.id === id);
    if (idx !== -1) Object.assign(state.flexZones[idx], updates);
  }),
  removeFlexZone: (id) => set((state) => {
    state.flexZones = state.flexZones.filter((z) => z.id !== id);
  }),
  setFlexZones: (zones) => set((state) => { state.flexZones = zones; }),
});
