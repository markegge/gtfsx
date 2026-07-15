/**
 * Pure pricing computation helpers for the pricing page.
 * Extracted into a separate .ts module so they can be unit-tested
 * independently of React (no non-component exports in .tsx).
 */

/**
 * Per-month-equivalent price for an annual plan.
 * Rounds to the nearest whole dollar (matches the design aesthetic
 * where all prices are whole numbers).
 *
 * Example:
 *   Planner: annualToMonthlyEquivalent(2988) → 249  (2988 / 12 = 249)
 */
export function annualToMonthlyEquivalent(annualTotal: number): number {
  return Math.round(annualTotal / 12);
}

/**
 * Annual savings vs. paying month-to-month.
 * Returns 0 when annual costs as much or more (shouldn't happen, but defensive).
 *
 * Example:
 *   Planner: annualSavings(299, 2988) → 600  (299*12=3588, 3588-2988=600)
 */
export function annualSavings(monthlyPrice: number, annualTotal: number): number {
  return Math.max(0, monthlyPrice * 12 - annualTotal);
}
