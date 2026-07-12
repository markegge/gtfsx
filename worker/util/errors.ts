import { HTTPException } from 'hono/http-exception';

// Thin wrappers around Hono's HTTPException that give us consistent error
// bodies ({ error: code, message: ... }) and typed codes.

export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'invalid_credentials'
  | 'email_unverified'
  | 'email_send_failed'
  | 'token_invalid'
  | 'token_expired'
  | 'rt_breakage'
  | 'agency_id_churn'
  | 'bad_gateway'
  | 'payment_required'
  | 'internal';

export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 502 | 503, code: ErrorCode, message: string, extra?: Record<string, unknown>) {
    super(status, {
      res: new Response(JSON.stringify({ error: code, message, ...extra }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    });
  }
}

export const unauthenticated = (msg = 'Sign in required') => new ApiError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (msg: string, extra?: Record<string, unknown>) => new ApiError(409, 'conflict', msg, extra);
export const validationFailed = (msg: string, extra?: Record<string, unknown>) => new ApiError(422, 'validation_failed', msg, extra);
export const rateLimited = (msg = 'Too many requests') => new ApiError(429, 'rate_limited', msg);
export const quotaExceeded = (msg: string, extra?: Record<string, unknown>) => new ApiError(409, 'quota_exceeded', msg, extra);
export const invalidCredentials = () => new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
export const emailUnverified = (extra?: Record<string, unknown>) =>
  new ApiError(403, 'email_unverified', 'Please verify your email address before signing in', extra);
export const emailSendFailed = () =>
  new ApiError(502, 'email_send_failed', 'Verification email send failed. Please contact the administrator.');
export const tokenInvalid = () => new ApiError(400, 'token_invalid', 'Invalid or unknown token');
export const tokenExpired = () => new ApiError(400, 'token_expired', 'This link has expired — please request a new one');
export const rtBreakage = (extra?: Record<string, unknown>) =>
  new ApiError(409, 'rt_breakage', 'Publishing this version will break your GTFS-Realtime feed', extra);
// agency_id churn (C2). Unlike rt_breakage this fires for EVERY project, RT or
// not: FTA's enhanced P-50 form crosswalks a published feed to its NTD ID by
// agency_id, so dropping/renaming an agency_id silently breaks the NTD
// crosswalk (and any consumer keyed on agency_id). Non-blocking — the caller
// acknowledges with ignoreAgencyChurn.
export const agencyIdChurn = (extra?: Record<string, unknown>) =>
  new ApiError(
    409,
    'agency_id_churn',
    'This snapshot removes or renames agency_id values that are in your published feed. ' +
      "FTA's P-50 NTD crosswalk — and any consumer keyed on agency_id — is matched on those IDs " +
      'and will break. Keep the existing agency_id values, or publish anyway to accept the churn.',
    extra,
  );
export const badGateway = (msg = 'Upstream service error', extra?: Record<string, unknown>) =>
  new ApiError(502, 'bad_gateway', msg, extra);
export const paymentRequired = (msg: string, extra?: Record<string, unknown>) =>
  new ApiError(402, 'payment_required', msg, extra);
