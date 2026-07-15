/**
 * Road ROUTING through a list of waypoints — the geometry primitive behind the
 * "Shapes from stops" recipe (services/shapesFromStops.ts).
 *
 * WHY THIS EXISTS (and why it is NOT snapToRoad.ts):
 * Map Matching (snapToRoad.ts) is built for a DENSE GPS-style trace — points a
 * few metres apart, each within a per-point search radius. Feeding it a stop
 * sequence, where consecutive stops on a rural route are MILES apart, makes it
 * match a small cluster, split the trace, and silently drop the rest: on the
 * real Skyline (Bozeman↔Big Sky) feed that produced "shapes" covering 3-7% of
 * the actual corridor — far worse than the straight lines they replaced.
 *
 * The Directions API is the right primitive for stops: hand it the stops as
 * WAYPOINTS and it returns the road route that actually connects them. This is
 * the same lesson travelTime.ts already learned (it replaced shape-projection
 * with Directions for the same reason) — hence the identical ≤25-waypoint
 * overlapping-chunk walk.
 *
 * snapToRoad.ts stays exactly as it is: it remains correct for the hand-DRAWN
 * line flow, whose vertices really are dense.
 */
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// Mapbox Directions accepts at most 25 coordinates per request. Longer stop
// lists are walked in windows of ≤25 waypoints that OVERLAP by one stop, so the
// windows' geometries meet at a shared waypoint and stitch end-to-end with no
// gap (the duplicated joint vertex is dropped at the seam). Mirrors
// travelTime.ts's MAX_WAYPOINTS walk.
const MAX_WAYPOINTS = 25;

export type LngLat = [number, number];

export type RouteGeomStatus =
  | 'routed'   // every window came back with a road route
  | 'partial'  // some windows routed, some didn't — we kept what we got
  | 'failed';  // nothing routed; `coords` is the input, unchanged

export interface RouteGeomResult {
  status: RouteGeomStatus;
  /** Full road geometry through the stops. Equals the input when 'failed'. */
  coords: LngLat[];
}

/**
 * Road geometry for ONE window of ≤25 waypoints, from the first to the last, via
 * every stop in between. Returns null on any fetch/HTTP/parse failure so the
 * caller can fall back for just that window.
 */
async function fetchRouteGeometry(chunk: LngLat[]): Promise<LngLat[] | null> {
  if (chunk.length < 2) return null;
  const coordString = chunk.map((c) => `${c[0]},${c[1]}`).join(';');
  // overview=full gives the complete road polyline (not the simplified preview);
  // geometries=geojson returns it as [lng, lat] pairs, which is already our
  // shape-point order.
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordString}`
    + `?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: { code?: string; routes?: { geometry?: { coordinates?: LngLat[] } }[] };
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data.code !== 'Ok' || !data.routes?.length) return null;

  const coords = data.routes[0].geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  return coords as LngLat[];
}

/**
 * The road route through `stopCoords`, in order, as a single continuous line.
 *
 * Windows of ≤25 waypoints overlapping by one are routed and concatenated. A
 * window that fails to route is filled with its own straight stop-to-stop
 * segments rather than left as a hole — that keeps the line continuous (and its
 * length honest) instead of producing the truncated stub Map Matching used to,
 * and the 'partial' status tells the caller part of the line isn't road-derived.
 */
export async function routeThroughStops(stopCoords: LngLat[]): Promise<RouteGeomResult> {
  // Nothing to route: a single point (or none) is already its own "geometry".
  if (stopCoords.length < 2) return { status: 'routed', coords: stopCoords };

  const merged: LngLat[] = [];
  let routedWindows = 0;
  let failedWindows = 0;

  for (let start = 0; start < stopCoords.length - 1; start += MAX_WAYPOINTS - 1) {
    const end = Math.min(start + MAX_WAYPOINTS, stopCoords.length); // exclusive
    const chunk = stopCoords.slice(start, end);

    const routed = await fetchRouteGeometry(chunk);
    // Fall back to the raw waypoints for this window only.
    const geometry = routed ?? chunk;
    if (routed) routedWindows++;
    else failedWindows++;

    if (merged.length === 0) {
      merged.push(...geometry);
    } else {
      // Windows overlap by one waypoint, so each window's first vertex is the
      // previous window's last: drop it or the seam gets a duplicate point.
      merged.push(...geometry.slice(1));
    }
  }

  if (routedWindows === 0) return { status: 'failed', coords: stopCoords };
  return {
    status: failedWindows === 0 ? 'routed' : 'partial',
    coords: merged,
  };
}

/**
 * Cumulative great-circle length (metres) of a [lng, lat] polyline.
 *
 * Deliberately duplicated from snapToRoad.ts's copy rather than imported: that
 * module is the Map-Matching path and pulling it in here (or into
 * shapesFromStops) would drag its module-level token read along with it.
 */
export function pathLengthMeters(coords: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1], coords[i]);
  }
  return total;
}

/** Great-circle distance in metres between two [lng, lat] points. */
function haversineMeters(a: LngLat, b: LngLat): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
