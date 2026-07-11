// Guards the Pricing v4 (Jul 2026) entitlement matrix: the Pro tier is
// retired; everything that was Pro+ is now Agency+ (displayed as "Planner"),
// except geojson_export which is free on every plan. Demand dots stay free
// for everyone. See worker/billing/plans.ts.
import { describe, expect, it } from 'vitest';
import { planHasFeature, cheapestPlanFor } from '../billing/plans';
import { embedFooter } from '../embeds/layout';

describe('Pricing v4 entitlements', () => {
  it('demand dots (analysis_propensity) are free for everyone', () => {
    expect(planHasFeature('free', 'analysis_propensity')).toBe(true);
    expect(planHasFeature('agency', 'analysis_propensity')).toBe(true);
    expect(planHasFeature('enterprise', 'analysis_propensity')).toBe(true);
  });

  it('GeoJSON export is free on every plan', () => {
    expect(planHasFeature('free', 'geojson_export')).toBe(true);
    expect(planHasFeature('agency', 'geojson_export')).toBe(true);
    expect(planHasFeature('enterprise', 'geojson_export')).toBe(true);
  });

  it('publishing, embeds, draft links, snapshots, and brand color are Agency+', () => {
    for (const feature of [
      'managed_publishing',
      'draft_links',
      'mobility_db_submit',
      'embeds',
      'snapshot_history',
      'brand_color',
    ] as const) {
      expect(planHasFeature('free', feature)).toBe(false);
      expect(planHasFeature('agency', feature)).toBe(true);
      expect(planHasFeature('enterprise', feature)).toBe(true);
    }
  });

  it('route-level analysis (analysis_basic) stays Agency+', () => {
    expect(planHasFeature('free', 'analysis_basic')).toBe(false);
    expect(planHasFeature('agency', 'analysis_basic')).toBe(true);
  });

  it('network walksheds (Mapbox isochrone coverage) are Agency+', () => {
    expect(planHasFeature('free', 'network_walksheds')).toBe(false);
    expect(planHasFeature('agency', 'network_walksheds')).toBe(true);
    expect(planHasFeature('enterprise', 'network_walksheds')).toBe(true);
  });

  it('phone support is Agency+', () => {
    expect(planHasFeature('free', 'phone_support')).toBe(false);
    expect(planHasFeature('agency', 'phone_support')).toBe(true);
    expect(planHasFeature('enterprise', 'phone_support')).toBe(true);
  });

  it('embed badge removal is Agency+', () => {
    expect(planHasFeature('free', 'embed_remove_badge')).toBe(false);
    expect(planHasFeature('agency', 'embed_remove_badge')).toBe(true);
    expect(planHasFeature('enterprise', 'embed_remove_badge')).toBe(true);
  });

  it('paywall deep-links recommend agency for previously-Pro features', () => {
    expect(cheapestPlanFor('managed_publishing')).toBe('agency');
    expect(cheapestPlanFor('embeds')).toBe('agency');
    expect(cheapestPlanFor('geojson_export')).toBe('free');
    expect(cheapestPlanFor('analysis_propensity')).toBe('free');
  });
});

describe('embed badge by owner plan', () => {
  it('renders the "Powered by GTFS·X" badge for a free-owned feed', () => {
    expect(String(embedFooter('free'))).toContain('Powered by');
  });

  it('omits the badge for an Agency-owned (white-label) feed', () => {
    expect(String(embedFooter('agency'))).toBe('');
    expect(String(embedFooter('enterprise'))).toBe('');
  });
});
