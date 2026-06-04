import { Hono } from 'hono';
import type { AppContext } from '../env';
import { clientIp, rateLimit } from '../util/rateLimit';
import { errorDetail } from '../util/redact';

// ─── Canonical MobilityData GTFS validator proxy ─────────────────────────────
//
// Lets the editor validate the current feed against the *hosted* MobilityData
// GTFS validator (https://gtfs-validator.mobilitydata.org) — the same canonical
// Java validator that powers gtfs.org's web tool — and surface its notices next
// to our in-app findings.
//
// The MobilityData web flow (verified live 2026-06-04, validator v8.0.1):
//   1. POST {API}/create-job  {countryCode}        → { jobId, url }
//        `url` is a 15-minute signed Google Cloud Storage PUT URL.
//   2. PUT  {url}  (Content-Type: application/octet-stream)  ← the GTFS .zip
//        Done by the *client* directly (GCS allows CORS PUT from any origin),
//        so multi-MB feeds never transit the Worker.
//   3. Poll {RESULTS}/{jobId}/report.html (HEAD) until 200 — report is ready.
//      Then {RESULTS}/{jobId}/execution_result.json has {status:"success"}.
//   4. GET  {RESULTS}/{jobId}/report.json  → { summary, notices[] }.
//
// All three MobilityData hosts return `Access-Control-Allow-Origin: *`, so in
// principle the browser could call them directly. We proxy steps 1, 3 and 4
// through the Worker anyway so that: the validator host lives in one place;
// future CORS/endpoint churn doesn't break the client; we can normalize the
// notices shape; and we get server-side timeouts + rate limiting. The big
// upload (step 2) stays client→GCS direct on purpose.
//
// Each Worker invocation does at most ONE poll check and returns quickly — the
// *client* drives the polling loop, so we never tie up a Worker waiting minutes
// for a slow validation.

// Production MobilityData endpoints (web/pipeline/prd.env in their repo).
const VALIDATOR_API_ROOT = 'https://gtfs-validator-web-mbzoxaljzq-ue.a.run.app';
const VALIDATOR_RESULTS_ROOT = 'https://gtfs-validator-results.mobilitydata.org';

// MobilityData's signed upload URL is for an object named `gtfs-job.zip` with no
// declared size cap; their service runs on Cloud Run with finite memory, and we
// don't want to hand out upload slots for absurd feeds. 200 MB is comfortably
// above any feed our editor produces while staying sane. (Enforced client-side
// before upload; mirrored here as documentation of the contract.)
const MAX_FEED_BYTES = 200 * 1024 * 1024;

const UPSTREAM_TIMEOUT_MS = 20_000; // per upstream call

// Country codes are ISO 3166-1 alpha-2 (e.g. "US", "CA") or empty for "unknown"
// (MobilityData uses "ZZ" internally). Keep validation strict but tolerant.
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

// Job ids are UUIDv4 from MobilityData. Validate to avoid path injection into
// the results URL.
const JOB_ID_RE = /^[0-9a-fA-F-]{36}$/;

// Rate limit: validation is a heavier, third-party-dependent operation.
const RATE_LIMIT = 30;
const RATE_WINDOW_SEC = 60 * 60; // 30 validations / hour / IP

interface ProxyError extends Error {
  status: number;
  code: string;
}

function proxyError(status: number, code: string, message: string): ProxyError {
  const e = new Error(message) as ProxyError;
  e.status = status;
  e.code = code;
  return e;
}

function errorResponse(err: ProxyError): Response {
  return new Response(JSON.stringify({ error: err.code, message: err.message }), {
    status: err.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function isProxyError(e: unknown): e is ProxyError {
  return !!e && typeof e === 'object' && 'code' in e && 'status' in e;
}

async function upstreamFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw proxyError(
        504,
        'validator_timeout',
        'The MobilityData validator service did not respond in time. Try again in a moment.',
      );
    }
    throw proxyError(
      502,
      'validator_unreachable',
      'Could not reach the MobilityData validator service. Try again later.',
    );
  } finally {
    clearTimeout(timer);
  }
}

// ─── Canonical report.json shape (validator v8) ──────────────────────────────
// {
//   summary: { validatorVersion, validatedAt, countryCode, ... },
//   notices: [ { code, severity, totalNotices, sampleNotices: [ {...} ] } ]
// }
interface CanonicalSampleNotice {
  [field: string]: unknown;
}
interface CanonicalNotice {
  code: string;
  severity: string; // ERROR | WARNING | INFO
  totalNotices: number;
  sampleNotices: CanonicalSampleNotice[];
}
interface CanonicalReport {
  summary?: { validatorVersion?: string; validatedAt?: string; countryCode?: string };
  notices?: CanonicalNotice[];
}

export const validatorRouter = new Hono<AppContext>();

