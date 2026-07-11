/**
 * Plan rank helpers — shared by FloatingHelp and any other component that
 * needs to compare plan tiers without pulling in billing UI dependencies.
 *
 * Plans in ascending order: free < agency < enterprise.
 * "Paid" means any plan at rank >= agency (i.e. agency or enterprise).
 *
 * Keep this file framework-free (.ts, not .tsx) so it can be imported in
 * unit tests without a DOM or React context.
 */
import type { Plan } from '../services/billingApi';

const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  agency: 1,
  enterprise: 2,
};

/** Returns the numeric rank for a plan (0 = free, 2 = enterprise). */
export function planRank(plan: Plan | null | undefined): number {
  if (!plan) return 0;
  return PLAN_RANK[plan] ?? 0;
}

/**
 * Returns true if the plan is a paid tier (agency or enterprise).
 * Passing null / undefined / 'free' returns false.
 */
export function isPaidPlan(plan: Plan | null | undefined): boolean {
  return planRank(plan) >= planRank('agency');
}
