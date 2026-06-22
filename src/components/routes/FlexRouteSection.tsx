import { useMemo } from 'react';
import { useStore } from '../../store';
import { openFlexZoneDetails } from '../flex/flexHelpers';
import type { FlexZone } from '../../store/flexSlice';
import type { Stop } from '../../types/gtfs';

// Flex zones (GTFS-Flex demand-response service areas) are materialized as
// routes (createFlexZoneWithRoute), but they're conceptually their own thing.
// We surface them in the Routes panel under a dedicated "Flex" section so the
// user can find, focus, and rename them alongside fixed routes — while the
// dashed-outline polygons stay editable in the Flex Zones panel.

const DEFAULT_FLEX_COLOR = '7C3AED'; // hex without '#', matching route_color storage

type Bounds = [[number, number], [number, number]];

/**
 * Map bounds enclosing a flex zone: its polygon geometry if it has any,
 * otherwise the member stops of its location group. Returns null for a zone
 * with neither (a freshly-created, geometry-less zone).
 */
function flexZoneBounds(zone: FlexZone, stops: Stop[]): Bounds | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  const visit = (lng: number, lat: number) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };

  for (const f of zone.geojson?.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') {
      for (const ring of g.coordinates) for (const [lng, lat] of ring) visit(lng, lat);
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) for (const ring of poly) for (const [lng, lat] of ring) visit(lng, lat);
    }
  }

  // Group-only (or geometry-less) zone: fall back to its member stops.
  if (minLng === Infinity && zone.stopIds?.length) {
    const wanted = new Set(zone.stopIds);
    for (const s of stops) if (wanted.has(s.stop_id)) visit(s.stop_lon, s.stop_lat);
  }

  if (minLng === Infinity) return null;
  return [[minLng, minLat], [maxLng, maxLat]];
}

/** Short, flex-appropriate subtitle mirroring the routes' muted second line. */
function describeZone(zone: FlexZone): string {
  const polys = zone.geojson?.features?.length ?? 0;
  const stops = zone.stopIds?.length ?? 0;
  const parts: string[] = [];
  if (polys) parts.push(`${polys} area${polys !== 1 ? 's' : ''}`);
  if (stops) parts.push(`${stops} stop${stops !== 1 ? 's' : ''}`);
  return parts.length ? `Demand response · ${parts.join(' + ')}` : 'Demand response';
}

/**
 * The "Flex" section of the Routes panel. Lists each flex zone as a row that
 * matches the fixed-route rows exactly (color swatch + name + muted subtitle,
 * same hover/selected states). Clicking a row flies the map to the zone and
 * opens its materialized route in the editor — the same path the map popup's
 * "Edit Route" uses — so renaming via the Route editor's Short Name renames
 * the zone too (updateRoute keeps FlexZone.name in sync).
 *
 * Renders nothing when there are no (matching) flex zones, so the heading only
 * appears once a feed actually has demand-response service areas.
 */
export function FlexRouteSection({ filterText }: { filterText: string }) {
  const flexZones = useStore((s) => s.flexZones);
  const routes = useStore((s) => s.routes);
  const stops = useStore((s) => s.stops);
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const toggleRouteVisibility = useStore((s) => s.toggleRouteVisibility);
  const selectRoute = useStore((s) => s.selectRoute);
  const setEditingRouteId = useStore((s) => s.setEditingRouteId);

  const routesById = useMemo(
    () => new Map(routes.map((r) => [r.route_id, r])),
    [routes],
  );

  const q = filterText.trim().toLowerCase();
  const visibleZones = useMemo(() => {
    if (!q) return flexZones;
    return flexZones.filter((z) => {
      const route = z.routeId ? routesById.get(z.routeId) : undefined;
      return (
        z.name?.toLowerCase().includes(q) ||
        route?.route_short_name?.toLowerCase().includes(q) ||
        route?.route_long_name?.toLowerCase().includes(q)
      );
    });
  }, [flexZones, q, routesById]);

  if (visibleZones.length === 0) return null;

  const handleOpen = (zone: FlexZone) => {
    const bounds = flexZoneBounds(zone, stops);
    if (bounds) window.__mapFitBounds?.(bounds, { padding: 80, maxZoom: 14 });
    const routeId = zone.routeId;
    if (routeId && routes.some((r) => r.route_id === routeId)) {
      // Open the materialized route the same way a fixed route opens — this is
      // the tested "rename in the Routes panel" path (RouteEditor → Short Name).
      selectRoute(routeId);
      setEditingRouteId(routeId);
    } else {
      // Legacy / orphaned zone with no materialized route: fall back to the
      // Flex panel's own detail editor.
      openFlexZoneDetails(zone.id);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-sand">
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-2">
        Flex ({visibleZones.length})
      </div>

      <div className="flex flex-col gap-1">
        {visibleZones.map((zone) => {
          const routeId = zone.routeId;
          const route = routeId ? routesById.get(routeId) : undefined;
          const colorHex = route?.route_color || DEFAULT_FLEX_COLOR;
          const isHidden = routeId ? hiddenRouteIds.includes(routeId) : false;
          const isSelected = !!routeId && selectedRouteId === routeId;
          const label = zone.name?.trim() || route?.route_short_name?.trim() || 'Untitled zone';

          return (
            <div
              key={zone.id}
              onClick={() => handleOpen(zone)}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg transition-colors cursor-pointer
                ${isSelected ? 'bg-sand' : 'hover:bg-cream'}`}
            >
              {/* Color swatch — click to toggle the zone's visibility on the map
                  (FlexLayer hides zones whose materialized route is hidden). */}
              {routeId ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleRouteVisibility(routeId);
                  }}
                  className={`w-5 h-5 rounded-md shrink-0 transition-all border-2
                    ${isHidden
                      ? 'opacity-40 border-warm-gray hover:opacity-70'
                      : 'opacity-100 border-transparent hover:scale-110'
                    }`}
                  style={{ backgroundColor: isHidden ? 'transparent' : `#${colorHex}`, borderColor: isHidden ? `#${colorHex}` : 'transparent' }}
                  title={isHidden ? 'Show on map' : 'Hide from map'}
                />
              ) : (
                <span
                  className="w-5 h-5 rounded-md shrink-0 border-2 border-transparent"
                  style={{ backgroundColor: `#${colorHex}` }}
                />
              )}
              <div className={`flex flex-col min-w-0 flex-1 transition-opacity ${isHidden ? 'opacity-40' : ''}`}>
                <span className="font-semibold text-sm text-dark-brown truncate">
                  {label}
                </span>
                <span className="text-[11px] text-warm-gray">
                  {describeZone(zone)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
