// Google Ads Offline Conversion Import (OCI) — server-side conversion
// uploader. Pushes gclid-stamped `event` rows (feed_exported, paywall_view,
// demo_request) to Google Ads as offline conversions. This is the cookieless
// replacement for the standard gtag.js conversion pixel and preserves the
// locked no-cookies analytics architecture (see docs/GOOGLE_ADS_PLAN.md §3.2).
//
// Flow:
//   1. Read OCI config from env. Bail (no-op) if any core secret is missing —
//      Mark hasn't run the one-time OAuth setup yet. See README.md.
//   2. Query `event` rows where gclid IS NOT NULL, oci_uploaded_at IS NULL,
//      kind IN (the kinds whose conversion action is configured),
//      ts > now - 90 days.
//      (Older gclids are silently dropped — Google rejects them anyway.)
//   3. Exchange the long-lived refresh token for a short-lived access token.
//   4. POST batches of up to BATCH_SIZE conversions to uploadClickConversions
//      with `partial_failure: true` so one stale row doesn't sink the batch.
//   5. Per row: success → set oci_uploaded_at = now (idempotent for future
//      runs). Failure → increment oci_attempts and store oci_last_error.
//      Once oci_attempts >= MAX_ATTEMPTS we set oci_uploaded_at = -1 as a
//      "permanently failed, stop retrying" sentinel.

import type { Env } from '../../env';

// Google Ads API version. Bump to the latest stable when the current version
// is sunset (Google retires major versions ~14 months after release). The
// uploadClickConversions endpoint shape has been stable since v3; bumping the
// version string is usually sufficient (verified against the v24 proto: the
// request/ClickConversion/response fields we use are unchanged — v24 only
// *adds* an optional job_id we don't send or read). Last bumped 2026-06-22
// (v17 → v24). Release notes: https://developers.google.com/google-ads/api/docs/release-notes
const API_VERSION = 'v24';
// Google Ads uploadClickConversions accepts up to 2000 conversions per call;
// keep below that with headroom in case we ever extend the payload shape.
const BATCH_SIZE = 1000;
// gclids expire from Google Ads' side at ~90 days. Drop anything older.
const GCLID_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Uploads only run on the production Worker. Even though staging normally lacks
// the GOOGLE_ADS_* secrets (readOciConfig → null), gate explicitly on the prod
// origin so a copied secret can never fire test/staging traffic into the live
// Google Ads account. env.APP_ORIGIN is 'https://www.gtfsx.com' on prod and
// 'https://staging.gtfsx.com' on staging (wrangler.jsonc vars).
const PROD_ORIGIN = 'https://www.gtfsx.com';
// Conversion kinds we can upload. Anything not in this set is ignored by the
// uploader; the per-run SQL WHERE clause narrows further to the kinds whose
// conversion action is actually configured (see configuredKinds).
export type UploadedKind = 'feed_exported' | 'paywall_view' | 'demo_request';
const ALL_UPLOAD_KINDS: UploadedKind[] = ['feed_exported', 'paywall_view', 'demo_request'];

export interface OciConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  // feed_exported / paywall_view are required — the uploader refuses to run
  // without them (live in prod since 2026-05-26). demo_request is OPTIONAL:
  // making it required would silently no-op the two live uploads until Mark
  // creates the new conversion action in the Ads UI. Unset simply means
  // demo_request rows stay pending (and are surfaced on the admin status
  // page) until GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST is set.
  conversionActions: {
    feed_exported: string;
    paywall_view: string;
    demo_request?: string;
  };
}

// The kinds this config can actually upload, in ALL_UPLOAD_KINDS order.
export function configuredKinds(cfg: OciConfig): UploadedKind[] {
  return ALL_UPLOAD_KINDS.filter((k) => cfg.conversionActions[k] !== undefined);
}

