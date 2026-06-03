// Guards the Pricing v3 (Jun 2026) feature reallocation: demand dots free for
// all; route-level analysis stays Agency+; phone support → Agency+; embed badge
// removal is Agency+ white-label. See worker/billing/plans.ts + the handoff
// handoffs/pricing-v3-feature-reallocation.md.
import { describe, expect, it } from 'vitest';
import { planHasFeature } from '../billing/plans';
import { embedFooter } from '../embeds/layout';

describe('Pricing v3 entitlements', () => {
  it('demand dots (analysis_propensity) are free for everyone', () => {
    expect(planHasFeature('free', 'analysis_propensity')).toBe(true);
    expect(planHasFeature('pro', 'analysis_propensity')).toBe(true);
    expect(planHasFeature('agency', 'analysis_propensity')).toBe(true);
  });

  it('route-level analysis (analysis_basic) stays Agency+', () => {
    expect(planHasFeature('free', 'analysis_basic')).toBe(false);
    expect(planHasFeature('pro', 'analysis_basic')).toBe(false);
    expect(planHasFeature('agency', 'analysis_basic')).toBe(true);
  });

  it('phone support is Agency+', () => {
    expect(planHasFeature('pro', 'phone_support')).toBe(false);
    expect(planHasFeature('agency', 'phone_support')).toBe(true);
    expect(planHasFeature('enterprise', 'phone_support')).toBe(true);
  });

  it('embed badge removal is Agency+ (Pro keeps the badge)', () => {
    expect(planHasFeature('free', 'embed_remove_badge')).toBe(false);
    expect(planHasFeature('pro', 'embed_remove_badge')).toBe(false);
    expect(planHasFeature('agency', 'embed_remove_badge')).toBe(true);
    expect(planHasFeature('enterprise', 'embed_remove_badge')).toBe(true);
  });

  it('embeds themselves remain Pro+', () => {
    expect(planHasFeature('free', 'embeds')).toBe(false);
    expect(planHasFeature('pro', 'embeds')).toBe(true);
  });
});

describe('embed badge by owner plan', () => {
  it('renders the "Powered by GTFS·X" badge for a Pro-owned feed', () => {
    expect(String(embedFooter('pro'))).toContain('Powered by');
  });

  it('omits the badge for an Agency-owned (white-label) feed', () => {
    expect(String(embedFooter('agency'))).toBe('');
    expect(String(embedFooter('enterprise'))).toBe('');
  });
});
