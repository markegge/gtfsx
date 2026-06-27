import { describe, it, expect } from 'vitest';
import { activeStopsShapeId, computeShapePatterns, type ShapePattern } from '../shapePatterns';

// activeStopsShapeId resolves which shape the Routes > Stops subpanel is
// editing. The map highlight keys off the same value (via stopPlacementShapeId),
// so these cases also pin down the "switch direction → highlight that shape"
// behaviour.
describe('activeStopsShapeId', () => {
  const patterns: ShapePattern[] = [
    { shapeId: 'out', directionId: 0 },
    { shapeId: 'in', directionId: 1 },
  ];

  it('follows the active direction when no shape is pinned', () => {
    expect(activeStopsShapeId(patterns, null, 0)).toBe('out');
    // Changing direction moves the active shape — this is the propagation the
    // map highlight depends on.
    expect(activeStopsShapeId(patterns, null, 1)).toBe('in');
  });

  it('honours a pinned in-route shape over the direction fallback', () => {
    expect(activeStopsShapeId(patterns, 'in', 0)).toBe('in');
    expect(activeStopsShapeId(patterns, 'out', 1)).toBe('out');
  });

  it('ignores a pinned shape that is not one of the route patterns', () => {
    // e.g. a selection left over from a different route — fall back to direction.
    expect(activeStopsShapeId(patterns, 'stale', 1)).toBe('in');
  });

  it('distinguishes same-direction variants by the pinned shape', () => {
    // Two outbound patterns: direction alone cannot tell them apart, so the
    // pinned shape decides which one is highlighted.
    const variants: ShapePattern[] = [
      { shapeId: 'a', directionId: 0 },
      { shapeId: 'b', directionId: 0 },
    ];
    expect(activeStopsShapeId(variants, 'b', 0)).toBe('b');
    expect(activeStopsShapeId(variants, 'a', 0)).toBe('a');
  });

  it('returns null when the route has no shaped patterns', () => {
    expect(activeStopsShapeId([], null, 0)).toBeNull();
    expect(activeStopsShapeId([], 'whatever', 1)).toBeNull();
  });
});

// Regression (Mark, 2026-06-27): drawing a second shape ("Navy Inbound") left it
// out of the Stops subpanel "Assign to" dropdown, so you couldn't place its
// first stop (chicken-and-egg). A freshly drawn shape is linked to its route
// only via shape._route_id until it has a trip or route_stop.
describe('computeShapePatterns — freshly drawn shapes', () => {
  const shape = (id: string, routeId?: string) =>
    ({ shape_id: id, points: [], _route_id: routeId }) as never;

  it('includes a just-drawn shape (shape._route_id) with no trips or stops', () => {
    expect(computeShapePatterns('R', [], [], [shape('s1', 'R')])).toEqual([
      { shapeId: 's1', directionId: 0 },
    ]);
  });

  it('gives a drawn shape the direction not used by a real pattern', () => {
    const trips = [{ trip_id: 't', route_id: 'R', shape_id: 'out', direction_id: 0 }] as never;
    expect(computeShapePatterns('R', trips, [], [shape('out', 'R'), shape('in', 'R')])).toEqual([
      { shapeId: 'out', directionId: 0 },
      { shapeId: 'in', directionId: 1 },
    ]);
  });

  it('assigns two freshly drawn shapes to directions 0 then 1', () => {
    expect(computeShapePatterns('R', [], [], [shape('a', 'R'), shape('b', 'R')])).toEqual([
      { shapeId: 'a', directionId: 0 },
      { shapeId: 'b', directionId: 1 },
    ]);
  });

  it('ignores a drawn shape belonging to another route', () => {
    expect(computeShapePatterns('R', [], [], [shape('x', 'OTHER')])).toEqual([]);
  });
});
