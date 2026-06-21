// Flex service-area rename: a GTFS-Flex service area is materialized as a route
// (createFlexZoneWithRoute), so renaming that route in the Routes panel must
// rename the area shape itself — and that name must round-trip into the
// GTFS-Flex export (locations.geojson stop_name + location_groups.txt name).
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { useStore } from '../../store';
import { exportGtfsZip } from '../gtfsExport';
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
      route_short_name: 'Service Area 1', route_long_name: 'Service Area 1 (Flex)',
      route_type: 3,
    } as never,
  ]);
  s.addFlexZone({
    id: 'fz', name: 'Service Area 1', bufferMiles: 0,
    geojson: SQUARE, routeId: 'fz-route',
    serviceId: 'wk', pickupWindowStart: '08:00:00', pickupWindowEnd: '17:00:00',
    ...extra,
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
