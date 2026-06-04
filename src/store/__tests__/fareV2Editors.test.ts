// GTFS-Fares v2 — remaining editors (#32): rider categories, fare media,
// fare products, networks/route_networks, timeframes, leg + transfer rules.
// CRUD (with cascading FK maintenance) and validation.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../index';
import { runValidation } from '../../services/validation';
import type { Stop, Route, Calendar } from '../../types/gtfs';

function stop(id: string): Stop {
  return { stop_id: id, stop_name: id, stop_lat: 45, stop_lon: -111 } as Stop;
}
function route(id: string): Route {
  return { route_id: id, route_short_name: id, route_long_name: id, route_type: 3 } as Route;
}
function cal(id: string): Calendar {
  return {
    service_id: id, monday: 1, tuesday: 1, wednesday: 1, thursday: 1,
    friday: 1, saturday: 0, sunday: 0, start_date: '20260101', end_date: '20261231',
  } as Calendar;
}

function reset() {
  const s = useStore.getState();
  s.setFeatureSettings({});
  s.setFareAreas([]); s.setStopAreas([]);
  s.setFareNetworks([]); s.setRouteNetworks([]);
  s.setTimeframes([]); s.setRiderCategories([]);
  s.setFareMedia([]); s.setFareProducts([]);
  s.setFareLegRules([]); s.setFareTransferRules([]);
  s.setStops([]); s.setRoutes([]); s.setCalendars([]); s.setCalendarDates([]);
}
beforeEach(reset);
afterEach(reset);

const errs = () => runValidation(useStore.getState()).filter((m) => m.severity === 'error');
const warns = () => runValidation(useStore.getState()).filter((m) => m.severity === 'warning');

describe('rider categories CRUD', () => {
  it('adds, dedups, updates, and renames cascading to products', () => {
    const s = useStore.getState();
    s.addRiderCategory({ rider_category_id: 'adult', rider_category_name: 'Adult' });
    s.addRiderCategory({ rider_category_id: 'adult', rider_category_name: 'Dup' });
    expect(useStore.getState().riderCategories).toHaveLength(1);

    s.addFareProduct({ fare_product_id: 'p1', amount: '2.5', currency: 'USD', rider_category_id: 'adult' });
    s.renameRiderCategoryId('adult', 'reg');
    const st = useStore.getState();
    expect(st.riderCategories[0].rider_category_id).toBe('reg');
    expect(st.fareProducts[0].rider_category_id).toBe('reg');
  });

  it('delete clears the reference on products', () => {
    const s = useStore.getState();
    s.addRiderCategory({ rider_category_id: 'snr', rider_category_name: 'Senior' });
    s.addFareProduct({ fare_product_id: 'p1', amount: '1', currency: 'USD', rider_category_id: 'snr' });
    s.removeRiderCategory('snr');
    const st = useStore.getState();
    expect(st.riderCategories).toHaveLength(0);
    expect(st.fareProducts[0].rider_category_id).toBeUndefined();
  });
});

describe('fare media CRUD', () => {
  it('adds, dedups, renames cascading to products, deletes clearing the ref', () => {
    const s = useStore.getState();
    s.addFareMediaItem({ fare_media_id: 'cash', fare_media_type: 0 });
    s.addFareMediaItem({ fare_media_id: 'cash', fare_media_type: 1 });
    expect(useStore.getState().fareMedia).toHaveLength(1);

    s.addFareProduct({ fare_product_id: 'p1', amount: '1', currency: 'USD', fare_media_id: 'cash' });
    s.renameFareMediaId('cash', 'coin');
    expect(useStore.getState().fareProducts[0].fare_media_id).toBe('coin');

    s.removeFareMediaItem('coin');
    expect(useStore.getState().fareMedia).toHaveLength(0);
    expect(useStore.getState().fareProducts[0].fare_media_id).toBeUndefined();
  });
});

describe('fare products CRUD', () => {
  it('rename cascades to leg + transfer rules', () => {
    const s = useStore.getState();
    s.addFareProduct({ fare_product_id: 'p1', amount: '2', currency: 'USD' });
    s.addFareLegRule({ leg_group_id: 'lg1', fare_product_id: 'p1' });
    s.addFareTransferRule({ fare_transfer_type: 1, fare_product_id: 'p1' });
    s.renameFareProductId('p1', 'single');
    const st = useStore.getState();
    expect(st.fareLegRules[0].fare_product_id).toBe('single');
    expect(st.fareTransferRules[0].fare_product_id).toBe('single');
  });

  it('delete drops leg rules pointing at it and clears transfer-rule refs', () => {
    const s = useStore.getState();
    s.addFareProduct({ fare_product_id: 'p1', amount: '2', currency: 'USD' });
    s.addFareLegRule({ leg_group_id: 'lg1', fare_product_id: 'p1' });
    s.addFareTransferRule({ fare_transfer_type: 2, fare_product_id: 'p1' });
    s.removeFareProduct('p1');
    const st = useStore.getState();
    expect(st.fareLegRules).toHaveLength(0);
    expect(st.fareTransferRules[0].fare_product_id).toBeUndefined();
  });
});

