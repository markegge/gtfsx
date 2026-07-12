import { useStore } from '../../store';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import type { FlexZone } from '../../store/flexSlice';

/** The subset of a route we need to name it or pair it back to a zone. */
interface RouteNames {
  route_short_name?: string;
  route_long_name?: string;
}

/** Long-name suffix used by the pre-715 naming scheme (see flexRouteNames). */
const LEGACY_LONG_SUFFIX = ' (Flex)';

/**
 * The one place a flex zone's paired route gets its names. A zone name is prose
 * ("Northside Dial-a-Ride"), and route_short_name is meant to be a route number,
 * so the name belongs in route_long_name: putting it in both trips the
 * validator's route_long_name_contains_short_name, and putting it in the short
 * name alone trips route_short_name_too_long. GTFS requires only ONE of the two
 * names, so flex routes are long-name-only. The short name is emitted empty
 * (the exporter's Route rows type it as required); an empty value reads as
 * absent to the validator.
 */
export function flexRouteNames(zoneName: string): { route_short_name: string; route_long_name: string } {
  return { route_short_name: '', route_long_name: zoneName };
}

/**
 * The one noun for a flex zone, used by every creation path (draw, stop group,
 * route buffer, GeoJSON import) and by the panel's list heading. Zones used to
 * be minted as "Zone 1" / "Service Area 1" / "Stop Group 1" depending on which
 * button made them, which read as three different kinds of object.
 */
const FLEX_ZONE_NOUN = 'Service Area';

/**
 * The next free "Service Area N" name. Numbering is a single sequence over the
 * zones that exist right now, not a per-path counter, so two creation paths
 * can't both mint "Service Area 1" — and a name freed by a delete gets reused
 * rather than skipped.
 */
export function nextFlexZoneName(zones: readonly { name: string }[]): string {
  const taken = new Set(zones.map((z) => (z.name || '').trim()));
  let n = 1;
  while (taken.has(`${FLEX_ZONE_NOUN} ${n}`)) n += 1;
  return `${FLEX_ZONE_NOUN} ${n}`;
}

/**
 * Legacy fallback for pairing a route back to a zone that carries no routeId
 * (older feeds, some import paths). Matches BOTH naming schemes: the current
 * long-name-only one, and the pre-715 one that set short = "<name>" and
 * long = "<name> (Flex)". Wherever a zone HAS a routeId, that id wins — see
 * findFlexZoneRoute.
 */
export function routeMatchesFlexZoneName(route: RouteNames, zoneName: string): boolean {
  const name = (zoneName || '').trim();
  if (!name) return false;
  const short = (route.route_short_name || '').trim();
  const long = (route.route_long_name || '').trim();
  return long === name || short === name || long === `${name}${LEGACY_LONG_SUFFIX}`;
}

/**
 * Resolve the route a flex zone is paired with: by explicit routeId first, then
 * (only when that yields nothing) by the legacy name match above.
 */
export function findFlexZoneRoute<T extends RouteNames & { route_id: string }>(
  routes: readonly T[],
  zone: { routeId?: string; name: string },
): T | undefined {
  const byId = zone.routeId ? routes.find((r) => r.route_id === zone.routeId) : undefined;
  if (byId) return byId;
  return routes.find((r) => routeMatchesFlexZoneName(r, zone.name));
}

/**
 * Create a flex zone and, if it doesn't already have a linked route, an
 * accompanying route in routes.txt (route_type = 715, Demand and Response
 * Bus Service). A flex zone IS a route conceptually; materializing it
 * eagerly means the user sees it in the Routes list, the validator sees
 * it, and the export doesn't have to synthesize one at the last second.
 */
