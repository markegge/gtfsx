// Google Ads Offline Conversion Import (OCI) — server-side conversion
// uploader. Pushes gclid-stamped `event` rows (feed_exported, paywall_view)
// to Google Ads as offline conversions. This is the cookieless replacement
// for the standard gtag.js conversion pixel and preserves the locked
// no-cookies analytics architecture (see docs/GOOGLE_ADS_PLAN.md §3.2).
//
// Flow:
//   1. Read OCI config from env. Bail (no-op) if any secret is missing —
//      Mark hasn't run the one-time OAuth setup yet. See README.md.
//   2. Query `event` rows where gclid IS NOT NULL, oci_uploaded_at IS NULL,
//      kind IN ('feed_exported', 'paywall_view'), ts > now - 90 days.
//      (Older gclids are silently dropped — Google rejects them anyway.)
//   3. Exchange the long-lived refresh token for a short-lived access token.
//   4. POST batches of up to BATCH_SIZE conversions to uploadClickConversions
//      with `partial_failure: true` so one stale row doesn't sink the batch.
//   5. Per row: success → set oci_uploaded_at = now (idempotent for future
//      runs). Failure → increment oci_attempts and store oci_last_error.
//      Once oci_attempts >= MAX_ATTEMPTS we set oci_uploaded_at = -1 as a
//      "permanently failed, stop retrying" sentinel.

import type { Env } from '../../env';

const API_VERSION = 'v17';
// Google Ads uploadClickConversions accepts up to 2000 conversions per call;
// keep below that with headroom in case we ever extend the payload shape.
const BATCH_SIZE = 1000;
// gclids expire from Google Ads' side at ~90 days. Drop anything older.
const GCLID_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// Conversion kinds we upload. Anything not in this set is ignored by the
// uploader (the SQL WHERE clause also pins kind IN ('feed_exported',
// 'paywall_view')). Keep these two literals in sync with that query.
type UploadedKind = 'feed_exported' | 'paywall_view';

export interface OciConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  conversionActions: Record<UploadedKind, string>;
}

export interface OciResult {
  ranAt: number;
  configured: boolean;
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
    conversions: rows.map((r) => ({
      gclid: r.gclid,
      conversion_action: `customers/${cfg.customerId}/conversionActions/${cfg.conversionActions[r.kind]}`,
      conversion_date_time: formatConversionDateTime(r.ts),
      // No conversion_value — both Google Ads conversion actions are
      // configured "Don't use a value" (handoff §2). Sending one would
      // cause Google to silently flip them to value-using mode.
    })),
    partial_failure: true,
    validate_only: false,
  };
}

// ─── Upload ───────────────────────────────────────────────────────────────

// uploadClickConversions response shape we care about. Successful conversions
// echo back in `results`; per-row failures appear in `partial_failure_error`
// as a google.rpc.Status with embedded GoogleAdsFailure details containing
// the offending operation index.
interface UploadClickConversionsResponse {
  results?: Array<{ gclid?: string; conversion_action?: string }>;
  partial_failure_error?: {
    code?: number;
    message?: string;
    details?: Array<{
      errors?: Array<{
        message?: string;
        location?: { field_path_elements?: Array<{ field_name?: string; index?: number }> };
      }>;
    }>;
  };
}

function extractRowErrors(resp: UploadClickConversionsResponse): Map<number, string> {
  const errs = new Map<number, string>();
  const details = resp.partial_failure_error?.details ?? [];
  for (const d of details) {
    for (const e of d.errors ?? []) {
      const path = e.location?.field_path_elements ?? [];
      // The operations[N] path element gives us the row index.
      const op = path.find((p) => p.field_name === 'operations');
      if (op && typeof op.index === 'number') {
        errs.set(op.index, (e.message ?? 'unknown error').slice(0, 500));
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

async function loadPending(
  env: Env,
  now: number,
  limit: number,
): Promise<PendingRow[]> {
  const cutoff = now - GCLID_TTL_MS;
  const res = await env.DB.prepare(
    `SELECT id, ts, kind, gclid, COALESCE(oci_attempts, 0) AS attempts
       FROM event
      WHERE gclid IS NOT NULL
        AND oci_uploaded_at IS NULL
        AND kind IN ('feed_exported', 'paywall_view')
        AND ts > ?
      ORDER BY ts ASC
      LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<{ id: string; ts: number; kind: UploadedKind; gclid: string; attempts: number }>();
  return res.results ?? [];
}

// Mark rows older than the 90-day cutoff so they stop showing as "pending"
// on the admin status page. Sentinel -1 = permanently dropped.
async function markExpiredOnly(env: Env, now: number): Promise<number> {
  const cutoff = now - GCLID_TTL_MS;
  const res = await env.DB.prepare(
    `UPDATE event
        SET oci_uploaded_at = -1,
            oci_last_error = 'expired (>90 days)'
      WHERE gclid IS NOT NULL
        AND oci_uploaded_at IS NULL
        AND kind IN ('feed_exported', 'paywall_view')
        AND ts <= ?`,
  )
    .bind(cutoff)
    .run();
  return res.meta.changes ?? 0;
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function uploadPendingConversions(
  env: Env,
  deps: UploaderDeps = {},
): Promise<OciResult> {
  const now = (deps.now ?? Date.now)();
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
  const rows = await loadPending(env, now, BATCH_SIZE * 5);
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
    let batchFatalError: string | null = null;
    try {
      const resp = await postBatch(cfg, accessToken, payload, deps);
      rowErrors = extractRowErrors(resp);
    } catch (err) {
      // Fatal (auth, network, malformed response) — treat every row as
      // failed-this-run so attempts increment and we retry next cron.
      batchFatalError = err instanceof Error ? err.message : String(err);
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