describe('networks + route_networks CRUD', () => {
  it('assigns routes (one network per route), renames + deletes cascading', () => {
    const s = useStore.getState();
    s.addFareNetwork({ network_id: 'n1', network_name: 'Local' });
    s.addFareNetwork({ network_id: 'n2' });
    s.addRouteToNetwork('n1', 'r1');
    s.addRouteToNetwork('n1', 'r1'); // dedup
    expect(useStore.getState().routeNetworks).toHaveLength(1);

    // Reassigning a route moves it (one network per route).
    s.addRouteToNetwork('n2', 'r1');
    const rn = useStore.getState().routeNetworks;
    expect(rn).toHaveLength(1);
    expect(rn[0].network_id).toBe('n2');

    // Rename cascades to route_networks + leg rules.
    s.addFareLegRule({ leg_group_id: 'lg1', fare_product_id: 'p1', network_id: 'n2' });
    s.renameFareNetworkId('n2', 'express');
    const st = useStore.getState();
    expect(st.routeNetworks[0].network_id).toBe('express');
    expect(st.fareLegRules[0].network_id).toBe('express');

    // Delete removes mappings and clears leg-rule ref.
    s.removeFareNetwork('express');
    const st2 = useStore.getState();
    expect(st2.routeNetworks).toHaveLength(0);
    expect(st2.fareLegRules[0].network_id).toBeUndefined();
  });
});

describe('timeframes CRUD', () => {
  it('adds index-keyed rows, updates, removes, renames group cascading to leg rules', () => {
    const s = useStore.getState();
    s.addTimeframe({ timeframe_group_id: 'peak', service_id: 'wk' });
    s.addTimeframe({ timeframe_group_id: 'peak', service_id: 'wk', start_time: '06:00:00', end_time: '09:00:00' });
    expect(useStore.getState().timeframes).toHaveLength(2);

    s.updateTimeframe(0, { start_time: '15:00:00' });
    expect(useStore.getState().timeframes[0].start_time).toBe('15:00:00');

    s.addFareLegRule({ leg_group_id: 'lg', fare_product_id: 'p', from_timeframe_group_id: 'peak' });
    s.renameTimeframeGroupId('peak', 'rush');
    const st = useStore.getState();
    expect(st.timeframes.every((t) => t.timeframe_group_id === 'rush')).toBe(true);
    expect(st.fareLegRules[0].from_timeframe_group_id).toBe('rush');

    s.removeTimeframe(0);
    expect(useStore.getState().timeframes).toHaveLength(1);
  });
});

describe('leg + transfer rules CRUD', () => {
  it('adds, updates, and removes index-keyed rows', () => {
    const s = useStore.getState();
    s.addFareLegRule({ fare_product_id: 'p1' });
    s.updateFareLegRule(0, { leg_group_id: 'lg1' });
    expect(useStore.getState().fareLegRules[0].leg_group_id).toBe('lg1');
    s.removeFareLegRule(0);
    expect(useStore.getState().fareLegRules).toHaveLength(0);

    s.addFareTransferRule({ fare_transfer_type: 0 });
    s.updateFareTransferRule(0, { transfer_count: -1 });
    expect(useStore.getState().fareTransferRules[0].transfer_count).toBe(-1);
    s.removeFareTransferRule(0);
    expect(useStore.getState().fareTransferRules).toHaveLength(0);
  });
});

