import { useMemo } from 'react';
import { useStore } from '../../store';
import { directionName } from '../../utils/constants';
import { computeShapePatterns } from '../ui/shapePatterns';
import { TimetableGrid, type TimetableScope } from './TimetableGrid';

/** "Show opposite direction" container for the timetable. The left pane is the
 *  normal, global-backed timetable. The right pane is fully DERIVED from it: the
 *  same route and service, with the direction flipped, so outbound and inbound
 *  trips line up side by side for comparing arrival/departure times. The right
 *  pane has no scoping controls — it always mirrors the main pane's opposite
 *  direction and re-derives whenever the main pane's route / direction / service
 *  changes. Stop-time edits in either pane write through the same trip-keyed
 *  store actions, so both stay editable and live-update together. */
export function SplitTimetable() {
  const selectedRouteId = useStore((s) => s.selectedRouteId);
  const mainDirectionId = useStore((s) => s.timetableDirectionId);
  const serviceId = useStore((s) => s.timetableServiceId);
  const trips = useStore((s) => s.trips);
  const routeStops = useStore((s) => s.routeStops);
  const routes = useStore((s) => s.routes);
  const calendars = useStore((s) => s.calendars);

  const oppositeDirectionId: 0 | 1 = mainDirectionId === 0 ? 1 : 0;
  const route = routes.find((r) => r.route_id === selectedRouteId);
  const oppositeLabel = `Direction ${oppositeDirectionId} · ${directionName(route, oppositeDirectionId)}`;

  // The opposite direction's shape pattern (computed the same way the grid does,
  // so the pane's derived shape is always a valid selection there). A route with
  // no shapes at all yields no patterns — the grid then filters by direction_id.
  const patterns = useMemo(
    () => computeShapePatterns(selectedRouteId, trips, routeStops),
    [selectedRouteId, trips, routeStops],
  );
  const oppositePattern = patterns.find((p) => p.directionId === oppositeDirectionId) ?? null;

  // Effective service resolves the same way the grid does: the selected calendar
  // if still valid, else the first calendar.
  const activeServiceId = useMemo(() => {
    if (serviceId && calendars.some((c) => c.service_id === serviceId)) return serviceId;
    return calendars[0]?.service_id ?? null;
  }, [serviceId, calendars]);

  // Whether the opposite direction has any trips for the active service — this is
  // exactly what the derived grid would render, so we key the empty state on it.
  // With a shape pattern we match its shape; a fully shapeless route matches by
  // direction. A route with shapes but none in the opposite direction has no
  // opposite pattern and no shapeless fallback, so this is false.
  const hasOppositeTrips = useMemo(() => {
    if (!selectedRouteId) return false;
    if (!oppositePattern && patterns.length > 0) return false;
    return trips.some((t) =>
      t.route_id === selectedRouteId
      && (!activeServiceId || t.service_id === activeServiceId)
      && (oppositePattern ? t.shape_id === oppositePattern.shapeId : t.direction_id === oppositeDirectionId),
    );
  }, [selectedRouteId, oppositePattern, patterns.length, activeServiceId, oppositeDirectionId, trips]);

  const scopeB: TimetableScope = {
    routeId: selectedRouteId,
    directionId: oppositeDirectionId,
    serviceId,
    shapeId: oppositePattern?.shapeId ?? null,
    headerLabel: oppositeLabel,
  };

  return (
    <div className="flex-1 min-h-0 flex divide-x-2 divide-sand">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <TimetableGrid />
      </div>
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {hasOppositeTrips ? (
          <TimetableGrid scope={scopeB} />
        ) : (
          <div className="p-2 flex flex-col min-h-0 flex-1">
            <div className="shrink-0 mb-2 px-2 flex items-center gap-2 h-[30px]">
              <span className="text-xs font-semibold text-dark-brown whitespace-nowrap">{oppositeLabel}</span>
            </div>
            <div className="flex-1 flex items-center justify-center text-center px-6 text-sm text-warm-gray">
              No trips in the opposite direction for this service.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
