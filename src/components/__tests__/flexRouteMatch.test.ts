// Issue #57: a flex route's trip is synthesized at export time, so the
// timetable must recognize a zone-paired route instead of showing it the
// fixed-route "add stops first" empty state.
import { describe, expect, it } from 'vitest';
import { findFlexZoneForRoute, isFlexRoute } from '../timetable/flexRouteMatch';
import type { FlexZone } from '../../store/flexSlice';
import type { Route } from '../../types/gtfs';

const emptyFc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function zone(over: Partial<FlexZone> = {}): FlexZone {
  return {
    id: 'zone-1',
    name: 'Demand Response Service Area',
    bufferMiles: 0,
    geojson: emptyFc,
    ...over,
  };
}

function route(over: Partial<Route> = {}): Route {
  return {
    route_id: 'r-flex',
    agency_id: 'a1',
    route_short_name: '',
    route_long_name: 'Demand Response Service Area',
    route_type: 715,
    route_color: '7B68EE',
    route_text_color: 'FFFFFF',
    ...over,
  };
}

const fixedRoute = route({
  route_id: 'r-1',
  route_short_name: '1',
  route_long_name: 'Downtown Loop',
  route_type: 3,
});

describe('flex route detection', () => {
  it('detects a route paired to a zone by routeId', () => {
    const flexRoute = route({ route_type: 3, route_long_name: 'Anything' });
    const zones = [zone({ routeId: 'r-flex' })];
    const routes = [flexRoute, fixedRoute];
    expect(isFlexRoute(flexRoute, zones, routes)).toBe(true);
    expect(findFlexZoneForRoute(flexRoute, zones, routes)?.id).toBe('zone-1');
  });

  it('detects a 715 route with no zone attached', () => {
    const flexRoute = route();
    expect(isFlexRoute(flexRoute, [], [flexRoute])).toBe(true);
    expect(findFlexZoneForRoute(flexRoute, [], [flexRoute])).toBeUndefined();
  });

  it('falls back to name matching for a legacy zone with no routeId', () => {
    const legacy = route({ route_type: 3 });
    const zones = [zone()];
    const routes = [legacy, fixedRoute];
    expect(isFlexRoute(legacy, zones, routes)).toBe(true);
    expect(findFlexZoneForRoute(legacy, zones, routes)?.id).toBe('zone-1');
  });

  it('does not treat a plain fixed route as flex', () => {
    const flexRoute = route();
    const routes = [flexRoute, fixedRoute];
    expect(isFlexRoute(fixedRoute, [zone({ routeId: 'r-flex' })], routes)).toBe(false);
    expect(findFlexZoneForRoute(fixedRoute, [zone({ routeId: 'r-flex' })], routes)).toBeUndefined();
    expect(isFlexRoute(fixedRoute, [], routes)).toBe(false);
  });

  it('never pairs a zone that already points at another route', () => {
    const flexRoute = route();
    const lookalike = route({ route_id: 'r-other', route_type: 3 });
    const zones = [zone({ routeId: 'r-flex' })];
    const routes = [flexRoute, lookalike];
    expect(findFlexZoneForRoute(lookalike, zones, routes)).toBeUndefined();
    expect(isFlexRoute(lookalike, zones, routes)).toBe(false);
  });
});
