// Env bindings and a typed Hono context. Every Worker module imports from
// here rather than re-declaring the shape.

export interface Env {
  // Static-asset binding (SPA)
  ASSETS: Fetcher;

  // Storage
  TILES: R2Bucket;         // existing PMTiles archive
  FEEDS: R2Bucket;         // feed blobs: working states, version snapshots, rendered ZIPs
  DB: D1Database;          // auth + feed metadata
  KV: KVNamespace;         // rate-limit counters, cache

  // Vars (wrangler.jsonc `vars`)
  AUTH_EMAIL_FROM: string;
  APP_ORIGIN: string;
  FEEDS_ORIGIN: string;
  BACKEND_ENABLED: string;
  BILLING_ENABLED?: string;
  HARD_LIMITS: string;
  // Public Mapbox publishable token used by the embed pages on the feeds
  // origin. Same value as VITE_MAPBOX_TOKEN; not a secret.
  MAPBOX_TOKEN?: string;

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
  plan: 'free' | 'pro' | 'team' | 'enterprise';
  planStatus: 'active' | 'past_due' | 'canceled' | 'trialing';
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
