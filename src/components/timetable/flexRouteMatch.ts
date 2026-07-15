import { findFlexZoneRoute } from '../flex/flexHelpers';
import type { FlexZone } from '../../store/flexSlice';
import type { Route } from '../../types/gtfs';

/** GTFS extended route_type for Demand and Response Bus Service. */
export const FLEX_ROUTE_TYPE = 715;

/**
 * The flex zone a route is paired with, if any. Inverts flexHelpers'
 * findFlexZoneRoute (zone → route) so the pairing rule — explicit
 * zone.routeId first, legacy name match as fallback — has one definition.
 */
export function findFlexZoneForRoute(
  route: Route,
  zones: FlexZone[],
  routes: Route[],
): FlexZone | undefined {
  return zones.find((z) => findFlexZoneRoute(routes, z)?.route_id === route.route_id);
}

/**
 * True when a route is demand-response: it's zone-paired, or it carries the
 * 715 route_type. Such a route's trip is synthesized at export time
 * (materializeFlex), so it has no trips in the store and must not be shown
 * the fixed-route timetable empty state.
 */
export function isFlexRoute(route: Route, zones: FlexZone[], routes: Route[]): boolean {
  return route.route_type === FLEX_ROUTE_TYPE || !!findFlexZoneForRoute(route, zones, routes);
}
