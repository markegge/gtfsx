// Zone naming across the four creation paths (GH #60). Drawing minted "Zone 1",
// the route buffer minted "Service Area 1" off a module-level counter, and the
// stop-group path minted "Stop Group N" off the zone count — three nouns for one
// object, and two of them could collide on the same number. Every path now goes
// through nextFlexZoneName, whose numbering is derived from the zones that exist
// rather than from a counter, so these pin the noun and the no-collision rule.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../store';
import { createFlexZoneWithRoute, nextFlexZoneName } from '../../components/flex/flexHelpers';
import type { FlexZone } from '../../store/flexSlice';

const emptyGeojson: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function zonesNamed(...names: string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

describe('nextFlexZoneName', () => {
  it('names the first zone "Service Area 1"', () => {
    expect(nextFlexZoneName([])).toBe('Service Area 1');
  });

  it('counts up past the names already taken', () => {
    expect(nextFlexZoneName(zonesNamed('Service Area 1'))).toBe('Service Area 2');
    expect(nextFlexZoneName(zonesNamed('Service Area 1', 'Service Area 2'))).toBe('Service Area 3');
  });

  it('fills a gap left by a deleted zone instead of colliding', () => {
    expect(nextFlexZoneName(zonesNamed('Service Area 1', 'Service Area 3'))).toBe('Service Area 2');
  });

  it('ignores user-renamed zones when numbering', () => {
    expect(nextFlexZoneName(zonesNamed('Northside Dial-a-Ride'))).toBe('Service Area 1');
  });
});

describe('flex zone creation paths', () => {
  beforeEach(() => {
    useStore.setState({ flexZones: [], routes: [], trips: [], stopTimes: [] });
  });

  // The four paths differ only in the geometry they hand to createFlexZoneWithRoute
  // (drawn polygon / buffered polygon / stop group / imported boundary); each one
  // asks nextFlexZoneName for its name against the live zone list.
  const createFromPath = (path: 'draw' | 'buffer' | 'group' | 'import') => {
    const zones = useStore.getState().flexZones;
    const base: Omit<FlexZone, 'routeId'> = {
      id: `flex-${path}-${zones.length}`,
      name: nextFlexZoneName(zones),
      bufferMiles: path === 'buffer' ? 0.75 : 0,
      geojson: emptyGeojson,
      ...(path === 'group' ? { stopIds: [] } : {}),
    };
    createFlexZoneWithRoute(base);
  };

  it('gives every path the same noun and one shared number sequence', () => {
    createFromPath('draw');
    createFromPath('group');
    createFromPath('buffer');
    createFromPath('import');

    const names = useStore.getState().flexZones.map((z) => z.name);
    expect(names).toEqual([
      'Service Area 1',
      'Service Area 2',
      'Service Area 3',
      'Service Area 4',
    ]);
    expect(new Set(names).size).toBe(4);
  });

  it('names the paired route after the zone', () => {
    createFromPath('draw');
    const zone = useStore.getState().flexZones[0];
    const route = useStore.getState().routes.find((r) => r.route_id === zone.routeId);
    expect(route?.route_long_name).toBe('Service Area 1');
  });

  // The zone id is the location_id the exporter writes as the top-level `id` of
  // the zone's locations.geojson Feature — the Details panel surfaces it verbatim.
  it('keeps the zone id stable as the location_id shown in Details', () => {
    createFromPath('draw');
    const zone = useStore.getState().flexZones[0];
    expect(zone.id).toBe('flex-draw-0');
  });
});
