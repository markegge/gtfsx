import type { Env } from '../env';

// Thin wrapper around Twilio Verify's REST API for SMS two-factor codes.
// Mirrors worker/email/index.ts's style: no SDK, just the tiny REST surface we
// use. Twilio GENERATES, delivers, and CHECKS the one-time code — our
// twofa_challenge row only tracks the login/enrollment handoff around it (token,
// attempts, TTL, purpose). For method='sms' the challenge's code_hash is unused
// and verification delegates to VerificationCheck.
//
// Never log the code or a full phone number.

const VERIFY_BASE = 'https://verify.twilio.com/v2/Services';

export type TwilioVerifyErrorKind = 'invalid_number' | 'rate_limited' | 'unavailable' | 'unknown';

/** A typed Twilio Verify failure the API layer maps to a clean HTTP status. */
export class TwilioVerifyError extends Error {
  readonly kind: TwilioVerifyErrorKind;
  constructor(kind: TwilioVerifyErrorKind, message: string) {
    super(message);
    this.name = 'TwilioVerifyError';
    this.kind = kind;
  }
}

/** All three Twilio Verify secrets present → SMS 2FA is available. */
export function smsAvailable(env: Env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);
}

function authHeader(env: Env): string {
  // HTTP basic auth: base64("AccountSid:AuthToken").
  return 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
}

function serviceUrl(env: Env, resource: string): string {
  return `${VERIFY_BASE}/${env.TWILIO_VERIFY_SERVICE_SID}/${resource}`;
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Map a Twilio error response to our typed error. Twilio uses numeric `code`s:
// 60200 invalid parameter (bad number), 60205 SMS to a landline, 21211 invalid
// 'To', 60203 max send attempts, and a 429 status for rate limits. We never
// echo the phone or code back.
function classifyError(httpStatus: number, body: Record<string, unknown>): TwilioVerifyError {
  const code = typeof body.code === 'number' ? body.code : undefined;
  if (code === 60200 || code === 60205 || code === 21211 || code === 21611 || code === 60033) {
    return new TwilioVerifyError('invalid_number', 'That phone number is not a valid SMS destination');
  }
  if (httpStatus === 429 || code === 60203 || code === 60202) {
    return new TwilioVerifyError('rate_limited', 'Too many verification attempts — try again later');
  }
  return new TwilioVerifyError('unknown', `Twilio Verify error (status ${httpStatus})`);
}

async function post(env: Env, resource: string, form: Record<string, string>): Promise<Response> {
  return fetch(serviceUrl(env, resource), {
    method: 'POST',
    headers: {
      Authorization: authHeader(env),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
}

/**
 * Start (or restart) an SMS verification: Twilio texts a fresh code to
 * `phoneE164`. Throws a typed {@link TwilioVerifyError} on an invalid number,
 * a rate limit, or an unreachable/erroring Twilio.
 */
export async function startVerification(env: Env, phoneE164: string): Promise<void> {
  if (!smsAvailable(env)) throw new TwilioVerifyError('unavailable', 'SMS verification is not configured');
  let res: Response;
  try {
    res = await post(env, 'Verifications', { To: phoneE164, Channel: 'sms' });
  } catch {
    throw new TwilioVerifyError('unknown', 'Could not reach Twilio Verify');
  }
  if (!res.ok) {
    throw classifyError(res.status, await safeJson(res));
  }
}

/**
 * Check a submitted code against Twilio Verify. Returns `true` iff Twilio
 * approves it. A wrong code (status 'pending') or a missing/expired
 * verification (404 — expired on Twilio's side, already consumed, or never
 * started) is a clean `false`; transport / rate-limit failures throw.
 */
export async function checkVerification(env: Env, phoneE164: string, code: string): Promise<boolean> {
  if (!smsAvailable(env)) throw new TwilioVerifyError('unavailable', 'SMS verification is not configured');
  let res: Response;
  try {
    res = await post(env, 'VerificationCheck', { To: phoneE164, Code: code });
  } catch {
    throw new TwilioVerifyError('unknown', 'Could not reach Twilio Verify');
  }
  // 404 = no pending verification for this number → treat as a wrong/expired
  // code, not a transport error.
  if (res.status === 404) return false;
  if (!res.ok) {
    throw classifyError(res.status, await safeJson(res));
  }
  const body = await safeJson(res);
  return body.status === 'approved' || body.valid === true;
}
