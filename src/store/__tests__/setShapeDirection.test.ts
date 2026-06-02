// setShapeDirection retags a shape's trips + route stops to a new direction
// and can reverse the stop order — the core of the draw → duplicate → flip
// inbound workflow. See routeSlice.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';

beforeEach(() => {
  const s = useStore.getState();
  s.setTrips([]);
  s.setStopTimes([]);
  s.setRouteStops([]);
});

function seed() {
  const s = useStore.getState();
  s.setTrips([
    { trip_id: 'T', route_id: 'r', service_id: 'svc', direction_id: 0, shape_id: 'SH' },
  ] as never);
  s.setRouteStops([
    { route_id: 'r', stop_id: 's1', direction_id: 0, stop_sequence: 0, _snapped: true, shape_id: 'SH' },
    { route_id: 'r', stop_id: 's2', direction_id: 0, stop_sequence: 1, _snapped: true, shape_id: 'SH' },
    { route_id: 'r', stop_id: 's3', direction_id: 0, stop_sequence: 2, _snapped: true, shape_id: 'SH' },
  ] as never);
}

const orderedStops = () =>
  useStore.getState().routeStops
    .filter((rs) => rs.shape_id === 'SH')
    .sort((a, b) => a.stop_sequence - b.stop_sequence)
    .map((rs) => rs.stop_id);

describe('setShapeDirection', () => {
  it('retags the shape\'s trips + stops to the new direction', () => {
    seed();
    useStore.getState().setShapeDirection('SH', 1);
    const st = useStore.getState();
    expect(st.trips.every((t) => t.shape_id !== 'SH' || t.direction_id === 1)).toBe(true);
    expect(st.routeStops.every((rs) => rs.shape_id !== 'SH' || rs.direction_id === 1)).toBe(true);
    // Order unchanged when not inverting.
    expect(orderedStops()).toEqual(['s1', 's2', 's3']);
  });

  it('reverses the stop order when invertStops is set', () => {
    seed();
    useStore.getState().setShapeDirection('SH', 1, { invertStops: true });
    expect(orderedStops()).toEqual(['s3', 's2', 's1']);
    expect(useStore.getState().routeStops.every((rs) => rs.direction_id === 1)).toBe(true);
  });

  it('only touches the named shape', () => {
    seed();
    const s = useStore.getState();
    s.addRouteStop({ route_id: 'r', stop_id: 'x1', direction_id: 0, stop_sequence: 0, _snapped: true, shape_id: 'OTHER' } as never);
    useStore.getState().setShapeDirection('SH', 1, { invertStops: true });
    const other = useStore.getState().routeStops.find((rs) => rs.shape_id === 'OTHER')!;
    expect(other.direction_id).toBe(0);
    expect(other.stop_sequence).toBe(0);
  });
});
