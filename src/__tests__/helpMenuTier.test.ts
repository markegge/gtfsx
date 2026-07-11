/**
 * Unit tests for the planRank / isPaidPlan tier-gating helpers used
 * by the FloatingHelp hover menu.
 *
 * Gate rule: the support-email row is shown for paid plans (agency,
 * enterprise) but NOT for free-tier or anonymous users.
 */
import { describe, expect, it } from 'vitest';
import { planRank, isPaidPlan } from '../utils/planRank';
import type { Plan } from '../services/billingApi';

describe('planRank', () => {
  it('assigns ascending ranks free < agency < enterprise', () => {
    expect(planRank('free')).toBeLessThan(planRank('agency'));
    expect(planRank('agency')).toBeLessThan(planRank('enterprise'));
  });

  it('returns 0 for null', () => {
    expect(planRank(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(planRank(undefined)).toBe(0);
  });
});

describe('isPaidPlan — support-email gate', () => {
  const paid: Plan[] = ['agency', 'enterprise'];
  const notPaid: Array<Plan | null | undefined> = ['free', null, undefined];

  for (const plan of paid) {
    it(`returns true for ${plan} (shows support email)`, () => {
      expect(isPaidPlan(plan)).toBe(true);
    });
  }

  for (const plan of notPaid) {
    it(`returns false for ${String(plan)} (hides support email)`, () => {
      expect(isPaidPlan(plan)).toBe(false);
    });
  }
});
