/**
 * Pure pricing computation helpers for the pricing page.
 * Extracted into a separate .ts module so they can be unit-tested
 * independently of React (no non-component exports in .tsx).
 */

import type { Plan } from '../../services/billingApi';

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

/**
 * Lifecycle of the auto-checkout redirect modal. When the pricing page is
 * reached with a `?plan=` deep-link (the /planning trial CTA, or the
 * post-signup resume) it auto-fires Stripe Checkout; this modal covers the page
 * so the redirect never feels like an unexplained yank to stripe.com.
 *   'idle'     — no auto-checkout in flight; modal hidden.
 *   'starting' — creating the Checkout session, about to hand off to Stripe.
 *   'error'    — the create failed; show the message + Retry/Close.
 */
export type AutoCheckoutPhase = 'idle' | 'starting' | 'error';

export interface RedirectModalState {
  /** Whether the covering modal is mounted at all. */
  open: boolean;
  /** Spinner while redirecting; error card once the create fails. */
  variant: 'spinner' | 'error';
}

/** Pure view-state for the auto-checkout redirect modal (the tested seam). */
export function redirectModalState(phase: AutoCheckoutPhase): RedirectModalState {
  return {
    open: phase !== 'idle',
    variant: phase === 'error' ? 'error' : 'spinner',
  };
}

export interface RedirectModalCopy {
  title: string;
  body: string;
}

/**
 * Spinner-state copy for the Stripe Checkout hand-off. This modal now covers
 * only the DIRECT "subscribe now with a card" path — the 14-day trial happens
 * in-app with no card, so this copy no longer promises a trial. `planName` is
 * the display name (e.g. from planDisplayName).
 */
export function redirectModalCopy(_plan: Plan | null, planName: string): RedirectModalCopy {
  return {
    title: `Setting up ${planName}`,
    body: "Redirecting you to Stripe's secure checkout…",
  };
}
