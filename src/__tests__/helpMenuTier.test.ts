/**
 * Unit tests for the planRank / isPlanAtLeastPro tier-gating helpers used
 * by the FloatingHelp hover menu.
 *
 * Gate rule: the support-email row is shown for Pro+ (pro, agency, enterprise)
 * but NOT for free-tier or anonymous users.
 */
import { describe, expect, it } from 'vitest';
import { planRank, isPlanAtLeastPro } from '../utils/planRank';
import type { Plan } from '../services/billingApi';

describe('planRank', () => {
  it('assigns ascending ranks free < pro < agency < enterprise', () => {
    expect(planRank('free')).toBeLessThan(planRank('pro'));
    expect(planRank('pro')).toBeLessThan(planRank('agency'));
    expect(planRank('agency')).toBeLessThan(planRank('enterprise'));
  });

  it('returns 0 for null', () => {
    expect(planRank(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(planRank(undefined)).toBe(0);
  });
});

describe('isPlanAtLeastPro — support-email gate', () => {
  const proPlus: Plan[] = ['pro', 'agency', 'enterprise'];
  const notProPlus: Array<Plan | null | undefined> = ['free', null, undefined];

  for (const plan of proPlus) {
    it(`returns true for ${plan} (shows support email)`, () => {
      expect(isPlanAtLeastPro(plan)).toBe(true);
    });
  }

  for (const plan of notProPlus) {
    it(`returns false for ${String(plan)} (hides support email)`, () => {
      expect(isPlanAtLeastPro(plan)).toBe(false);
    });
  }
});
