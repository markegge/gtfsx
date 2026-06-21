import type { StateCreator } from 'zustand';
import type { Stop, Transfer } from '../types/gtfs';
import type { TripSlice } from './tripSlice';
import type { RouteSlice } from './routeSlice';
import { generateId } from '../services/idGenerator';

/** One stop's prior wheelchair_boarding, captured by a bulk fill so it can be
 *  undone. */
export interface WheelchairFill {
  stop_id: string;
  prev: number;
}

export interface StopSlice {
  stops: Stop[];
  addStop: (stop: Stop) => void;
  updateStop: (stop_id: string, updates: Partial<Stop>) => void;
  removeStop: (stop_id: string) => void;
  /** Clone a stop as a new standalone stop (no route/time associations),
   * nudged slightly so it doesn't sit exactly under the original. Returns the
   * new stop_id, or null if the source doesn't exist. */
  duplicateStop: (stop_id: string) => string | null;
  /** Bulk-fill wheelchair_boarding = `value` on the given stops, but ONLY where
   *  the stop has no accessible/not-accessible value yet — anything other than
   *  1 or 2 (0 / undefined = "no information" = a gap per the GTFS spec) is
   *  treated as missing. Never overwrites a stop that already has 1 or 2.
   *  Returns the prior values of the stops it changed, so the caller can offer
   *  an undo. */
  fillMissingWheelchairBoarding: (stopIds: string[], value: number) => WheelchairFill[];
  /** Revert a fillMissingWheelchairBoarding using its returned snapshot
   *  (unconditional set — restores exactly what those stops had before). */
  restoreWheelchairBoarding: (entries: WheelchairFill[]) => void;
  setStops: (stops: Stop[]) => void;
}

// removeStop cascades into other slices (stop_times, route_stops, transfers);
// widen the state view to cover those fields without resorting to `any`.
type CrossSliceState = StopSlice & TripSlice & RouteSlice & { transfers?: Transfer[] };

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
    const fullState = get() as unknown as CrossSliceState;
    (state as CrossSliceState).stopTimes = fullState.stopTimes.filter((st) => st.stop_id !== stop_id);

    // Remove route-stop associations
    (state as CrossSliceState).routeStops = fullState.routeStops.filter((rs) => rs.stop_id !== stop_id);

    // Remove transfers referencing this stop on either side
    const cross = state as CrossSliceState;
    if (cross.transfers) {
      cross.transfers = cross.transfers.filter(
        (t) => t.from_stop_id !== stop_id && t.to_stop_id !== stop_id,
      );
    }
  }),
  duplicateStop: (stop_id) => {
    const orig = get().stops.find((s) => s.stop_id === stop_id);
    if (!orig) return null;
    const newId = generateId('stop');
    set((state) => {
      state.stops.push({
        ...orig,
        stop_id: newId,
        stop_code: undefined,
        stop_name: orig.stop_name ? `${orig.stop_name} (copy)` : orig.stop_name,
        stop_lat: orig.stop_lat + 0.0002,
        stop_lon: orig.stop_lon + 0.0002,
      });
    });
    return newId;
  },
  fillMissingWheelchairBoarding: (stopIds, value) => {
    const ids = new Set(stopIds);
    const changed: WheelchairFill[] = [];
    set((state) => {
      for (const s of state.stops) {
        if (!ids.has(s.stop_id)) continue;
        const cur = s.wheelchair_boarding;
        // Never overwrite a stop that already declares accessibility (1 or 2).
        if (cur === 1 || cur === 2) continue;
        changed.push({ stop_id: s.stop_id, prev: Number.isFinite(cur) ? cur : 0 });
        s.wheelchair_boarding = value;
      }
    });
    return changed;
  },
  restoreWheelchairBoarding: (entries) => set((state) => {
    const prevById = new Map(entries.map((e) => [e.stop_id, e.prev]));
    for (const s of state.stops) {
      const prev = prevById.get(s.stop_id);
      if (prev !== undefined) s.wheelchair_boarding = prev;
    }
  }),
  setStops: (stops) => set((state) => { state.stops = stops; }),
});