export interface OciResult {
  ranAt: number;
  configured: boolean;
  // Set when the run short-circuited without attempting anything (e.g. a
  // non-production origin). Distinguishes a deliberate skip from configured:false.
  skippedReason?: string;
  // Counts across this run. `attempted` counts rows actually sent (after the
  // 90-day cutoff filter); `uploaded` counts rows Google accepted.
  attempted: number;
  uploaded: number;
  failedThisRun: number;
  markedPermanentlyFailed: number;
  skippedExpired: number;
  // Per-row errors from this run (truncated for log noise).
  errors: Array<{ id: string; gclid: string; message: string }>;
}

export interface UploaderDeps {
  // Override fetch in tests. Defaults to global fetch.
  fetch?: typeof fetch;
  // Override "now" in tests for deterministic timestamps.
  now?: () => number;
}

// ─── Config ───────────────────────────────────────────────────────────────

export function readOciConfig(env: Env): OciConfig | null {
  const dev = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cid = env.GOOGLE_ADS_CLIENT_ID;
  const cs = env.GOOGLE_ADS_CLIENT_SECRET;
  const rt = env.GOOGLE_ADS_REFRESH_TOKEN;
  const cust = env.GOOGLE_ADS_CUSTOMER_ID;
  const feedAction = env.GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED;
  const paywallAction = env.GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW;
  // Optional — see the OciConfig.conversionActions comment above.
  const demoAction = env.GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST;
  if (!dev || !cid || !cs || !rt || !cust || !feedAction || !paywallAction) {
    return null;
  }
  return {
    developerToken: dev,
    clientId: cid,
    clientSecret: cs,
    refreshToken: rt,
    customerId: cust,
    conversionActions: {
      feed_exported: feedAction,
      paywall_view: paywallAction,
      ...(demoAction ? { demo_request: demoAction } : {}),
    },
  };
}

// ─── OAuth ────────────────────────────────────────────────────────────────

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export async function exchangeRefreshToken(
  cfg: OciConfig,
  deps: UploaderDeps = {},
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth token exchange failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as OAuthTokenResponse;
  if (!data.access_token) {
    throw new Error('OAuth token exchange returned no access_token');
  }
  return data.access_token;
}

// ─── Payload helpers ──────────────────────────────────────────────────────

// Google Ads requires conversion_date_time in the format
//   "yyyy-mm-dd hh:mm:ss±hh:mm"
// We emit UTC ("+00:00") so we don't have to deal with Mountain DST swings.
// Google normalizes to the account timezone server-side for reporting.
export function formatConversionDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}

export interface PendingRow {
  id: string;
  ts: number;
  kind: UploadedKind;
  gclid: string;
  attempts: number;
}

export interface UploadPayloadConversion {
  gclid: string;
  conversion_action: string;
  conversion_date_time: string;
}

export function buildConversionPayload(
  cfg: OciConfig,
  rows: PendingRow[],
): { conversions: UploadPayloadConversion[]; partial_failure: boolean; validate_only: boolean } {
  return {
    conversions: rows.map((r) => {
      // loadPending only selects kinds present in cfg.conversionActions, so
      // this lookup can't miss — the throw is a tripwire for future drift.
      const actionId = cfg.conversionActions[r.kind];
      if (!actionId) {
        throw new Error(`No conversion action configured for kind '${r.kind}'`);
      }
      return {
        gclid: r.gclid,
        conversion_action: `customers/${cfg.customerId}/conversionActions/${actionId}`,
        conversion_date_time: formatConversionDateTime(r.ts),
        // No conversion_value — all Google Ads conversion actions are
        // configured "Don't use a value" (handoff §2). Sending one would
        // cause Google to silently flip them to value-using mode.
      };
    }),
    partial_failure: true,
    validate_only: false,
  };
}

// ─── Upload ───────────────────────────────────────────────────────────────

