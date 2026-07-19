/**
 * Unit tests for pricing computation helpers.
 * Covers the annual-to-monthly-equivalent display logic used in PricingPage.
 */
import { describe, expect, it } from 'vitest';
import {
  annualToMonthlyEquivalent,
  annualSavings,
  redirectModalState,
  redirectModalCopy,
} from '../components/billing/pricingUtils';

describe('annualToMonthlyEquivalent', () => {
  it('Planner: $2988/yr → $249/month', () => {
    expect(annualToMonthlyEquivalent(2988)).toBe(249);
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
  it('Planner: 299*12=3588, 3588-2988=600 saved', () => {
    expect(annualSavings(299, 2988)).toBe(600);
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

describe('redirectModalState', () => {
  it('idle → modal hidden (no auto-checkout in flight)', () => {
    expect(redirectModalState('idle')).toEqual({ open: false, variant: 'spinner' });
  });

  it('starting → modal shown with the spinner (auto-trigger seam)', () => {
    // The auto-trigger path flips the phase to "starting", which must open the
    // covering modal so the Stripe hand-off is never an unexplained redirect.
    expect(redirectModalState('starting')).toEqual({ open: true, variant: 'spinner' });
  });

  it('error → modal stays open but swaps to the error state (never a stuck spinner)', () => {
    expect(redirectModalState('error')).toEqual({ open: true, variant: 'error' });
  });
});

describe('redirectModalCopy', () => {
  // The Stripe redirect modal now covers only the DIRECT subscribe path — the
  // 14-day trial happens in-app with no card — so it never promises a trial.
  it('Planner (agency) frames the redirect as setting the plan up (no trial promise)', () => {
    expect(redirectModalCopy('agency', 'Planner').title).toBe('Setting up Planner');
  });

  it('a non-trial plan frames it as setting that plan up', () => {
    expect(redirectModalCopy('enterprise', 'Enterprise').title).toBe('Setting up Enterprise');
  });

  it('falls back gracefully when the plan is unknown', () => {
    expect(redirectModalCopy(null, 'your plan').title).toBe('Setting up your plan');
  });

  it('body always names Stripe secure checkout', () => {
    expect(redirectModalCopy('agency', 'Planner').body).toContain("Stripe's secure checkout");
  });
});
