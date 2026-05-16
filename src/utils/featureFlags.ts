export const backendEnabled: boolean = (() => {
  const v = import.meta.env.VITE_BACKEND_ENABLED;
  return v === 'true' || v === '1' || v === true;
})();

// Independent kill-switch for the billing path. When false, paywall surfaces
// render in a "coming soon" state instead of triggering Stripe Checkout. Pairs
// with the BILLING_ENABLED Worker var.
export const billingEnabled: boolean = (() => {
  const v = import.meta.env.VITE_BILLING_ENABLED;
  return v === 'true' || v === '1' || v === true;
})();

// Active publishable key. .env carries both `_TEST_KEY` and `_LIVE_KEY`
// side by side. Dev and staging pick up the test key automatically; prod
// builds override at the command line:
//   VITE_STRIPE_PUBLISHABLE_KEY="$VITE_STRIPE_PUBLISHABLE_LIVE_KEY" npm run build
export const stripePublishableKey: string =
  (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined)
  ?? (import.meta.env.VITE_STRIPE_PUBLISHABLE_TEST_KEY as string | undefined)
  ?? '';

// Cloudflare Turnstile site key (public). Empty string = widget disabled
// (dev fallback). Matching TURNSTILE_SECRET_KEY lives as a Worker secret.
export const turnstileSiteKey: string =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';
