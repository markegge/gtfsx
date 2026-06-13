/**
 * Unit tests for pricing computation helpers.
 * Covers the annual-to-monthly-equivalent display logic used in PricingPage.
 */
import { describe, expect, it } from 'vitest';
import { annualToMonthlyEquivalent, annualSavings } from '../components/billing/pricingUtils';

describe('annualToMonthlyEquivalent', () => {
  it('Pro: $499/yr → $42/month', () => {
    expect(annualToMonthlyEquivalent(499)).toBe(42);
  });

  it('Agency: $2499/yr → $208/month', () => {
    expect(annualToMonthlyEquivalent(2499)).toBe(208);
  });

  it('Free: $0/yr → $0/month', () => {
    expect(annualToMonthlyEquivalent(0)).toBe(0);
  });

  it('rounds 0.5 up', () => {
    // 18 / 12 = 1.5 → rounds up to 2
    expect(annualToMonthlyEquivalent(18)).toBe(2);
  });

  it('rounds down when fractional part < 0.5', () => {
    // 13 / 12 = 1.083… → rounds down to 1
    expect(annualToMonthlyEquivalent(13)).toBe(1);
  });
});

describe('annualSavings', () => {
  it('Pro: 49*12=588, 588-499=89 saved', () => {
    expect(annualSavings(49, 499)).toBe(89);
  });

  it('Agency: 299*12=3588, 3588-2499=1089 saved', () => {
    expect(annualSavings(299, 2499)).toBe(1089);
  });

  it('Free: $0 saved', () => {
    expect(annualSavings(0, 0)).toBe(0);
  });

  it('returns 0 when annual equals monthly*12 (no discount)', () => {
    expect(annualSavings(10, 120)).toBe(0);
  });

  it('returns 0 (not negative) when annual exceeds monthly*12 (defensive)', () => {
    expect(annualSavings(10, 130)).toBe(0);
  });
});
