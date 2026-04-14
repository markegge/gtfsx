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
      route_type: 715,
      route_color: nextColor,
      route_text_color: getContrastTextColor(nextColor),
    });
  }
  state.addFlexZone({ ...zone, routeId });
}
