import { describe, it, expect } from 'vitest';
import { activeStopsShapeId, type ShapePattern } from '../shapePatterns';

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
