// Flex service-area rename: a GTFS-Flex service area is materialized as a route
// (createFlexZoneWithRoute), so renaming that route in the Routes panel must
// rename the area shape itself — and that name must round-trip into the
// GTFS-Flex export (locations.geojson stop_name + location_groups.txt name).
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
import {
  createFlexZoneWithRoute,
  findFlexZoneRoute,
  flexRouteNames,
  routeMatchesFlexZoneName,
} from '../../components/flex/flexHelpers';
import type { FlexZone } from '../../store/flexSlice';

const SQUARE: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[[-111, 45], [-111, 45.05], [-110.95, 45.05], [-110.95, 45], [-111, 45]]],
      },
    },
  ],
};

function seedFlexZone(extra?: Partial<FlexZone>): void {
  const s = useStore.getState();
  s.setRoutes([
    {
      route_id: 'fz-route', agency_id: 'A',
      ...flexRouteNames('Service Area 1'),
      route_type: 715,
    } as never,
  ]);
  s.addFlexZone({
    id: 'fz', name: 'Service Area 1', bufferMiles: 0,
    geojson: SQUARE, routeId: 'fz-route',
    serviceId: 'wk', pickupWindowStart: '08:00:00', pickupWindowEnd: '17:00:00',
    ...extra,
  });
}

/** A zone as feeds built before the long-name-only switch stored it: the route
 *  named short = "<name>" / long = "<name> (Flex)", and no routeId on the zone. */
function seedLegacyFlexZone(): void {
  const s = useStore.getState();
  s.setRoutes([
    {
      route_id: 'legacy-route', agency_id: 'A',
      route_short_name: 'Service Area 1', route_long_name: 'Service Area 1 (Flex)',
      route_type: 3,
    } as never,
  ]);
  s.addFlexZone({
    id: 'legacy-fz', name: 'Service Area 1', bufferMiles: 0,
    geojson: SQUARE,
    serviceId: 'wk', pickupWindowStart: '08:00:00', pickupWindowEnd: '17:00:00',
  });
}