export function createFlexZoneWithRoute(
  zone: Omit<FlexZone, 'routeId'> & { routeId?: string },
) {
  const state = useStore.getState();
  let routeId = zone.routeId;
  if (!routeId) {
    const usedColors = new Set(state.routes.map((r) => r.route_color));
    const nextColor = ROUTE_COLORS.find((c) => !usedColors.has(c)) || '7C3AED';
    routeId = generateId('route');
    state.addRoute({
      route_id: routeId,
      agency_id: state.agencies[0]?.agency_id || '',
      ...flexRouteNames(zone.name),
      // Extended route type 715 — Demand and Response Bus Service.
      route_type: 715,
      route_color: nextColor,
      route_text_color: getContrastTextColor(nextColor),
    });
  }

  // Auto-assign the lone service pattern. When the feed defines exactly ONE
  // service_id (across calendar.txt + calendar_dates.txt), a new flex zone can
  // only run on that service, so pre-pick it — saving the user a trip to the
  // Details panel and making the zone immediately export-eligible. With 0 or
  // 2+ patterns we leave it unset (current behavior). A serviceId already on
  // the incoming zone is always respected.
  let serviceId = zone.serviceId;
  if (serviceId === undefined) {
    const ids = new Set<string>();
    for (const c of state.calendars) ids.add(c.service_id);
    for (const d of state.calendarDates) ids.add(d.service_id);
    if (ids.size === 1) serviceId = [...ids][0];
  }

  state.addFlexZone({ ...zone, routeId, serviceId });
}

/**
 * Inverse of createFlexZoneWithRoute. Removes the flex zone AND the route
 * that was materialized for it (along with the route's trips, stop_times,
 * and any stops that become orphaned — handled by removeRoute's existing
 * cascade). Without this, deleting a zone from the FlexEditor leaves the
 * "Service Area N" entry behind in the Routes subpanel.
 */
export function deleteFlexZoneWithRoute(zoneId: string) {
  const state = useStore.getState();
  const zone = state.flexZones.find((z) => z.id === zoneId);
  // Belt-and-braces: drop the zone first so cross-store snapshots can't
  // observe a route-less zone. Then cascade the route delete.
  state.removeFlexZone(zoneId);
  if (zone?.routeId) {
    state.removeRoute(zone.routeId);
  }
}

/** Outcome of parsing an uploaded boundary file. Never throws — the caller
 *  renders `error` inline. */
export type BoundaryImportResult =
  | {
      ok: true;
      /** A one-feature FeatureCollection ready to become FlexZone.geojson. */
      geojson: GeoJSON.FeatureCollection;
      /** Suggested zone name, or null when nothing usable was found. */
      name: string | null;
      /** How many source polygons were merged into the single feature. */
      polygonCount: number;
    }
  | { ok: false; error: string };

/** locations.geojson permits Polygon and MultiPolygon geometry only. */
const FLEX_GEOMETRY_TYPES = ['Polygon', 'MultiPolygon'];

function isPosition(p: unknown): p is GeoJSON.Position {
  return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
}

/** A Polygon's coordinates: rings of at least 3 positions (rings may be open). */
function validRings(coords: unknown): coords is GeoJSON.Position[][] {
  return (
    Array.isArray(coords) &&
    coords.length > 0 &&
    coords.every((ring) => Array.isArray(ring) && ring.length >= 3 && ring.every(isPosition))
  );
}

function firstStringProp(props: unknown, keys: string[]): string | undefined {
  if (!props || typeof props !== 'object') return undefined;
  const record = props as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** "bozeman-service-area.geojson" → "bozeman-service-area". */
function baseFileName(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.(geo)?json$/i, '').trim();
  return stem || null;
}

/**
 * Parse an agency's boundary file (a .geojson / .json export of their service
 * area) into the single merged Polygon/MultiPolygon feature a flex zone stores.
 *
 * Accepts a FeatureCollection, a bare Feature, or a bare Geometry. Every polygon
 * across the file is merged into ONE feature, mirroring `zonePolygons` in
 * gtfsExport: one zone = one location_id = one locations.geojson Feature, so a
 * multi-polygon boundary must round-trip as a single MultiPolygon rather than
 * as sibling features the flex stop_times rows could never reference.
 *
 * Rejects (with a rider-legible message) anything the GTFS-Flex spec's
 * locations.geojson forbids — Point, LineString, GeometryCollection, … — which
 * is the same constraint the validator's `flex-unsupported-geometry-type` rule
 * enforces on export, plus coordinates outside the WGS84 lon/lat range (the
 * tell-tale of a projected/UTM file that was never reprojected).
 */