// uploadClickConversions response shape we care about. Successful conversions
// echo back in `results`; per-row failures appear in `partialFailureError`
// as a google.rpc.Status with embedded GoogleAdsFailure details containing
// the offending conversion index.
//
// CASING: the Google Ads REST API returns proto3-JSON in **camelCase**
// (`partialFailureError`, `fieldPathElements`, `fieldName`) even though it
// accepts snake_case in the REQUEST. Reading the response as snake_case (the
// original bug) made extractRowErrors always return empty → every rejected row
// was marked "uploaded", which silently masked a month-long outage when the
// account was de-allowlisted from this endpoint. We read camelCase and keep a
// snake_case fallback so a shape change in either direction can't re-hide
// failures.
interface PartialFailure {
  code?: number;
  message?: string;
  details?: Array<{
    errors?: Array<{
      message?: string;
      location?: {
        fieldPathElements?: PathElement[];
        field_path_elements?: PathElement[];
      };
    }>;
  }>;
}
interface PathElement { fieldName?: string; field_name?: string; index?: number }
interface UploadClickConversionsResponse {
  results?: Array<{ gclid?: string; conversionAction?: string }>;
  partialFailureError?: PartialFailure;
  partial_failure_error?: PartialFailure;
}

// The top-level partial-failure status, whichever casing Google used.
function partialFailure(resp: UploadClickConversionsResponse): PartialFailure | undefined {
  return resp.partialFailureError ?? resp.partial_failure_error;
}

function extractRowErrors(resp: UploadClickConversionsResponse): Map<number, string> {
  const errs = new Map<number, string>();
  for (const d of partialFailure(resp)?.details ?? []) {
    for (const e of d.errors ?? []) {
      const loc = e.location ?? {};
      const path = loc.fieldPathElements ?? loc.field_path_elements ?? [];
      // The row index lives on the `conversions[N]` path element — the only one
      // that carries a numeric index. Match on the index itself, not a field
      // name: the request field is `conversions` (not `operations`, which is
      // the mutate-endpoint name the original code wrongly looked for), and we
      // don't want to depend on that name or the JSON casing.
      const indexed = path.find((p) => typeof p.index === 'number');
      if (indexed && typeof indexed.index === 'number') {
        errs.set(indexed.index, (e.message ?? 'unknown error').slice(0, 500));
      }
    }
  }
  return errs;
}

