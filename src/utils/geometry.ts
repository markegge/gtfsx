/**
 * Ray-casting point-in-polygon test against a single ring of [lng, lat] pairs.
 * Returns true if (lng, lat) lies inside the ring. The ring may be open or
 * closed (first vertex repeated as the last) — both work. Dependency-free
 * (we don't pull in @turf/boolean-point-in-polygon for this one use).
 */
export function pointInPolygon(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