describe('fares v2 validation', () => {
  it('flags duplicate ids across files', () => {
    const s = useStore.getState();
    s.setFareNetworks([{ network_id: 'n1' }, { network_id: 'n1' }]);
    s.setRiderCategories([
      { rider_category_id: 'a', rider_category_name: 'A' },
      { rider_category_id: 'a', rider_category_name: 'A2' },
    ]);
    const m = errs();
    expect(m.some((x) => x.message.includes('network_id "n1"') && x.message.includes('unique'))).toBe(true);
    expect(m.some((x) => x.message.includes('rider_category_id "a"') && x.message.includes('unique'))).toBe(true);
  });

  it('flags a rider category missing its name', () => {
    useStore.getState().setRiderCategories([{ rider_category_id: 'a', rider_category_name: '' }]);
    expect(errs().some((m) => m.message.includes('missing rider_category_name'))).toBe(true);
  });

  it('flags a fare product missing amount/currency and bad FK refs', () => {
    const s = useStore.getState();
    s.setFareProducts([
      { fare_product_id: 'p1', amount: '', currency: '', rider_category_id: 'ghost', fare_media_id: 'ghost2' },
    ]);
    const m = errs();
    expect(m.some((x) => x.message.includes('missing an amount'))).toBe(true);
    expect(m.some((x) => x.message.includes('missing a currency'))).toBe(true);
    expect(m.some((x) => x.message.includes('non-existent rider category "ghost"'))).toBe(true);
    expect(m.some((x) => x.message.includes('non-existent fare medium "ghost2"'))).toBe(true);
  });

  it('flags route_networks orphans and a timeframe missing service', () => {
    const s = useStore.getState();
    s.setRoutes([route('r1')]);
    s.setRouteNetworks([{ network_id: 'ghost', route_id: 'r1' }, { network_id: 'ghost', route_id: 'rX' }]);
    s.setTimeframes([{ timeframe_group_id: 'peak', service_id: '' }]);
    const m = errs();
    expect(m.some((x) => x.message.includes('route_networks references non-existent network "ghost"'))).toBe(true);
    expect(m.some((x) => x.message.includes('route_networks references non-existent route "rX"'))).toBe(true);
    expect(m.some((x) => x.message.includes('missing service_id'))).toBe(true);
  });

  it('flags leg-rule FK problems and transfer-rule product requirement', () => {
    const s = useStore.getState();
    s.setFareLegRules([
      { leg_group_id: 'lg1', fare_product_id: 'ghostP', network_id: 'ghostN', from_area_id: 'ghostA' },
      { fare_product_id: '' },
    ]);
    s.setFareTransferRules([{ fare_transfer_type: 1 }]); // type 1 needs a product
    const m = errs();
    expect(m.some((x) => x.message.includes('non-existent fare product "ghostP"'))).toBe(true);
    expect(m.some((x) => x.message.includes('non-existent network "ghostN"'))).toBe(true);
    expect(m.some((x) => x.message.includes('non-existent from_area "ghostA"'))).toBe(true);
    expect(m.some((x) => x.message.includes('missing fare_product_id'))).toBe(true);
    expect(m.some((x) => x.message.includes('no fare_product_id'))).toBe(true);
  });

  it('warns on multiple default rider categories and multi-network routes', () => {
    const s = useStore.getState();
    s.setRiderCategories([
      { rider_category_id: 'a', rider_category_name: 'A', is_default_fare_category: 1 },
      { rider_category_id: 'b', rider_category_name: 'B', is_default_fare_category: 1 },
    ]);
    s.setRoutes([route('r1')]);
    s.setFareNetworks([{ network_id: 'n1' }, { network_id: 'n2' }]);
    s.setRouteNetworks([{ network_id: 'n1', route_id: 'r1' }, { network_id: 'n2', route_id: 'r1' }]);
    const w = warns();
    expect(w.some((x) => x.message.includes('is_default_fare_category'))).toBe(true);
    expect(w.some((x) => x.message.includes('more than one network'))).toBe(true);
  });

  it('is clean for a well-formed v2 pricing chain', () => {
    const s = useStore.getState();
    s.setStops([stop('s1'), stop('s2')]);
    s.setRoutes([route('r1')]);
    s.setCalendars([cal('wk')]);
    s.setFareAreas([{ area_id: 'dt' }]);
    s.setStopAreas([{ area_id: 'dt', stop_id: 's1' }]);
    s.setFareNetworks([{ network_id: 'local' }]);
    s.setRouteNetworks([{ network_id: 'local', route_id: 'r1' }]);
    s.setTimeframes([{ timeframe_group_id: 'peak', service_id: 'wk', start_time: '06:00:00', end_time: '09:00:00' }]);
    s.setRiderCategories([{ rider_category_id: 'adult', rider_category_name: 'Adult', is_default_fare_category: 1 }]);
    s.setFareMedia([{ fare_media_id: 'cash', fare_media_type: 0 }]);
    s.setFareProducts([{ fare_product_id: 'single', amount: '2.50', currency: 'USD', rider_category_id: 'adult', fare_media_id: 'cash' }]);
    s.setFareLegRules([{ leg_group_id: 'lg1', fare_product_id: 'single', network_id: 'local', from_area_id: 'dt', from_timeframe_group_id: 'peak' }]);
    s.setFareTransferRules([{ from_leg_group_id: 'lg1', to_leg_group_id: 'lg1', fare_transfer_type: 1, fare_product_id: 'single' }]);

    const v2Types = new Set([
      'area', 'stop_area', 'network', 'route_network', 'timeframe',
      'rider_category', 'fare_media', 'fare_product', 'fare_leg_rule', 'fare_transfer_rule',
    ]);
    const v2Errors = errs().filter((m) => m.entity_type && v2Types.has(m.entity_type));
    expect(v2Errors).toHaveLength(0);
  });
});
