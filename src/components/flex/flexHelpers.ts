import { useStore } from '../../store';
import { generateId } from '../../services/idGenerator';
import { ROUTE_COLORS, getContrastTextColor } from '../../utils/colors';
import type { FlexZone } from '../../store/flexSlice';

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
      route_short_name: zone.name,
      route_long_name: `${zone.name} (Flex)`,
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
