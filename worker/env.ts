// Env bindings and a typed Hono context. Every Worker module imports from
// here rather than re-declaring the shape.

export interface Env {
  // Static-asset binding (SPA)
  ASSETS: Fetcher;

  // Storage
  TILES: R2Bucket;         // existing PMTiles archive
  FEEDS: R2Bucket;         // feed blobs: working states, version snapshots, rendered ZIPs
  FORUM_IMAGES: R2Bucket;  // user-uploaded forum images (new uploads served via IMAGES_ORIGIN/_forum-images/<key>; legacy FEEDS_ORIGIN URLs still resolve)
  DB: D1Database;          // auth + feed metadata
  KV: KVNamespace;         // rate-limit counters, cache

  // Vars (wrangler.jsonc `vars`)
  AUTH_EMAIL_FROM: string;
  // Internal inbox for owner notifications (e.g. new paid subscriber). Optional.
  OWNER_NOTIFY_EMAIL?: string;
  APP_ORIGIN: string;
  FEEDS_ORIGIN: string;
  // Dedicated host that serves ONLY user-uploaded forum images
  // (img.gtfsx.com / staging-img.gtfsx.com). New uploads return URLs on this
  // host; legacy feeds.gtfsx.com image URLs keep working via the feeds handler.
  IMAGES_ORIGIN: string;
  BACKEND_ENABLED: string;
  BILLING_ENABLED?: string;
  HARD_LIMITS: string;
  // Public Mapbox publishable token used by the embed pages on the feeds
  // origin. Same value as VITE_MAPBOX_TOKEN; not a secret.
  MAPBOX_TOKEN?: string;

  // Google OAuth ("Continue with Google"), issue #20. The client ID is public
  // (lives in wrangler.jsonc `vars`); the client secret is a `wrangler secret`.
  // When either is missing the /auth/google/* routes redirect to the login
  // error page instead of running, so the rest of the worker stays healthy.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  // Stripe Price IDs (from scripts/setup-stripe.ts). Empty until billing wired in.
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_PRO_ANNUAL?: string;
  STRIPE_PRICE_TEAM_MONTHLY?: string;
  STRIPE_PRICE_TEAM_ANNUAL?: string;
  STRIPE_PORTAL_CONFIG_ID?: string;

  // Secrets (wrangler secret put)
  RESEND_API_KEY: string;
  MOBILITY_DATABASE_REFRESH_TOKEN: string;
  TURNSTILE_SECRET_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SIGNING_SECRET?: string;

  // Google Ads Offline Conversion Import. All optional — when any are
  // missing the uploader logs and exits without running, so the rest of
  // the worker stays healthy. See worker/marketing/ads/README.md for the
  // one-time OAuth setup and `wrangler secret put` commands.
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  // The GTFS·X Google Ads account id without hyphens, e.g. "1001841562"
  // (UI shows "100-184-1562"). Doubles as login-customer-id for the
  // Ads API request — we don't operate under a manager account.
  GOOGLE_ADS_CUSTOMER_ID?: string;
  // Numeric conversion_action IDs created in the Google Ads UI; we
  // hard-code them in env rather than fetching dynamically every run.
  // Get from Goals → Summary → click the action → URL contains the ID.
  GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED?: string;
  GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW?: string;
}

// Hono context variables populated by middleware. Typed as a module augmentation
// so `c.var.user` is strongly-typed across every handler.
export interface AppVariables {
  user?: AuthedUser;
  session?: { id: string; userId: string };
  requestId: string;
}

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  status: 'pending_verification' | 'active' | 'disabled' | 'deleted_soft';
  staff: boolean;
  // Personal-workspace plan + status, mirrored from user.plan / user.plan_status.
  // Updated by Stripe webhooks. Used for client-side paywall gating.
  plan: 'free' | 'pro' | 'agency' | 'enterprise';
  planStatus: 'active' | 'past_due' | 'canceled' | 'trialing';
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
