import { stripePublishableKey } from './featureFlags';

// Build-time env values baked into the bundle so a deployed build is
// self-describing: read `__GTFSX_BUILD__` in prod devtools to see exactly what
// the bundle was built with, instead of inferring it from behaviour.
//
// Why this exists: on 2026-07-12 a bare `npm run build` shipped prod with a
// pk_test_ key. The generic VITE_STRIPE_PUBLISHABLE_KEY was absent, so
// featureFlags silently fell back to the test key: build green, deploy green,
// checkout dead. `scripts/check-prod-bundle.mjs` now greps the emitted bundle
// for a test key and fails the prod build.
//
// Never put actual key values here. Only 'live' | 'test' | 'none' and booleans.

export type StripeKeyKind = 'live' | 'test' | 'none';

const stripeKeyKind: StripeKeyKind = stripePublishableKey.startsWith('pk_live_')
  ? 'live'
  : stripePublishableKey.startsWith('pk_test_')
    ? 'test'
    : 'none';

export const BUILD_STAMP = {
  stripeKeyKind,
  mapbox: String(import.meta.env.VITE_MAPBOX_TOKEN ?? '').length > 0,
} as const;
