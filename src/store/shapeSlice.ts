import type { StateCreator } from 'zustand';
import type { Shape } from '../types/gtfs';
import length from '@turf/length';
import { lineString } from '@turf/helpers';

export interface ShapeSlice {
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShapePoints: (shape_id: string, points: Shape['points']) => void;
  removeShape: (shape_id: string) => void;
  setShapes: (shapes: Shape[]) => void;
  recalcShapeDistances: (shape_id: string) => void;
}

export const createShapeSlice: StateCreator<ShapeSlice, [['zustand/immer', never]], [], ShapeSlice> = (set) => ({
  shapes: [],
  addShape: (shape) => set((state) => { state.shapes.push(shape); }),
  updateShapePoints: (shape_id, points) => set((state) => {
    const idx = state.shapes.findIndex((s) => s.shape_id === shape_id);
    if (idx !== -1) state.shapes[idx].points = points;
  }),
  removeShape: (shape_id) => set((state) => {
    state.shapes = state.shapes.filter((s) => s.shape_id !== shape_id);
  }),
  setShapes: (shapes) => set((state) => { state.shapes = shapes; }),
  recalcShapeDistances: (shape_id) => set((state) => {
    const shape = state.shapes.find((s) => s.shape_id === shape_id);
    if (!shape || shape.points.length < 2) return;
    const coords = shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
    shape.points[0].shape_dist_traveled = 0;
    for (let i = 1; i < shape.points.length; i++) {
      const subCoords = coords.slice(0, i + 1);
      if (subCoords.length >= 2) {
        const subLine = lineString(subCoords);
        shape.points[i].shape_dist_traveled = length(subLine, { units: 'meters' });
      }
    }
  }),
});