async function postBatch(
  cfg: OciConfig,
  accessToken: string,
  payload: ReturnType<typeof buildConversionPayload>,
  deps: UploaderDeps,
): Promise<UploadClickConversionsResponse> {
  const fetchImpl = deps.fetch ?? fetch;
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${cfg.customerId}:uploadClickConversions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'developer-token': cfg.developerToken,
      'login-customer-id': cfg.customerId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`uploadClickConversions HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as UploadClickConversionsResponse;
}

// ─── DB ────────────────────────────────────────────────────────────────────

// Only kinds whose conversion action is configured are selected — an
// unconfigured kind's rows stay pending (visible on the admin status page)
// instead of failing per-row against a missing action.
async function loadPending(
  env: Env,
  now: number,
  limit: number,
  kinds: UploadedKind[],
): Promise<PendingRow[]> {
  const cutoff = now - GCLID_TTL_MS;
  const placeholders = kinds.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `SELECT id, ts, kind, gclid, COALESCE(oci_attempts, 0) AS attempts
       FROM event
      WHERE gclid IS NOT NULL
        AND oci_uploaded_at IS NULL
        AND kind IN (${placeholders})
        AND ts > ?
      ORDER BY ts ASC
      LIMIT ?`,
  )
    .bind(...kinds, cutoff, limit)
    .all<{ id: string; ts: number; kind: UploadedKind; gclid: string; attempts: number }>();
  return res.results ?? [];
}

// Mark rows older than the 90-day cutoff so they stop showing as "pending"
// on the admin status page. Sentinel -1 = permanently dropped. Covers ALL
// upload kinds (not just the configured ones): Google would reject the stale
// gclid regardless, so an unconfigured kind's out-of-window rows are flagged
// too rather than pending forever.
async function markExpiredOnly(env: Env, now: number): Promise<number> {
  const cutoff = now - GCLID_TTL_MS;
  const placeholders = ALL_UPLOAD_KINDS.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `UPDATE event
        SET oci_uploaded_at = -1,
            oci_last_error = 'expired (>90 days)'
      WHERE gclid IS NOT NULL
        AND oci_uploaded_at IS NULL
        AND kind IN (${placeholders})
        AND ts <= ?`,
  )
    .bind(...ALL_UPLOAD_KINDS, cutoff)
    .run();
  return res.meta.changes ?? 0;
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function uploadPendingConversions(
  env: Env,
  deps: UploaderDeps = {},
): Promise<OciResult> {
  const now = (deps.now ?? Date.now)();

  // Hard prod-only gate — see PROD_ORIGIN. Runs before config/DB work so a
  // non-prod worker is an immediate no-op.
  if (env.APP_ORIGIN !== PROD_ORIGIN) {
    console.warn(`[oci] skipped — non-production origin (${env.APP_ORIGIN}); uploads run on prod only`);
    return {
      ranAt: now, configured: false, skippedReason: `non-production origin (${env.APP_ORIGIN})`,
      attempted: 0, uploaded: 0, failedThisRun: 0,
      markedPermanentlyFailed: 0, skippedExpired: 0, errors: [],
    };
  }

  const cfg = readOciConfig(env);
  if (!cfg) {
    console.warn('[oci] skipped — env not configured (see worker/marketing/ads/README.md)');
    return {
      ranAt: now, configured: false,
      attempted: 0, uploaded: 0, failedThisRun: 0,
      markedPermanentlyFailed: 0, skippedExpired: 0, errors: [],
    };
  }

  const skippedExpired = await markExpiredOnly(env, now);
  const rows = await loadPending(env, now, BATCH_SIZE * 5, configuredKinds(cfg));
  if (rows.length === 0) {
    return {
      ranAt: now, configured: true,
      attempted: 0, uploaded: 0, failedThisRun: 0,
      markedPermanentlyFailed: 0, skippedExpired, errors: [],
    };
  }

  const accessToken = await exchangeRefreshToken(cfg, deps);

  let uploaded = 0;
  let failedThisRun = 0;
  let markedPermanentlyFailed = 0;
  const errors: OciResult['errors'] = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const payload = buildConversionPayload(cfg, batch);

    let rowErrors = new Map<number, string>();
    try {
      const resp = await postBatch(cfg, accessToken, payload, deps);
      rowErrors = extractRowErrors(resp);
      // Safety net: if Google reported a partial failure but we mapped zero
      // per-row errors (a shape we don't recognize, or a batch-level error with
      // no conversion index), fail the WHOLE batch rather than silently marking
      // every row uploaded. Never mark a row success while Google is unhappy.
      const pf = partialFailure(resp);
      if (pf && rowErrors.size === 0) {
        const msg = (pf.message ?? 'partial failure with no parseable row errors').slice(0, 500);
        console.error('[oci] unmapped partial failure — failing whole batch:', msg);
        for (let j = 0; j < batch.length; j++) rowErrors.set(j, msg);
      }
    } catch (err) {
      // Fatal (auth, network, malformed response) — treat every row as
      // failed-this-run so attempts increment and we retry next cron.
      const batchFatalError = err instanceof Error ? err.message : String(err);
      console.error('[oci] batch POST failed:', batchFatalError);
      for (let j = 0; j < batch.length; j++) {
        rowErrors.set(j, batchFatalError.slice(0, 500));
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      const err = rowErrors.get(j);
      if (err === undefined) {
        await env.DB.prepare(
          `UPDATE event SET oci_uploaded_at = ?, oci_last_error = NULL WHERE id = ?`,
        ).bind(now, row.id).run();
        uploaded++;
        continue;
      }

      failedThisRun++;
      errors.push({ id: row.id, gclid: row.gclid, message: err });
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await env.DB.prepare(
          `UPDATE event SET oci_uploaded_at = -1, oci_attempts = ?, oci_last_error = ? WHERE id = ?`,
        ).bind(nextAttempts, err, row.id).run();
        markedPermanentlyFailed++;
      } else {
        await env.DB.prepare(
          `UPDATE event SET oci_attempts = ?, oci_last_error = ? WHERE id = ?`,
        ).bind(nextAttempts, err, row.id).run();
      }
    }
  }

  return {
    ranAt: now, configured: true,
    attempted: rows.length, uploaded, failedThisRun,
    markedPermanentlyFailed, skippedExpired,
    errors: errors.slice(0, 50),
  };
}
