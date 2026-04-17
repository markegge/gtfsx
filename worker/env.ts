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
  HARD_LIMITS: string;

  // Secrets (wrangler secret put)
  RESEND_API_KEY: string;
  MOBILITY_DATABASE_REFRESH_TOKEN: string;
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
}

export type AppContext = { Bindings: Env; Variables: AppVariables };
