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
 * Examples:
 *   Pro:    annualToMonthlyEquivalent(499)  → 42   (499 / 12 = 41.58…)
 *   Agency: annualToMonthlyEquivalent(2499) → 208  (2499 / 12 = 208.25)
 */
export function annualToMonthlyEquivalent(annualTotal: number): number {
  return Math.round(annualTotal / 12);
}

/**
 * Annual savings vs. paying month-to-month.
 * Returns 0 when annual costs as much or more (shouldn't happen, but defensive).
 *
 * Examples:
 *   Pro:    annualSavings(49, 499)   → 89   (49*12=588, 588-499=89)
 *   Agency: annualSavings(299, 2499) → 1089 (299*12=3588, 3588-2499=1089)
 */
export function annualSavings(monthlyPrice: number, annualTotal: number): number {
  return Math.max(0, monthlyPrice * 12 - annualTotal);
}