// POST /api/validator/create-job  { countryCode? }
// → { jobId, uploadUrl }  (signed GCS PUT URL; valid ~15 min)
validatorRouter.post('/create-job', async (c) => {
  const ip = clientIp(c.req.raw);
  try {
    await rateLimit(c.env, { key: `validator:${ip}`, limit: RATE_LIMIT, windowSec: RATE_WINDOW_SEC });

    let body: { countryCode?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine — country code is optional.
      body = {};
    }
    let countryCode = '';
    if (body.countryCode != null && body.countryCode !== '') {
      if (typeof body.countryCode !== 'string' || !COUNTRY_CODE_RE.test(body.countryCode)) {
        throw proxyError(400, 'invalid_country', 'Country code must be a 2-letter ISO code.');
      }
      countryCode = body.countryCode.toUpperCase();
    }

    const res = await upstreamFetch(`${VALIDATOR_API_ROOT}/create-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No `url` → the service returns a signed upload URL for us to PUT the zip.
      body: JSON.stringify({ countryCode }),
    });
    if (!res.ok) {
      throw proxyError(
        502,
        'validator_error',
        `The MobilityData validator returned ${res.status} when starting the job.`,
      );
    }
    const job = await res.json<{ jobId?: string; url?: string }>();
    if (!job?.jobId || !job?.url) {
      throw proxyError(502, 'validator_error', 'The validator response was missing the job id or upload URL.');
    }

    return new Response(
      JSON.stringify({ jobId: job.jobId, uploadUrl: job.url, maxBytes: MAX_FEED_BYTES }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    if (isProxyError(err)) return errorResponse(err);
    console.error(`[validator] create-job error: ${errorDetail(err)}`);
    return errorResponse(proxyError(500, 'internal', 'Something went wrong starting validation.'));
  }
});

// GET /api/validator/report?jobId=<uuid>
// One poll cycle:
//   - report not ready yet            → 200 { status: 'pending' }
//   - validator reported a failure    → 200 { status: 'failed', error }
//   - report ready                    → 200 { status: 'done', report: {...} }
// The client calls this on an interval until status !== 'pending'.
validatorRouter.get('/report', async (c) => {
  try {
    const jobId = c.req.query('jobId');
    if (!jobId || !JOB_ID_RE.test(jobId)) {
      throw proxyError(400, 'invalid_job_id', 'A valid job id is required.');
    }
    const base = `${VALIDATOR_RESULTS_ROOT}/${jobId}`;

    // Is the report ready? HEAD report.html is the readiness signal the official
    // client uses. A 404 just means "still running".
    const head = await upstreamFetch(`${base}/report.html`, { method: 'HEAD' });
    if (head.status === 404) {
      return c.json({ status: 'pending' });
    }
    if (!head.ok) {
      throw proxyError(502, 'validator_error', `Validator results store returned ${head.status}.`);
    }

    // Ready — confirm the run succeeded, then pull the machine-readable report.
    const execRes = await upstreamFetch(`${base}/execution_result.json`, { method: 'GET' });
    if (execRes.ok) {
      const exec = await execRes
        .json<{ status?: string; error?: string }>()
        .catch(() => ({}) as { status?: string; error?: string });
      const status = (exec?.status ?? '').trim().toUpperCase();
      if (status && status !== 'SUCCESS') {
        return c.json({
          status: 'failed',
          error: exec?.error || 'The MobilityData validator could not process this feed.',
        });
      }
    }

    const reportRes = await upstreamFetch(`${base}/report.json`, { method: 'GET' });
    if (!reportRes.ok) {
      // report.html exists but report.json doesn't yet — treat as still pending
      // rather than erroring, so the client keeps polling briefly.
      if (reportRes.status === 404) return c.json({ status: 'pending' });
      throw proxyError(502, 'validator_error', `Could not fetch the validation report (${reportRes.status}).`);
    }
    const report = await reportRes.json<CanonicalReport>();

    const notices = (report.notices ?? []).map((n) => ({
      code: String(n.code ?? 'unknown'),
      severity: String(n.severity ?? 'INFO').toUpperCase(),
      totalNotices: Number(n.totalNotices ?? 0),
      sampleNotices: Array.isArray(n.sampleNotices) ? n.sampleNotices.slice(0, 5) : [],
    }));

    return c.json({
      status: 'done',
      report: {
        validatorVersion: report.summary?.validatorVersion ?? null,
        validatedAt: report.summary?.validatedAt ?? null,
        countryCode: report.summary?.countryCode ?? null,
        notices,
      },
    });
  } catch (err) {
    if (isProxyError(err)) return errorResponse(err);
    console.error(`[validator] report error: ${errorDetail(err)}`);
    return errorResponse(proxyError(500, 'internal', 'Something went wrong fetching the validation report.'));
  }
});

// Exported for tests.
export const _internal = {
  VALIDATOR_API_ROOT,
  VALIDATOR_RESULTS_ROOT,
  MAX_FEED_BYTES,
  JOB_ID_RE,
  COUNTRY_CODE_RE,
};
