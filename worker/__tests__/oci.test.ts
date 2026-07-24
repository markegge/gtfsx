// worker/marketing/ads/oci.ts — Google Ads Offline Conversion Import uploader.
// Covers OAuth token exchange, payload construction, partial-failure handling,
// 90-day cutoff, idempotency, and the 3-attempt sentinel.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulidx';
import {
  buildAdIdentifiers,
  buildConversionPayload,
  buildIngestBody,
  exchangeRefreshToken,
  formatConversionDateTime,
  readDataManagerConfig,
  readOciConfig,
  uploadPendingConversions,
  type OciConfig,
  type PendingRow,
} from '../marketing/ads/oci';
import { applyMigrations, dbGet, dbRun, env as testEnv, resetDb } from './_setup';

const FIXED_NOW = 1748275200000; // 2026-05-26T16:00:00Z (deterministic)
const now = () => FIXED_NOW;

// ─── Fixture helpers ──────────────────────────────────────────────────────

const SECRETS = {
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-tok',
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'refresh-token',
  GOOGLE_ADS_CUSTOMER_ID: '1001841562',
  GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED: '111111',
  GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW: '222222',
  GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST: '333333',
  GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP: '444444',
};

// Data Manager secrets — the presence of these two (refresh token + project id)
// flips the uploader onto the DM path. Reuses the shared client/customer/action
// ids. Includes a distinct manager id so loginAccount is exercised.
const DM_SECRETS = {
  GOOGLE_DATAMANAGER_REFRESH_TOKEN: 'dm-refresh',
  GOOGLE_DATAMANAGER_PROJECT_ID: 'gtfsx-ads-oci',
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_CUSTOMER_ID: '1001841562',
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: '9998887777',
  GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED: '111111',
  GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW: '222222',
  GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST: '333333',
  GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP: '444444',
};

const ALL_SECRET_KEYS = [
  ...new Set([...Object.keys(SECRETS), ...Object.keys(DM_SECRETS)]),
];

function withSecrets(): void {
  Object.assign(testEnv, SECRETS);
}

function withDataManager(): void {
  Object.assign(testEnv, DM_SECRETS);
}

function clearSecrets(): void {
  for (const k of ALL_SECRET_KEYS) {
    delete (testEnv as unknown as Record<string, unknown>)[k];
  }
}

