// Regression guards for the 2026-06 checkout outage (handoffs/fix-stripe-checkout.md):
//   1. A raw Stripe error message can embed our secret key verbatim
//      ("Expired API Key provided: sk_live_…") — it must NEVER reach the browser.
//   2. The Planner (internal id 'agency') price IDs must resolve so checkout
//      hands Stripe a valid line item (a missing price ID was a silent failure mode).
//
// The end-to-end "a real Stripe Checkout page renders for Planner" check is
// done manually with the live/test key per the handoff's "Done = verified" — it
// needs a real Stripe secret, which (by design) isn't in the test bindings.

import { describe, it, expect, vi } from 'vitest';
import { stripeFailure } from '../billing/routes';
import { resolvePriceId } from '../billing/stripe';

describe('billing checkout — Stripe error hygiene', () => {
  it('never echoes the raw Stripe message (incl. the secret key) to the client', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leaky = {
      message: 'Expired API Key provided: sk_live_51AbCdEf************a1cjVy',
      code: 'api_key_expired',
      type: 'invalid_request_error',
      statusCode: 401,
    };

    const apiErr = stripeFailure(leaky, 'checkout.sessions.create');
    const body = (await apiErr.getResponse().json()) as { error: string; message: string };

    // Client payload is generic and carries no secret / raw Stripe text.
    expect(body.error).toBe('bad_gateway');
    expect(body.message).toMatch(/payment processing is temporarily unavailable/i);
    expect(JSON.stringify(body)).not.toMatch(/sk_live|Expired API Key/);

    // The full detail still reaches the Worker logs (for us, not the user).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(spy.mock.calls)).toContain('sk_live');
    spy.mockRestore();
  });
});

describe('billing checkout — price resolution', () => {
  const env = {
    STRIPE_PRICE_TEAM_MONTHLY: 'price_agency_m',
    STRIPE_PRICE_TEAM_ANNUAL: 'price_agency_a',
  } as unknown as Parameters<typeof resolvePriceId>[0];

  it('resolves the configured Planner (agency) price IDs for both intervals', () => {
    expect(resolvePriceId(env, 'agency', 'month')).toBe('price_agency_m');
    expect(resolvePriceId(env, 'agency', 'year')).toBe('price_agency_a');
  });

  it('throws (rather than handing Stripe an empty price) when a price ID is unset', () => {
    const empty = {} as unknown as Parameters<typeof resolvePriceId>[0];
    expect(() => resolvePriceId(empty, 'agency', 'month')).toThrow();
  });

  it('throws for plans with no self-serve price (free / enterprise)', () => {
    expect(() => resolvePriceId(env, 'free', 'month')).toThrow();
    expect(() => resolvePriceId(env, 'enterprise', 'year')).toThrow();
  });
});
