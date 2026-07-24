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
  // Internal inbox for owner notifications (e.g. new paid subscriber, daily
  // digest fallback recipient). Optional.
  OWNER_NOTIFY_EMAIL?: string;
  // Welcome-email reply channel. Optional; when unset the welcome email falls
  // back to AUTH_EMAIL_FROM. Prod value: hello@gtfsx.com.
  WELCOME_REPLY_TO?: string;
  // Daily owner-digest kill switch. Optional; "false" disables the cron send,
  // any other value (incl. unset) leaves it on. See worker/cron/tasks.ts.
  OWNER_DIGEST_ENABLED?: string;
  // Recipient for the daily owner digest. Optional; falls back to
  // OWNER_NOTIFY_EMAIL when unset.
  OWNER_DIGEST_EMAIL?: string;
  APP_ORIGIN: string;
  FEEDS_ORIGIN: string;
  // Dedicated host that serves ONLY user-uploaded forum images
  // (img.gtfsx.com / staging-img.gtfsx.com). New uploads return URLs on this
  // host; legacy feeds.gtfsx.com image URLs keep working via the feeds handler.
  IMAGES_ORIGIN: string;
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
  // NOTE: the TEAM_* names are deliberate legacy — they point at the Planner
  // (internal plan id 'agency') prices. Do not rename.
  STRIPE_PRICE_TEAM_MONTHLY?: string;
  STRIPE_PRICE_TEAM_ANNUAL?: string;
  STRIPE_PORTAL_CONFIG_ID?: string;

  // Cloudflare Turnstile SITE key (public). Baked into the React bundle as
  // VITE_TURNSTILE_SITE_KEY for signup; this copy is for the worker-rendered
  // /book-demo lead form, which isn't part of the React build and so can't read
  // the Vite var. Same public value; lives in `vars`, not as a secret. Empty =
  // the widget is skipped (dev fallback) AND the POST handler skips server-side
  // verification, mirroring how signup couples site key ⟺ TURNSTILE_SECRET_KEY
  // per environment. Set it wherever TURNSTILE_SECRET_KEY is set.
  TURNSTILE_SITE_KEY?: string;

  // Secrets (wrangler secret put)
  RESEND_API_KEY: string;
  MOBILITY_DATABASE_REFRESH_TOKEN: string;
  // Claude API key for the "Ask GTFS·X" help assistant (issue #68). Optional:
  // when unset, POST /api/assistant/chat returns a clean 503 the UI surfaces
  // gracefully, and the rest of the worker stays healthy. Set per-environment
  // via `wrangler secret put ANTHROPIC_API_KEY [--env staging]`.
  ANTHROPIC_API_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  // Twilio Verify for SMS two-factor (phase 2). All optional — when any is
  // missing, `sms_available` is false, SMS enrollment returns sms_unavailable,
  // and 2FA falls back to email codes. Set per-environment via
  // `wrangler secret put TWILIO_* [--env staging]` once Mark's Twilio account +
  // Trust Hub profile + Verify Service exist.
  TWILIO_ACCOUNT_SID?: string;
  // Twilio API key auth (recommended over the Account SID + Auth Token pair):
  // REST calls authenticate as Basic base64(API_KEY_SID:API_KEY_SECRET), with
  // the key SID (starts "SK") distinct from the Account SID.
  TWILIO_API_KEY_SID?: string;
  TWILIO_API_KEY_SECRET?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
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
  // (UI shows "100-184-1562"). This is the OPERATING (conversion) account.
  GOOGLE_ADS_CUSTOMER_ID?: string;
  // Manager (MCC) account id the operating account is accessed through, no
  // hyphens. Present as a prod secret. The legacy uploadClickConversions path
  // didn't use it (it sent the operating id as login-customer-id, which Google
  // accepted); the Data Manager path sends it as destinations[].loginAccount.
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  // Numeric conversion_action IDs created in the Google Ads UI; we
  // hard-code them in env rather than fetching dynamically every run.
  // Get from Goals → Summary → click the action → URL contains the ID.
  GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED?: string;
  GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW?: string;
  // demo_request (the /book-demo lead-form submit). Unlike the two
  // above, this one is optional even when OCI is otherwise configured:
  // leaving it unset keeps the live feed_exported/paywall_view uploads
  // running while the new conversion action is created in the Ads UI —
  // demo_request rows simply stay pending until it's set.
  GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST?: string;
  // sign_up (a fresh account signup carrying an ad click id — written
  // server-side by the /auth/signup fresh-signup path). Optional in exactly
  // the same way as demo_request: unset keeps the other uploads running and
  // sign_up rows stay pending until it's set.
  GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP?: string;

  // Google Ads Data Manager API (datamanager.googleapis.com) — the supported
  // replacement for the de-allowlisted ConversionUploadService. When BOTH of
  // these are present the OCI uploader sends via Data Manager; otherwise it
  // falls back to the (now-loud-on-failure) legacy path. Reuses the
  // GOOGLE_ADS_CLIENT_ID/SECRET OAuth client, GOOGLE_ADS_CUSTOMER_ID,
  // GOOGLE_ADS_LOGIN_CUSTOMER_ID, and the GOOGLE_ADS_CONVERSION_ACTION_* ids.
  // See worker/marketing/ads/README.md → "Data Manager API" for the OAuth
  // runbook (the refresh token must be minted with the datamanager scope).
  GOOGLE_DATAMANAGER_REFRESH_TOKEN?: string;
  // GCP project id for the required x-goog-user-project header (the project the
  // Data Manager API is enabled on — the same one holding the OAuth client).
  GOOGLE_DATAMANAGER_PROJECT_ID?: string;
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
  plan: 'free' | 'agency' | 'enterprise';
  planStatus: 'active' | 'past_due' | 'canceled' | 'trialing';
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
