// Dropdown over a route's shape patterns, used when a route has 3+ patterns
// and the two-way Direction 0/1 toggle can't represent them. Shared by the
// Timetable tab and the Routes > Stops subpanel. The pattern math lives in
// ./shapePatterns (kept separate so this file only exports a component).

import { directionName } from '../../utils/constants';
import type { Route, Shape } from '../../types/gtfs';
import type { ShapePattern } from './shapePatterns';

/**
 * Each option carries (shape_id, direction_id). The label is the shape's name
 * when available (so users pick "the long way home" rather than a direction);
 * otherwise the route's direction name, with a disambiguating suffix when
 * multiple patterns share a direction (else the entries collide visually).
 */
export function PatternSelector({
  patterns,
  selectedShapeId,
  onChange,
  route,
  shapes,
  className,
}: {
  patterns: ShapePattern[];
  selectedShapeId: string | null;
  onChange: (p: ShapePattern) => void;
  route?: Route | null;
  shapes?: Shape[];
  className?: string;
}) {
  const dirCounts = patterns.reduce<Record<number, number>>((acc, p) => {
    acc[p.directionId] = (acc[p.directionId] ?? 0) + 1;
    return acc;
  }, {});
  const label = (p: ShapePattern) => {
    const name = shapes?.find((s) => s.shape_id === p.shapeId)?._name?.trim();
    if (name) return name;
    const base = directionName(route, p.directionId);
    return dirCounts[p.directionId] > 1 ? `${base} · ${p.shapeId}` : base;
  };
  return (
    <select
      value={selectedShapeId ?? patterns[0]?.shapeId ?? ''}
      onChange={(e) => {
        const next = patterns.find((p) => p.shapeId === e.target.value);
        if (next) onChange(next);
      }}
      className={
        className ??
        'px-2 py-1 border border-sand rounded-md text-xs font-semibold bg-cream focus:outline-none focus:border-coral max-w-[200px]'
      }
    >
      {patterns.map((p) => (
        <option key={p.shapeId} value={p.shapeId}>{label(p)}</option>
      ))}
    </select>
  );
}
