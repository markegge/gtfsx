import type { StateCreator } from 'zustand';
import type { Stop } from '../types/gtfs';
import type { TripSlice } from './tripSlice';
import type { RouteSlice } from './routeSlice';

export interface StopSlice {
  stops: Stop[];
  addStop: (stop: Stop) => void;
  updateStop: (stop_id: string, updates: Partial<Stop>) => void;
  removeStop: (stop_id: string) => void;
  setStops: (stops: Stop[]) => void;
}

export const createStopSlice: StateCreator<StopSlice, [['zustand/immer', never]], [], StopSlice> = (set, get) => ({
  stops: [],
  addStop: (stop) => set((state) => { state.stops.push(stop); }),
  updateStop: (stop_id, updates) => set((state) => {
    const idx = state.stops.findIndex((s) => s.stop_id === stop_id);
    if (idx !== -1) Object.assign(state.stops[idx], updates);
  }),
  removeStop: (stop_id) => set((state) => {
    state.stops = state.stops.filter((s) => s.stop_id !== stop_id);

    // Cascade: remove stop_times referencing this stop
    const fullState = get() as unknown as StopSlice & TripSlice & RouteSlice;
    (state as any).stopTimes = fullState.stopTimes.filter((st) => st.stop_id !== stop_id);

    // Remove route-stop associations
    (state as any).routeStops = fullState.routeStops.filter((rs) => rs.stop_id !== stop_id);

    // Remove transfers referencing this stop on either side
    if ((state as any).transfers) {
      (state as any).transfers = (state as any).transfers.filter(
        (t: { from_stop_id: string; to_stop_id: string }) =>
          t.from_stop_id !== stop_id && t.to_stop_id !== stop_id,
      );
    }
  }),
  setStops: (stops) => set((state) => { state.stops = stops; }),
});