async function seedEvent(opts: {
  ts?: number;
  kind?: string;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  oci_uploaded_at?: number | null;
  oci_attempts?: number;
}): Promise<string> {
  const id = ulid();
  await dbRun(
    `INSERT INTO event (id, ts, kind, path, ref, session_id, country, label, gclid, gbraid, wbraid, oci_uploaded_at, oci_attempts, oci_last_error)
     VALUES (?, ?, ?, '/', NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
    id,
    opts.ts ?? FIXED_NOW - 1000,
    opts.kind ?? 'feed_exported',
    `sess-${id}`,
    opts.gclid ?? null,
    opts.gbraid ?? null,
    opts.wbraid ?? null,
    opts.oci_uploaded_at ?? null,
    opts.oci_attempts ?? 0,
  );
  return id;
}

// Data Manager events:ingest success — a 200 with just a requestId.
function dmSuccessResponse(): Response {
  return new Response(JSON.stringify({ requestId: 'req-abc-123' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// Stub fetch with a function that routes by URL.
type FetchHandler = (req: { url: string; init: RequestInit | undefined }) => Promise<Response> | Response;
function stubFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler({ url, init });
  });
  return mock as unknown as ReturnType<typeof vi.fn>;
}

function oauthResponse(): Response {
  return new Response(JSON.stringify({ access_token: 'access-xyz', expires_in: 3600, token_type: 'Bearer' }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function adsSuccessResponse(rowCount: number): Response {
  // Real Google Ads REST responses are camelCase (`conversionAction`).
  return new Response(JSON.stringify({
    results: Array.from({ length: rowCount }, (_, i) => ({ gclid: `g${i}`, conversionAction: 'x' })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// Mirror the REAL Google Ads REST partial-failure shape: camelCase
// `partialFailureError`, `fieldPathElements` / `fieldName`, and the row-index
// path element named `conversions` (NOT `operations`). This is exactly the
// response that the original snake_case parser silently ignored, marking every
// rejected row as uploaded. Captured verbatim from a live validate_only probe.
function adsPartialFailureResponse(failures: { index: number; message: string; code?: string }[]): Response {
  return new Response(JSON.stringify({
    partialFailureError: {
      code: 3,
      message: `Multiple errors in 'details'. First error: ${failures[0]?.message ?? ''}`,
      details: [{
        '@type': 'type.googleapis.com/google.ads.googleads.v24.errors.GoogleAdsFailure',
        errors: failures.map((f) => ({
          errorCode: { notAllowlistedError: f.code ?? 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE' },
          message: f.message,
          location: { fieldPathElements: [{ fieldName: 'conversions', index: f.index }] },
        })),
      }],
    },
    jobId: '1285029156557314512',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('OCI: readOciConfig', () => {
  beforeEach(() => { clearSecrets(); });

  it('returns null when any secret is missing', () => {
    expect(readOciConfig(testEnv)).toBeNull();
    Object.assign(testEnv, SECRETS);
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_REFRESH_TOKEN;
    expect(readOciConfig(testEnv)).toBeNull();
  });

  it('returns config when every secret is present', () => {
    withSecrets();
    const cfg = readOciConfig(testEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.customerId).toBe('1001841562');
    expect(cfg!.conversionActions.feed_exported).toBe('111111');
    expect(cfg!.conversionActions.paywall_view).toBe('222222');
    expect(cfg!.conversionActions.demo_request).toBe('333333');
    expect(cfg!.conversionActions.sign_up).toBe('444444');
  });

  it('demo_request action is optional: config still valid without it', () => {
    withSecrets();
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST;
    const cfg = readOciConfig(testEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.conversionActions.feed_exported).toBe('111111');
    expect(cfg!.conversionActions.demo_request).toBeUndefined();
  });

  it('sign_up action is optional: config still valid without it', () => {
    withSecrets();
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP;
    const cfg = readOciConfig(testEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.conversionActions.feed_exported).toBe('111111');
    expect(cfg!.conversionActions.sign_up).toBeUndefined();
  });
});

describe('OCI: formatConversionDateTime', () => {
  it('emits UTC in Google Ads API format', () => {
    // 2026-05-26T14:00:00Z → "2026-05-26 14:00:00+00:00"
    expect(formatConversionDateTime(Date.UTC(2026, 4, 26, 14, 0, 0))).toBe('2026-05-26 14:00:00+00:00');
    // zero-pads
    expect(formatConversionDateTime(Date.UTC(2026, 0, 3, 5, 7, 9))).toBe('2026-01-03 05:07:09+00:00');
  });
});

describe('OCI: buildConversionPayload', () => {
  it('maps each row to a conversion with no value, partial_failure=true', () => {
    const cfg: OciConfig = {
      developerToken: 'd', clientId: 'c', clientSecret: 's', refreshToken: 'r',
      customerId: '1001841562',
      conversionActions: { feed_exported: '111', paywall_view: '222' },
    };
    const payload = buildConversionPayload(cfg, [
      { id: 'a', ts: Date.UTC(2026, 4, 26, 14, 0, 0), kind: 'feed_exported', gclid: 'g1', attempts: 0 },
      { id: 'b', ts: Date.UTC(2026, 4, 26, 15, 0, 0), kind: 'paywall_view', gclid: 'g2', attempts: 0 },
    ]);
    expect(payload.partial_failure).toBe(true);
    expect(payload.validate_only).toBe(false);
    expect(payload.conversions).toEqual([
      {
        gclid: 'g1',
        conversion_action: 'customers/1001841562/conversionActions/111',
        conversion_date_time: '2026-05-26 14:00:00+00:00',
      },
      {
        gclid: 'g2',
        conversion_action: 'customers/1001841562/conversionActions/222',
        conversion_date_time: '2026-05-26 15:00:00+00:00',
      },
    ]);
    // No conversion_value anywhere — both actions are "Don't use a value".
    for (const c of payload.conversions) {
      expect(c).not.toHaveProperty('conversion_value');
    }
  });
});

describe('OCI: exchangeRefreshToken', () => {
  it('POSTs the refresh-token grant and returns access_token', async () => {
    const fetchMock = stubFetch(({ url, init }) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const body = String(init?.body ?? '');
      expect(body).toContain('grant_type=refresh_token');
      expect(body).toContain('refresh_token=r-xyz');
      expect(body).toContain('client_id=cid');
      return oauthResponse();
    });
    const tok = await exchangeRefreshToken({
      developerToken: 'd', clientId: 'cid', clientSecret: 'cs', refreshToken: 'r-xyz',
      customerId: '1', conversionActions: { feed_exported: '1', paywall_view: '2' },
    }, { fetch: fetchMock as unknown as typeof fetch });
    expect(tok).toBe('access-xyz');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on non-2xx', async () => {
    const fetchMock = stubFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(exchangeRefreshToken({
      developerToken: 'd', clientId: 'cid', clientSecret: 'cs', refreshToken: 'bad',
      customerId: '1', conversionActions: { feed_exported: '1', paywall_view: '2' },
    }, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/OAuth token exchange failed: 400/);
  });
});

describe('OCI: uploadPendingConversions', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearSecrets();
    // The uploader is prod-gated on APP_ORIGIN; set the prod origin so the
    // upload paths run (the env-gate itself is covered by its own test).
    (testEnv as unknown as Record<string, unknown>).APP_ORIGIN = 'https://www.gtfsx.com';
  });

  it('no-ops with configured=false when secrets are missing', async () => {
    await seedEvent({ gclid: 'g', kind: 'feed_exported' });
    const result = await uploadPendingConversions(testEnv, { now });
    expect(result.configured).toBe(false);
    expect(result.attempted).toBe(0);
    // Row stays untouched — still pending.
    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event`);
    expect(row!.oci_uploaded_at).toBeNull();
  });

  it('uploads pending rows, sets oci_uploaded_at, ignores already-uploaded rows', async () => {
    withSecrets();
    const idA = await seedEvent({ gclid: 'gA', kind: 'feed_exported', ts: FIXED_NOW - 1000 });
    const idB = await seedEvent({ gclid: 'gB', kind: 'paywall_view', ts: FIXED_NOW - 2000 });
    // Already uploaded — must not be re-sent.
    const idDone = await seedEvent({ gclid: 'gDone', kind: 'feed_exported', oci_uploaded_at: FIXED_NOW - 60000 });
    // Wrong kind — uploader skips editor_loaded.
    const idSkip = await seedEvent({ gclid: 'gSkip', kind: 'editor_loaded' });

    let adsCallCount = 0;
    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        adsCallCount++;
        const body = JSON.parse(String(init?.body ?? '{}'));
        // Order: oldest ts first → gB, then gA.
        expect(body.conversions).toHaveLength(2);
        expect(body.conversions[0].gclid).toBe('gB');
        expect(body.conversions[1].gclid).toBe('gA');
        expect(body.partial_failure).toBe(true);
        // Headers: Authorization + developer-token + login-customer-id.
        const h = (init?.headers ?? {}) as Record<string, string>;
        expect(h['Authorization']).toBe('Bearer access-xyz');
        expect(h['developer-token']).toBe('dev-tok');
        expect(h['login-customer-id']).toBe('1001841562');
        return adsSuccessResponse(2);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.configured).toBe(true);
    expect(result.attempted).toBe(2);
    expect(result.uploaded).toBe(2);
    expect(result.failedThisRun).toBe(0);
    expect(adsCallCount).toBe(1);

    const a = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, idA);
    const b = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, idB);
    const done = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, idDone);
    const skip = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, idSkip);
    expect(a!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(b!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(done!.oci_uploaded_at).toBe(FIXED_NOW - 60000); // unchanged
    expect(skip!.oci_uploaded_at).toBeNull(); // editor_loaded never uploaded
  });

  it('drops events older than 90 days (sentinel -1 with "expired" reason)', async () => {
    withSecrets();
    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;
    const expiredId = await seedEvent({ gclid: 'gOld', kind: 'feed_exported', ts: FIXED_NOW - ninetyOneDays });
    const freshId = await seedEvent({ gclid: 'gNew', kind: 'feed_exported', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        return adsSuccessResponse(1); // only the fresh one
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.skippedExpired).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.uploaded).toBe(1);

    const expired = await dbGet<{ oci_uploaded_at: number | null; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_last_error FROM event WHERE id = ?`, expiredId,
    );
    expect(expired!.oci_uploaded_at).toBe(-1);
    expect(expired!.oci_last_error).toMatch(/expired/i);

    const fresh = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, freshId);
    expect(fresh!.oci_uploaded_at).toBe(FIXED_NOW);
  });

  it('partial_failure: successful rows uploaded, failed row gets attempt+error, not marked', async () => {
    withSecrets();
    const id1 = await seedEvent({ gclid: 'gOK1', kind: 'feed_exported', ts: FIXED_NOW - 3000 });
    const id2 = await seedEvent({ gclid: 'gBAD', kind: 'feed_exported', ts: FIXED_NOW - 2000 });
    const id3 = await seedEvent({ gclid: 'gOK2', kind: 'paywall_view', ts: FIXED_NOW - 1000 });

    // The middle row (index 1) is rejected by Google for being stale.
    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        return adsPartialFailureResponse([{ index: 1, message: 'GCLID is too old' }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.attempted).toBe(3);
    expect(result.uploaded).toBe(2);
    expect(result.failedThisRun).toBe(1);
    expect(result.markedPermanentlyFailed).toBe(0);

    const r1 = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, id1);
    const r2 = await dbGet<{ oci_uploaded_at: number | null; oci_attempts: number; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_attempts, oci_last_error FROM event WHERE id = ?`, id2,
    );
    const r3 = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, id3);

    expect(r1!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(r3!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(r2!.oci_uploaded_at).toBeNull(); // still pending — will retry
    expect(r2!.oci_attempts).toBe(1);
    expect(r2!.oci_last_error).toBe('GCLID is too old');
  });

  it('flips to permanent-failure sentinel on the 3rd failed attempt', async () => {
    withSecrets();
    const id = await seedEvent({ gclid: 'gFAIL', kind: 'feed_exported', oci_attempts: 2 });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        return adsPartialFailureResponse([{ index: 0, message: 'still bad' }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.markedPermanentlyFailed).toBe(1);

    const row = await dbGet<{ oci_uploaded_at: number; oci_attempts: number; oci_last_error: string }>(
      `SELECT oci_uploaded_at, oci_attempts, oci_last_error FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBe(-1);
    expect(row!.oci_attempts).toBe(3);
    expect(row!.oci_last_error).toBe('still bad');
  });

  it('uploads demo_request rows against the demo conversion action', async () => {
    withSecrets();
    const demoId = await seedEvent({ gclid: 'gDemo', kind: 'demo_request', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.conversions).toHaveLength(1);
        expect(body.conversions[0].gclid).toBe('gDemo');
        expect(body.conversions[0].conversion_action).toBe(
          'customers/1001841562/conversionActions/333333',
        );
        return adsSuccessResponse(1);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.attempted).toBe(1);
    expect(result.uploaded).toBe(1);

    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, demoId);
    expect(row!.oci_uploaded_at).toBe(FIXED_NOW);
  });

  it('uploads sign_up rows against the sign_up conversion action', async () => {
    withSecrets();
    const signUpId = await seedEvent({ gclid: 'gSignup', kind: 'sign_up', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.conversions).toHaveLength(1);
        expect(body.conversions[0].gclid).toBe('gSignup');
        expect(body.conversions[0].conversion_action).toBe(
          'customers/1001841562/conversionActions/444444',
        );
        return adsSuccessResponse(1);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.attempted).toBe(1);
    expect(result.uploaded).toBe(1);

    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, signUpId);
    expect(row!.oci_uploaded_at).toBe(FIXED_NOW);
  });

  it('sign_up action unset: sign_up rows stay pending, other kinds still upload, stale sign_up rows expire', async () => {
    withSecrets();
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP;
    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;
    const feedId = await seedEvent({ gclid: 'gFeed', kind: 'feed_exported', ts: FIXED_NOW - 2000 });
    const signUpId = await seedEvent({ gclid: 'gSignup', kind: 'sign_up', ts: FIXED_NOW - 1000 });
    const staleSignUpId = await seedEvent({ gclid: 'gSignupOld', kind: 'sign_up', ts: FIXED_NOW - ninetyOneDays });

    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        // Only the feed_exported row goes up — sign_up is unconfigured.
        expect(body.conversions).toHaveLength(1);
        expect(body.conversions[0].gclid).toBe('gFeed');
        return adsSuccessResponse(1);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.attempted).toBe(1);
    expect(result.uploaded).toBe(1);
    expect(result.skippedExpired).toBe(1); // stale sign_up row expired even while unconfigured

    const feed = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, feedId);
    const signUp = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, signUpId);
    const stale = await dbGet<{ oci_uploaded_at: number | null; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_last_error FROM event WHERE id = ?`, staleSignUpId,
    );
    expect(feed!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(signUp!.oci_uploaded_at).toBeNull(); // pending until the action is configured
    expect(stale!.oci_uploaded_at).toBe(-1);
    expect(stale!.oci_last_error).toMatch(/expired/i);
  });

  it('demo action unset: demo_request rows stay pending, other kinds still upload, stale demo rows expire', async () => {
    withSecrets();
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST;
    const ninetyOneDays = 91 * 24 * 60 * 60 * 1000;
    const feedId = await seedEvent({ gclid: 'gFeed', kind: 'feed_exported', ts: FIXED_NOW - 2000 });
    const demoId = await seedEvent({ gclid: 'gDemo', kind: 'demo_request', ts: FIXED_NOW - 1000 });
    const staleDemoId = await seedEvent({ gclid: 'gDemoOld', kind: 'demo_request', ts: FIXED_NOW - ninetyOneDays });

    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        // Only the feed_exported row goes up — demo_request is unconfigured.
        expect(body.conversions).toHaveLength(1);
        expect(body.conversions[0].gclid).toBe('gFeed');
        return adsSuccessResponse(1);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.attempted).toBe(1);
    expect(result.uploaded).toBe(1);
    expect(result.skippedExpired).toBe(1); // stale demo row expired even while unconfigured

    const feed = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, feedId);
    const demo = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, demoId);
    const stale = await dbGet<{ oci_uploaded_at: number | null; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_last_error FROM event WHERE id = ?`, staleDemoId,
    );
    expect(feed!.oci_uploaded_at).toBe(FIXED_NOW);
    expect(demo!.oci_uploaded_at).toBeNull(); // pending until the action is configured
    expect(stale!.oci_uploaded_at).toBe(-1);
    expect(stale!.oci_last_error).toMatch(/expired/i);
  });

  it('idempotent: a second run does not re-upload already-uploaded rows', async () => {
    withSecrets();
    await seedEvent({ gclid: 'gA', kind: 'feed_exported' });

    let adsCalls = 0;
    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        adsCalls++;
        return adsSuccessResponse(1);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const r1 = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(r1.uploaded).toBe(1);
    const r2 = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(r2.attempted).toBe(0);
    expect(r2.uploaded).toBe(0);
    expect(adsCalls).toBe(1); // Ads API was only called once
  });

  it('OAuth failure surfaces as an error (does not silently swallow)', async () => {
    withSecrets();
    await seedEvent({ gclid: 'g', kind: 'feed_exported' });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      throw new Error('Ads API should not be called when OAuth fails');
    });

    await expect(uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now }))
      .rejects.toThrow(/OAuth token exchange failed/);
  });

  it('REGRESSION: detects a real camelCase partialFailureError instead of marking it uploaded', async () => {
    // This is the exact failure that hid a month-long outage: Google returns a
    // per-row rejection in camelCase, the old snake_case parser saw nothing, and
    // the row was marked uploaded. The row MUST be marked failed, not uploaded.
    withSecrets();
    const id = await seedEvent({ gclid: 'gReject', kind: 'paywall_view', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        return adsPartialFailureResponse([{
          index: 0,
          code: 'CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE',
          message: 'New integrations for uploading click conversions should use the Data Manager API.',
        }]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.uploaded).toBe(0);
    expect(result.failedThisRun).toBe(1);
    expect(result.errors[0]?.message).toMatch(/Data Manager API/);

    const row = await dbGet<{ oci_uploaded_at: number | null; oci_attempts: number; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_attempts, oci_last_error FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBeNull(); // NOT marked uploaded
    expect(row!.oci_attempts).toBe(1);
    expect(row!.oci_last_error).toMatch(/Data Manager API/);
  });

  it('SAFETY NET: a partial failure with no parseable row index fails the whole batch', async () => {
    withSecrets();
    const id = await seedEvent({ gclid: 'gWeird', kind: 'feed_exported', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) {
        // partialFailureError present, but no conversions[N] index anywhere.
        return new Response(JSON.stringify({
          partialFailureError: { code: 3, message: 'INTERNAL: something went wrong', details: [] },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.uploaded).toBe(0);
    expect(result.failedThisRun).toBe(1);

    const row = await dbGet<{ oci_uploaded_at: number | null; oci_last_error: string | null }>(
      `SELECT oci_uploaded_at, oci_last_error FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBeNull();
    expect(row!.oci_last_error).toMatch(/something went wrong/);
  });

  it('ENV GATE: does not upload from a non-production origin', async () => {
    withSecrets();
    (testEnv as unknown as Record<string, unknown>).APP_ORIGIN = 'https://staging.gtfsx.com';
    await seedEvent({ gclid: 'gStaging', kind: 'feed_exported', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(() => {
      throw new Error('no network call may happen on a non-prod origin');
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.configured).toBe(false);
    expect(result.skippedReason).toMatch(/non-production origin/);
    expect(result.attempted).toBe(0);

    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event`);
    expect(row!.oci_uploaded_at).toBeNull(); // untouched
  });
});

// ─── Data Manager API path ──────────────────────────────────────────────────

describe('OCI: readDataManagerConfig', () => {
  beforeEach(() => { clearSecrets(); });

  it('returns null without the DM refresh token + project id', () => {
    withSecrets(); // legacy secrets only
    expect(readDataManagerConfig(testEnv)).toBeNull();
  });

  it('returns config when the DM secrets are present', () => {
    withDataManager();
    const cfg = readDataManagerConfig(testEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.projectId).toBe('gtfsx-ads-oci');
    expect(cfg!.operatingAccountId).toBe('1001841562');
    expect(cfg!.loginAccountId).toBe('9998887777');
    expect(cfg!.conversionActions.feed_exported).toBe('111111');
    expect(cfg!.conversionActions.sign_up).toBe('444444');
  });
});

describe('OCI: buildAdIdentifiers / buildIngestBody', () => {
  const baseRow = (over: Partial<PendingRow>): PendingRow => ({
    id: 'evt-1', ts: Date.UTC(2026, 4, 26, 14, 0, 0), kind: 'feed_exported',
    gclid: null, gbraid: null, wbraid: null, attempts: 0, ...over,
  });

  it('prefers gclid, then gbraid, then wbraid', () => {
    expect(buildAdIdentifiers(baseRow({ gclid: 'g', gbraid: 'gb', wbraid: 'wb' }))).toEqual({ gclid: 'g' });
    expect(buildAdIdentifiers(baseRow({ gbraid: 'gb', wbraid: 'wb' }))).toEqual({ gbraid: 'gb' });
    expect(buildAdIdentifiers(baseRow({ wbraid: 'wb' }))).toEqual({ wbraid: 'wb' });
  });

  it('builds the events:ingest body with destination, dedup id, RFC3339 time', () => {
    withDataManager();
    const cfg = readDataManagerConfig(testEnv)!;
    const body = buildIngestBody(cfg, baseRow({ id: 'evt-9', gclid: 'gABC', kind: 'paywall_view' }));
    expect(body).toMatchObject({
      destinations: [{
        operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '1001841562' },
        loginAccount: { accountType: 'GOOGLE_ADS', accountId: '9998887777' },
        productDestinationId: '222222',
      }],
      events: [{
        eventTimestamp: '2026-05-26T14:00:00.000Z',
        transactionId: 'evt-9',
        eventSource: 'WEB',
        adIdentifiers: { gclid: 'gABC' },
      }],
      validateOnly: false,
    });
  });

  it('omits loginAccount when no manager id is configured', () => {
    withDataManager();
    delete (testEnv as unknown as Record<string, unknown>).GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    const cfg = readDataManagerConfig(testEnv)!;
    const body = buildIngestBody(cfg, baseRow({ gclid: 'g' })) as { destinations: Array<Record<string, unknown>> };
    expect(body.destinations[0].loginAccount).toBeUndefined();
    expect(body.destinations[0].operatingAccount).toBeDefined();
  });
});

describe('OCI: uploadPendingConversions via Data Manager', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
    await dbRun(`DELETE FROM event`);
    clearSecrets();
    (testEnv as unknown as Record<string, unknown>).APP_ORIGIN = 'https://www.gtfsx.com';
  });

  it('uploads via events:ingest (not the legacy endpoint) and marks the row', async () => {
    withDataManager();
    const id = await seedEvent({ gclid: 'gA', kind: 'paywall_view', ts: FIXED_NOW - 1000 });

    let ingestBody: Record<string, unknown> | null = null;
    let ingestHeaders: Record<string, string> = {};
    let legacyCalled = false;
    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('uploadClickConversions')) { legacyCalled = true; return adsSuccessResponse(1); }
      if (url.includes('datamanager.googleapis.com/v1/events:ingest')) {
        ingestBody = JSON.parse(String(init?.body ?? '{}'));
        ingestHeaders = (init?.headers ?? {}) as Record<string, string>;
        return dmSuccessResponse();
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.configured).toBe(true);
    expect(result.uploaded).toBe(1);
    expect(result.failedThisRun).toBe(0);
    expect(legacyCalled).toBe(false); // DM path only

    expect(ingestHeaders['x-goog-user-project']).toBe('gtfsx-ads-oci');
    expect(ingestHeaders['Authorization']).toBe('Bearer access-xyz');
    const ev = (ingestBody as unknown as { events: Array<{ transactionId: string; adIdentifiers: unknown }> }).events[0];
    expect(ev.transactionId).toBe(id);
    expect(ev.adIdentifiers).toEqual({ gclid: 'gA' });

    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, id);
    expect(row!.oci_uploaded_at).toBe(FIXED_NOW);
  });

  it('uploads a gbraid-only row with adIdentifiers.gbraid', async () => {
    withDataManager();
    const id = await seedEvent({ gclid: null, gbraid: 'GB123', kind: 'demo_request', ts: FIXED_NOW - 1000 });

    let ident: unknown = null;
    const fetchMock = stubFetch(({ url, init }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('events:ingest')) {
        const b = JSON.parse(String(init?.body ?? '{}'));
        ident = b.events[0].adIdentifiers;
        return dmSuccessResponse();
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.uploaded).toBe(1);
    expect(ident).toEqual({ gbraid: 'GB123' });
    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, id);
    expect(row!.oci_uploaded_at).toBe(FIXED_NOW);
  });

  it('does NOT mark a row uploaded when events:ingest returns HTTP 403 (not allowlisted)', async () => {
    withDataManager();
    const id = await seedEvent({ gclid: 'gBad', kind: 'feed_exported', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('events:ingest')) {
        return new Response('{"error":{"code":403,"message":"PERMISSION_DENIED"}}', { status: 403 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.uploaded).toBe(0);
    expect(result.failedThisRun).toBe(1);
    expect(result.errors[0]?.message).toMatch(/HTTP 403/);
    const row = await dbGet<{ oci_uploaded_at: number | null; oci_attempts: number }>(
      `SELECT oci_uploaded_at, oci_attempts FROM event WHERE id = ?`, id,
    );
    expect(row!.oci_uploaded_at).toBeNull();
    expect(row!.oci_attempts).toBe(1);
  });

  it('treats a 200 body carrying an error as a failure (no silent success)', async () => {
    withDataManager();
    const id = await seedEvent({ gclid: 'gErr', kind: 'feed_exported', ts: FIXED_NOW - 1000 });

    const fetchMock = stubFetch(({ url }) => {
      if (url.includes('oauth2.googleapis.com')) return oauthResponse();
      if (url.includes('events:ingest')) {
        return new Response(JSON.stringify({ error: { message: 'INVALID_ARGUMENT: bad gclid' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await uploadPendingConversions(testEnv, { fetch: fetchMock as unknown as typeof fetch, now });
    expect(result.uploaded).toBe(0);
    expect(result.failedThisRun).toBe(1);
    const row = await dbGet<{ oci_uploaded_at: number | null }>(`SELECT oci_uploaded_at FROM event WHERE id = ?`, id);
    expect(row!.oci_uploaded_at).toBeNull();
  });
});
