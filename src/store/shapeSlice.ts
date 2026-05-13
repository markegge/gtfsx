import type { StateCreator } from 'zustand';
import type { Shape, ShapePoint, Trip } from '../types/gtfs';
import length from '@turf/length';
import { lineString, point } from '@turf/helpers';
import nearestPointOnLine from '@turf/nearest-point-on-line';

export interface SplitShapeResult {
  ok: boolean;
  newShapeId?: string;
  reason?: string;
  outboundLengthM?: number;
  inboundLengthM?: number;
}

export interface ShapeSlice {
  shapes: Shape[];
  addShape: (shape: Shape) => void;
  updateShapePoints: (shape_id: string, points: Shape['points']) => void;
  removeShape: (shape_id: string) => void;
  setShapes: (shapes: Shape[]) => void;
  recalcShapeDistances: (shape_id: string) => void;
  // Split a route's single shape into two — outbound stays on the original
  // shape_id, inbound is a new shape with a fresh id. Inbound trips on this
  // route are reassigned to the new shape_id. Returns metadata for the UI
  // (or { ok: false, reason } when validation fails).
  splitShapeForRoute: (
    route_id: string,
    shape_id: string,
    lng: number,
    lat: number,
  ) => SplitShapeResult;
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
  splitShapeForRoute: (route_id, shape_id, lng, lat) => {
    let result: SplitShapeResult = { ok: false, reason: 'unknown' };
    set((state) => {
      const shape = state.shapes.find((s) => s.shape_id === shape_id);
      if (!shape || shape.points.length < 3) {
        result = { ok: false, reason: 'Shape needs at least 3 points to split.' };
        return;
      }

      const coords = shape.points.map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
      const line = lineString(coords);
      const snapped = nearestPointOnLine(line, point([lng, lat]), { units: 'meters' });
      const splitLng = snapped.geometry.coordinates[0];
      const splitLat = snapped.geometry.coordinates[1];
      // `properties.index` is the index of the polyline segment containing
      // the snapped point — i.e. snapped lies between coords[index] and
      // coords[index+1]. Use it to slice the vertex list cleanly.
      const segIndex = snapped.properties.index ?? 0;

      // Outbound = vertices [0..segIndex], then append the synthetic split
      // point as the final vertex. Inbound = synthetic split point, then
      // vertices [segIndex+1..end].
      const outboundPts: ShapePoint[] = shape.points.slice(0, segIndex + 1).map((p) => ({ ...p }));
      // Skip the trailing duplicate when the snapped point coincides with
      // an existing vertex (e.g. user clicked exactly on a vertex). Helps
      // avoid two adjacent identical points which would yield 0-length
      // segments and confuse downstream distance calcs.
      const last = outboundPts[outboundPts.length - 1];
      if (Math.abs(last.shape_pt_lat - splitLat) > 1e-7 || Math.abs(last.shape_pt_lon - splitLng) > 1e-7) {
        outboundPts.push({
          shape_pt_lat: splitLat,
          shape_pt_lon: splitLng,
          shape_pt_sequence: outboundPts.length,
          shape_dist_traveled: 0,
        });
      }

      const inboundTail: ShapePoint[] = shape.points.slice(segIndex + 1).map((p) => ({ ...p }));
      const inboundPts: ShapePoint[] = [
        {
          shape_pt_lat: splitLat,
          shape_pt_lon: splitLng,
          shape_pt_sequence: 0,
          shape_dist_traveled: 0,
        },
        ...inboundTail,
      ];

      // Reject when either half is degenerate.
      if (outboundPts.length < 2 || inboundPts.length < 2) {
        result = { ok: false, reason: 'Split point is too close to an endpoint.' };
        return;
      }

      // Recompute shape_dist_traveled + shape_pt_sequence in place.
      const recompute = (pts: ShapePoint[]) => {
        pts[0].shape_pt_sequence = 0;
        pts[0].shape_dist_traveled = 0;
        for (let i = 1; i < pts.length; i++) {
          pts[i].shape_pt_sequence = i;
          const sub = lineString(pts.slice(0, i + 1).map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]));
          pts[i].shape_dist_traveled = length(sub, { units: 'meters' });
        }
      };
      recompute(outboundPts);
      recompute(inboundPts);

      // Generate a unique new shape_id derived from the original.
      let newShapeId = `${shape_id}-inbound`;
      const existing = new Set(state.shapes.map((s) => s.shape_id));
      if (existing.has(newShapeId)) {
        let n = 2;
        while (existing.has(`${shape_id}-inbound-${n}`)) n++;
        newShapeId = `${shape_id}-inbound-${n}`;
      }

      // Write back: original shape gets the outbound half; push a new shape
      // for the inbound half.
      shape.points = outboundPts;
      state.shapes.push({ shape_id: newShapeId, points: inboundPts });

      // Reassign direction_id=1 trips on this route currently using the
      // original shape to the new shape. Direction 0 trips stay put.
      // Cross-slice access — same pattern as TripSlice's reassignTripId.
      const trips = (state as unknown as { trips: Trip[] }).trips;
      let reassigned = 0;
      for (const t of trips) {
        if (t.route_id === route_id && t.direction_id === 1 && t.shape_id === shape_id) {
          t.shape_id = newShapeId;
          reassigned++;
        }
      }

      // If the route had no direction-1 trips at all (common when the user
      // is preparing the inbound shape before defining inbound trips),
      // create a placeholder trip so the new shape actually shows up in
      // the Route Shapes list and is editable. Service_id is borrowed
      // from the first outbound trip on this route.
      if (reassigned === 0) {
        const seed = trips.find((t) => t.route_id === route_id && t.direction_id === 0);
        if (seed) {
          const baseId = `${route_id}-inbound-trip`;
          let placeholderTripId = baseId;
          const existingTripIds = new Set(trips.map((t) => t.trip_id));
          let n = 2;
          while (existingTripIds.has(placeholderTripId)) {
            placeholderTripId = `${baseId}-${n}`;
            n++;
          }
          trips.push({
            trip_id: placeholderTripId,
            route_id,
            service_id: seed.service_id,
            direction_id: 1,
            shape_id: newShapeId,
          });
        }
      }

      const outboundLengthM = outboundPts[outboundPts.length - 1].shape_dist_traveled;
      const inboundLengthM = inboundPts[inboundPts.length - 1].shape_dist_traveled;
      result = { ok: true, newShapeId, outboundLengthM, inboundLengthM };
    });
    return result;
  },
});
