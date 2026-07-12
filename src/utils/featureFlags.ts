// Active Stripe publishable key. `.env` carries both `_TEST_KEY` and `_LIVE_KEY`
// side by side. Dev and staging pick up the test key automatically; prod builds
// must resolve the LIVE key, which is what `npm run build:prod` guarantees.
//
// Do NOT build prod with a bare `npm run build`: the generic
// VITE_STRIPE_PUBLISHABLE_KEY is absent from `.env`, so the `?? _TEST_KEY`
// fallback below silently takes over and prod ships a pk_test_ key. That
// shipped on 2026-07-12 and took checkout down for ~30 minutes with a green
// build and a green deploy. `scripts/check-prod-bundle.mjs` now fails the build
// if a test key reaches the bundle.
export const stripePublishableKey: string =
  (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined)
  ?? (import.meta.env.VITE_STRIPE_PUBLISHABLE_TEST_KEY as string | undefined)
  ?? '';

// Cloudflare Turnstile site key (public). Empty string = widget disabled
// (dev fallback). Matching TURNSTILE_SECRET_KEY lives as a Worker secret.
export const turnstileSiteKey: string =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';
