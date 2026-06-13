/**
 * Plan rank helpers — shared by FloatingHelp and any other component that
 * needs to compare plan tiers without pulling in billing UI dependencies.
 *
 * Plans in ascending order: free < pro < agency < enterprise.
 * "Pro+" means any plan at rank >= pro (i.e. pro, agency, or enterprise).
 *
 * Keep this file framework-free (.ts, not .tsx) so it can be imported in
 * unit tests without a DOM or React context.
 */
import type { Plan } from '../services/billingApi';

const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  pro: 1,
  agency: 2,
  enterprise: 3,
};

/** Returns the numeric rank for a plan (0 = free, 3 = enterprise). */
export function planRank(plan: Plan | null | undefined): number {
  if (!plan) return 0;
  return PLAN_RANK[plan] ?? 0;
}

/**
 * Returns true if the plan is Pro or higher (pro, agency, enterprise).
 * Passing null / undefined / 'free' returns false.
 */
export function isPlanAtLeastPro(plan: Plan | null | undefined): boolean {
  return planRank(plan) >= planRank('pro');
}
