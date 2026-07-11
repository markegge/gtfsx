// Thin wrapper around the Stripe SDK so we have a single place to:
//   - construct the client with workerd-friendly settings
//   - centralize secret-key reads and dev/test guards
//   - expose typed helpers for the handful of calls we make
//
// The `stripe` npm package supports the Cloudflare Workers runtime via its
// fetch-based HTTP client. We pass `httpClient: createFetchHttpClient()` to
// avoid pulling in node:https.

import Stripe from 'stripe';
import type { Env } from '../env';
import type { Plan } from '../projects/quotas';

// Reverse lookup from a Stripe Price ID to the Plan it represents. Webhook
// payloads send `subscription.items[].price.product` as an opaque ID string
// (not an expanded Product), so reading `product.metadata.tier` requires a
// second API round-trip. Reading the Price ID directly out of the env vars we
// already configured at setup time is faster and dependency-free.
// Returns null for any unrecognized Price ID (e.g. the retired Pro prices) —
// callers must treat null as "no plan change" and log, never crash.
export function planFromPriceId(env: Env, priceId: string): Plan | null {
  if (priceId === env.STRIPE_PRICE_TEAM_MONTHLY || priceId === env.STRIPE_PRICE_TEAM_ANNUAL) {
    return 'agency';
  }
  return null;
}

let cached: Stripe | undefined;

export function getStripe(env: Env): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  if (cached) return cached;
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-04-22.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
  });
  return cached;
}

// Pricing lookup. The plan + interval combination determines which Stripe
// Price ID we hand off to the Checkout session. Stored in wrangler.jsonc vars
// from the setup script output.
export type Interval = 'month' | 'year';

export function resolvePriceId(env: Env, plan: Plan, interval: Interval): string {
  const k = `${plan}_${interval}` as const;
  const map: Partial<Record<string, string | undefined>> = {
    // Keyed by `${plan}_${interval}`; plan is 'agency'. The env var NAMES
    // (STRIPE_PRICE_TEAM_*) intentionally stay — they're opaque config that
    // points at the same Stripe Price IDs as before the display rename.
    agency_month: env.STRIPE_PRICE_TEAM_MONTHLY,
    agency_year: env.STRIPE_PRICE_TEAM_ANNUAL,
  };
  const id = map[k];
  if (!id) {
    throw new Error(`No Stripe Price ID configured for plan=${plan} interval=${interval}`);
  }
  return id;
}

// Whether the billing path is wired up enough to actually charge. Called
// before checkout / portal endpoints so we can return a polite 503 in
// staging-without-stripe rather than a cryptic Stripe error.
export function billingReady(env: Env): boolean {
  return env.BILLING_ENABLED === 'true' && !!env.STRIPE_SECRET_KEY;
}

// Detect Stripe SDK errors so callers can log full detail server-side and
// return a generic, key-safe message to the client. NOTE: do NOT forward the
// raw Stripe `.message` to the browser — it can contain the secret key
// verbatim (e.g. "Expired API Key provided: sk_live_…"). See `stripeFailure`
// in routes.ts for the client-facing mapping.
export function isStripeError(err: unknown): err is InstanceType<typeof Stripe.errors.StripeError> {
  return err instanceof Stripe.errors.StripeError;
}