beforeEach(() => {
  const s = useStore.getState();
  s.setAgencies([{ agency_id: 'A', agency_name: 'A', agency_url: 'https://x.test', agency_timezone: 'America/Denver' } as never]);
  s.setCalendars([{ service_id: 'wk', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231' } as never]);
  s.setRoutes([]);
  s.setFlexZones([]);
  s.setStops([]);
  s.setTrips([]);
  s.setStopTimes([]);
});

describe('flex service-area rename', () => {
  it('renaming the materialized route renames the linked flex zone', () => {
    seedFlexZone();
    useStore.getState().updateRoute('fz-route', { route_short_name: 'Downtown On-Demand' });
    expect(useStore.getState().flexZones.find((z) => z.id === 'fz')?.name).toBe('Downtown On-Demand');
  });

  it('ignores blank names and leaves unrelated routes\' zones untouched', () => {
    seedFlexZone();
    // A blank short name must not wipe the zone's name.
    useStore.getState().updateRoute('fz-route', { route_short_name: '   ' });
    expect(useStore.getState().flexZones.find((z) => z.id === 'fz')?.name).toBe('Service Area 1');
    // Renaming a route that no flex zone is linked to leaves the zone alone.
    useStore.getState().setRoutes([
      ...useStore.getState().routes,
      { route_id: 'other', agency_id: 'A', route_short_name: 'Bus 9', route_long_name: '', route_type: 3 } as never,
    ]);
    useStore.getState().updateRoute('other', { route_short_name: 'Renamed Bus' });
    expect(useStore.getState().flexZones.find((z) => z.id === 'fz')?.name).toBe('Service Area 1');
  });

  it('flows the renamed name into the GTFS-Flex export (locations.geojson + location_groups.txt)', async () => {
    // Mixed zone: polygon (→ locations.geojson) + stop group (→ location_groups.txt).
    useStore.getState().setStops([
      { stop_id: 's1', stop_name: 'A', stop_lat: 45, stop_lon: -111, wheelchair_boarding: 0 } as never,
    ]);
    seedFlexZone({ stopIds: ['s1'] });
    useStore.getState().updateRoute('fz-route', { route_short_name: 'Downtown On-Demand' });

    const blob = await exportGtfsZip();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());

    const locations = JSON.parse(await zip.file('locations.geojson')!.async('string')) as GeoJSON.FeatureCollection;
    expect((locations.features[0].properties as Record<string, unknown>).stop_name).toBe('Downtown On-Demand');

    const groups = await zip.file('location_groups.txt')!.async('string');
    expect(groups).toContain('Downtown On-Demand');
    expect(groups).not.toContain('Service Area 1');
  });
});

describe('flex route naming', () => {
  it('names a new zone\'s route long-name-only (no route_short_name)', async () => {
    createFlexZoneWithRoute({
      id: 'new-fz', name: 'Northside Dial-a-Ride', bufferMiles: 0, geojson: SQUARE,
      pickupWindowStart: '08:00:00', pickupWindowEnd: '17:00:00',
    });
    const zone = useStore.getState().flexZones.find((z) => z.id === 'new-fz')!;
    const route = useStore.getState().routes.find((r) => r.route_id === zone.routeId)!;
    expect(route.route_long_name).toBe('Northside Dial-a-Ride');
    expect(route.route_short_name).toBe('');
    expect(route.route_type).toBe(715);

    // …and the exported row carries no short name, so route_long_name can't
    // contain it (route_long_name_contains_short_name).
    const blob = await exportGtfsZip();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const rows = Papa.parse<Record<string, string>>(
      await zip.file('routes.txt')!.async('string'),
      { header: true, skipEmptyLines: true },
    ).data;
    const row = rows.find((r) => r.route_id === zone.routeId)!;
    expect(row.route_long_name).toBe('Northside Dial-a-Ride');
    expect(row.route_short_name ?? '').toBe('');
  });

  it('synthesizes a long-name-only route for a zone with no route', async () => {
    useStore.getState().addFlexZone({
      id: 'orphan', name: 'Rural Connector', bufferMiles: 0, geojson: SQUARE,
      serviceId: 'wk', pickupWindowStart: '08:00:00', pickupWindowEnd: '17:00:00',
    });
    const blob = await exportGtfsZip();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const rows = Papa.parse<Record<string, string>>(
      await zip.file('routes.txt')!.async('string'),
      { header: true, skipEmptyLines: true },
    ).data;
    expect(rows).toHaveLength(1);
    expect(rows[0].route_long_name).toBe('Rural Connector');
    expect(rows[0].route_short_name ?? '').toBe('');
  });

  it('renaming a zone renames the paired route\'s long name', () => {
    seedFlexZone();
    // Mirrors FlexEditor.commitRename: the zone is the source of truth, the
    // route follows via flexRouteNames.
    useStore.getState().updateFlexZone('fz', { name: 'Downtown On-Demand' });
    useStore.getState().updateRoute('fz-route', flexRouteNames('Downtown On-Demand'));
    const route = useStore.getState().routes.find((r) => r.route_id === 'fz-route')!;
    expect(route.route_long_name).toBe('Downtown On-Demand');
    expect(route.route_short_name).toBe('');
    expect(useStore.getState().flexZones.find((z) => z.id === 'fz')?.name).toBe('Downtown On-Demand');
  });

  it('still pairs a legacy "<name>" / "<name> (Flex)" route with its zone', () => {
    seedLegacyFlexZone();
    const { routes, flexZones } = useStore.getState();
    const zone = flexZones.find((z) => z.id === 'legacy-fz')!;
    expect(zone.routeId).toBeUndefined();
    expect(findFlexZoneRoute(routes, zone)?.route_id).toBe('legacy-route');

    expect(routeMatchesFlexZoneName(
      { route_short_name: 'Service Area 1', route_long_name: 'Service Area 1 (Flex)' },
      'Service Area 1',
    )).toBe(true);
    expect(routeMatchesFlexZoneName(flexRouteNames('Service Area 1'), 'Service Area 1')).toBe(true);
    expect(routeMatchesFlexZoneName(flexRouteNames('Other Area'), 'Service Area 1')).toBe(false);
  });

  it('prefers the zone\'s routeId over a same-named route', () => {
    seedFlexZone();
    useStore.getState().setRoutes([
      ...useStore.getState().routes,
      {
        route_id: 'decoy', agency_id: 'A',
        route_short_name: 'Service Area 1', route_long_name: '', route_type: 3,
      } as never,
    ]);
    const { routes, flexZones } = useStore.getState();
    const zone = flexZones.find((z) => z.id === 'fz')!;
    expect(findFlexZoneRoute(routes, zone)?.route_id).toBe('fz-route');
  });
});