export function parseBoundaryGeoJson(text: string, fileName?: string): BoundaryImportResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't valid JSON. Export it again as GeoJSON." };
  }
  if (!root || typeof root !== 'object') {
    return { ok: false, error: 'That file is not GeoJSON — expected a FeatureCollection, Feature, or geometry.' };
  }

  const node = root as { type?: unknown; features?: unknown; geometry?: unknown };

  // Normalize the three accepted shapes down to a list of features.
  let features: { geometry?: unknown; properties?: unknown }[];
  if (node.type === 'FeatureCollection') {
    if (!Array.isArray(node.features)) {
      return { ok: false, error: 'That FeatureCollection has no features array.' };
    }
    if (node.features.length === 0) {
      return { ok: false, error: 'That FeatureCollection is empty — it contains no features.' };
    }
    features = node.features as { geometry?: unknown; properties?: unknown }[];
  } else if (node.type === 'Feature') {
    features = [node as { geometry?: unknown; properties?: unknown }];
  } else if (typeof node.type === 'string') {
    features = [{ geometry: node, properties: {} }];
  } else {
    return { ok: false, error: 'That file is not GeoJSON — expected a FeatureCollection, Feature, or geometry.' };
  }

  const polygons: GeoJSON.Position[][][] = [];
  const rejected = new Set<string>();

  for (const feature of features) {
    const geometry = feature?.geometry as { type?: unknown; coordinates?: unknown } | null | undefined;
    const type = geometry?.type;
    if (typeof type !== 'string') continue;
    if (!FLEX_GEOMETRY_TYPES.includes(type)) {
      rejected.add(type);
      continue;
    }
    if (type === 'Polygon') {
      if (!validRings(geometry?.coordinates)) {
        return { ok: false, error: 'A Polygon in that file has malformed coordinates.' };
      }
      polygons.push(geometry.coordinates);
    } else {
      const coords = geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length === 0 || !coords.every(validRings)) {
        return { ok: false, error: 'A MultiPolygon in that file has malformed coordinates.' };
      }
      polygons.push(...(coords as GeoJSON.Position[][][]));
    }
  }

  if (polygons.length === 0) {
    if (rejected.size > 0) {
      return {
        ok: false,
        error:
          `GTFS locations.geojson supports Polygon and MultiPolygon only — this file has ` +
          `${[...rejected].join(', ')}. Export your service-area boundary as polygons.`,
      };
    }
    return { ok: false, error: 'No polygon features found in that file.' };
  }

  // A projected file (UTM / State Plane) is the common failure here: its
  // easting/northing land far outside the lon/lat domain, so say so rather than
  // dropping an invisible zone somewhere off the map.
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
          return {
            ok: false,
            error:
              `Coordinates don't look like WGS84 lon/lat (found ${lon}, ${lat}). ` +
              'Reproject the file to EPSG:4326 and try again.',
          };
        }
      }
    }
  }

  const name =
    firstStringProp(features[0]?.properties, ['name', 'stop_name']) ??
    (fileName ? baseFileName(fileName) : null);
  const stopDesc = firstStringProp(features[0]?.properties, ['stop_desc', 'description']);

  return {
    ok: true,
    name,
    polygonCount: polygons.length,
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: stopDesc ? { stop_desc: stopDesc } : {},
          geometry:
            polygons.length === 1
              ? { type: 'Polygon', coordinates: polygons[0] }
              : { type: 'MultiPolygon', coordinates: polygons },
        },
      ],
    },
  };
}

/**
 * Open a flex zone's Details panel in the Flex Zones section. Fallback for
 * zones with no materialized route (legacy / orphaned) which therefore can't
 * open via the Routes editor. Lives in this non-component module so the
 * window-flag handoff (mirrored from FlexZonePopup) isn't flagged by the
 * react-hooks immutability rule, which only analyzes components and hooks.
 */
export function openFlexZoneDetails(zoneId: string) {
  useStore.getState().setSidebarSection('flex');
  window.__flexZoneExpand = zoneId;
}
