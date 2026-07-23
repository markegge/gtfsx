import { ulid } from 'ulidx';
import type { Env } from '../env';
import { generateToken, sha256Hex } from '../util/crypto';
import { rateLimit } from '../util/rateLimit';
import { logAudit } from '../util/audit';
import { rateLimited, twofaInvalidCode, twofaExpired } from '../util/errors';
import { send2faCode } from '../email';
import { smsAvailable, startVerification, checkVerification } from '../sms';

// Two-factor challenge lifecycle: create + send a 6-digit code, verify/consume
// it, and resend. Codes are single-use, TTL-bounded, and attempt-capped. Only
// hashes are stored at rest — a leaked DB row exposes neither the client token
// nor the code. Codes never appear in logs or audit payloads.

// 'enroll_phone' is the SMS-only handoff that verifies a NEW phone number
// before it's stored on the user (distinct from 'enroll', which turns a method
// on once the phone is already verified).
export type TwofaPurpose = 'login' | 'enroll' | 'disable' | 'enroll_phone';
export type TwofaMethod = 'email' | 'sms';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 5;             // wrong codes before the challenge is dead
const MAX_SENDS = 3;                // initial send + up to 2 resends
const RESEND_COOLDOWN_SEC = 60;

// Rate limits (per the shared KV limiter). Sends are per-user; verifies per-IP.
const SEND_LIMIT = 5;              // 2fa:send:{userId} per hour
const SEND_WINDOW_SEC = 3600;
const VERIFY_LIMIT = 20;           // 2fa:verify:{ip} per hour
const VERIFY_WINDOW_SEC = 3600;

interface ChallengeRow {
  id: string;
  user_id: string;
  code_hash: string;
  purpose: TwofaPurpose;
  method: TwofaMethod;
  metadata_json: string | null;
  attempts: number;
  sends: number;
  expires_at: number;
  last_sent_at: number;
  consumed_at: number | null;
  email: string;
  phone: string | null;
}

/** Uniform 6-digit code (rejection-sampled so there's no modulo bias). */
function generateCode(): string {
  const max = 1_000_000;
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return (n % max).toString().padStart(6, '0');
}

/** The challenge id salts the code hash so identical codes hash differently. */
function codeHash(challengeId: string, code: string): Promise<string> {
  return sha256Hex(`${challengeId}:${code}`);
}

// Constant-time compare of two equal-length hex strings (same XOR-fold pattern
// as util/crypto.constantTimeEqual and auth/google.timingSafeEqual). Both sides
// are fixed-length SHA-256 hex here, so this never short-circuits on real input.
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mask an email for display, e.g. mark@eateggs.com → m•••@e•••.com. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = `${local[0]}•••`;
  const dot = domain.lastIndexOf('.');
  if (dot < 1) return `${maskedLocal}@${(domain[0] ?? '')}•••`;
  return `${maskedLocal}@${domain[0]}•••${domain.slice(dot)}`;
}

/** Mask a phone for display, e.g. +14065551234 → •••-•••-1234. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `•••-•••-${digits.slice(-4)}`;
}

/** Whether the Twilio Verify secrets are configured (drives sms_available). */
export function twilioConfigured(env: Env): boolean {
  return smsAvailable(env);
}

/** The user's stored E.164 phone, or null. Used to target an SMS challenge. */
async function lookupPhone(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT phone FROM user WHERE id = ?`)
    .bind(userId)
    .first<{ phone: string | null }>();
  return row?.phone ?? null;
}

/**
 * Whether login must be gated by 2FA, and which method to challenge with. True
 * iff the user has enrolled a method OR any org they belong to requires 2FA.
 * For org-required users who haven't enrolled, we fall back to an email code.
 */
export async function twofaRequirement(
  env: Env,
  userId: string,
): Promise<{ required: boolean; method: TwofaMethod }> {
  const row = await env.DB.prepare(`SELECT twofa_method FROM user WHERE id = ?`)
    .bind(userId)
    .first<{ twofa_method: string }>();
  const userMethod = (row?.twofa_method ?? 'none') as 'none' | TwofaMethod;
  if (userMethod !== 'none') {
    return { required: true, method: userMethod };
  }
  const orgRequired = await env.DB.prepare(
    `SELECT 1 AS n FROM organization_membership m
       JOIN organization o ON o.id = m.org_id
      WHERE m.user_id = ? AND o.require_2fa = 1 AND o.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return { required: !!orgRequired, method: 'email' };
}

export interface StartChallengeOpts {
  user: { id: string; email: string };
  purpose: TwofaPurpose;
  method: TwofaMethod;
  metadata?: Record<string, unknown>;
  /**
   * For SMS: the E.164 number to text. Defaults to the user's stored phone when
   * omitted — the phone-enrollment flow passes it explicitly because the number
   * isn't on the user row yet.
   */
  phone?: string;
  ip?: string | null;
}

export interface StartedChallenge {
  token: string;
  method: TwofaMethod;
  destination: string;
  resendCooldownSec: number;
}

/**
 * Create a fresh challenge row, send the code, and return the opaque client
 * token plus a masked destination. Enforces the per-user hourly send cap.
 *
 * Email codes are generated + hashed here and delivered via Resend. SMS codes
 * are generated, delivered, and checked by Twilio Verify — we only start the
 * verification and store an empty code_hash; the row still owns the token,
 * attempt cap, TTL, and purpose. An 'sms' challenge with no phone on file
 * (should never happen — the method is only set after phone verification)
 * degrades to an email code so the user isn't locked out.
 */
export async function startChallenge(env: Env, opts: StartChallengeOpts): Promise<StartedChallenge> {
  await rateLimit(env, { key: `2fa:send:${opts.user.id}`, limit: SEND_LIMIT, windowSec: SEND_WINDOW_SEC });

  const id = ulid();
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  let sendMethod: TwofaMethod = 'email';
  let destination = maskEmail(opts.user.email);
  let codeHashValue = '';
  let emailCode = '';

  if (opts.method === 'sms') {
    const phone = opts.phone ?? (await lookupPhone(env, opts.user.id));
    if (phone) {
      // Twilio texts the code. This runs BEFORE the INSERT so a bad number or
      // an outage surfaces as an error without leaving an orphaned row.
      await startVerification(env, phone);
      sendMethod = 'sms';
      destination = maskPhone(phone);
    }
    // else: no phone → fall through as an email code (graceful degradation).
  }

  if (sendMethod === 'email') {
    emailCode = generateCode();
    codeHashValue = await codeHash(id, emailCode);
  }

  await env.DB.prepare(
    `INSERT INTO twofa_challenge
       (id, user_id, token_hash, code_hash, purpose, method, metadata_json,
        attempts, sends, created_at, expires_at, last_sent_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      opts.user.id,
      tokenHash,
      codeHashValue,
      opts.purpose,
      sendMethod,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      now,
      now + CODE_TTL_MS,
      now,
    )
    .run();

  if (sendMethod === 'email') {
    await send2faCode(env, opts.user.email, emailCode);
  }

  await logAudit(env, {
    actorUserId: opts.user.id,
    subjectType: 'session',
    subjectId: opts.user.id,
    action: 'session.twofa_challenged',
    metadata: { purpose: opts.purpose, method: sendMethod },
    ip: opts.ip,
  });

  return {
    token,
    method: sendMethod,
    destination,
    resendCooldownSec: RESEND_COOLDOWN_SEC,
  };
}

async function resolveChallenge(env: Env, token: string): Promise<ChallengeRow | null> {
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT c.id, c.user_id, c.code_hash, c.purpose, c.method, c.metadata_json,
            c.attempts, c.sends, c.expires_at, c.last_sent_at, c.consumed_at,
            u.email AS email, u.phone AS phone
       FROM twofa_challenge c
       JOIN user u ON u.id = c.user_id
      WHERE c.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<ChallengeRow>();
}

/** The pending phone stored on an enroll_phone challenge, if any. */
function pendingPhoneOf(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    return typeof meta.pendingPhone === 'string' ? meta.pendingPhone : null;
  } catch {
    return null;
  }
}

/**
 * Shared post-check bookkeeping for a submitted code. On a wrong code, bump
 * attempts (the final allowed attempt kills the challenge) and throw; on a
 * correct code, consume the row. Used by both the token-resolved verify path
 * and the user-resolved phone-enrollment path.
 */
async function recordAttempt(
  env: Env,
  row: { id: string; user_id: string; purpose: TwofaPurpose; attempts: number },
  correct: boolean,
  ip?: string | null,
): Promise<void> {
  if (!correct) {
    const attempts = row.attempts + 1;
    await env.DB.prepare(`UPDATE twofa_challenge SET attempts = ? WHERE id = ?`)
      .bind(attempts, row.id)
      .run();
    await logAudit(env, {
      actorUserId: row.user_id,
      subjectType: 'session',
      subjectId: row.user_id,
      action: 'session.twofa_failed',
      metadata: { purpose: row.purpose },
      ip,
    });
    // The last allowed attempt invalidates the challenge — report it as expired
    // so a caller can't keep probing a dead row.
    if (attempts >= MAX_ATTEMPTS) throw twofaExpired();
    throw twofaInvalidCode({ attempts_left: MAX_ATTEMPTS - attempts });
  }

  await env.DB.prepare(`UPDATE twofa_challenge SET consumed_at = ? WHERE id = ?`)
    .bind(Date.now(), row.id)
    .run();
  await logAudit(env, {
    actorUserId: row.user_id,
    subjectType: 'session',
    subjectId: row.user_id,
    action: 'session.twofa_verified',
    metadata: { purpose: row.purpose },
    ip,
  });
}

export interface VerifiedChallenge {
  userId: string;
  purpose: TwofaPurpose;
  method: TwofaMethod;
  metadata: Record<string, unknown> | null;
}

export interface VerifyOpts {
  token: string;
  code: string;
  allowedPurposes: TwofaPurpose[];
  /** When set, the challenge must belong to this user (account-side confirm). */
  requireUserId?: string;
  ip?: string | null;
}

/**
 * Verify a submitted code against a challenge and consume it on success.
 * Enforces the per-IP verify cap, the attempt cap, TTL, single-use, and purpose
 * isolation. Throws `twofa_invalid_code` (with attempts_left) on a wrong code
 * and `twofa_expired` for a dead/expired/purpose-mismatched challenge.
 */
export async function verifyChallengeCode(env: Env, opts: VerifyOpts): Promise<VerifiedChallenge> {
  await rateLimit(env, { key: `2fa:verify:${opts.ip ?? 'unknown'}`, limit: VERIFY_LIMIT, windowSec: VERIFY_WINDOW_SEC });

  const row = await resolveChallenge(env, opts.token);
  // Unknown token, wrong owner, wrong purpose, consumed, expired, or already
  // attempt-capped → uniformly "expired". Never distinguishes these to a caller.
  if (
    !row ||
    (opts.requireUserId && row.user_id !== opts.requireUserId) ||
    !opts.allowedPurposes.includes(row.purpose) ||
    row.consumed_at !== null ||
    row.expires_at <= Date.now() ||
    row.attempts >= MAX_ATTEMPTS
  ) {
    throw twofaExpired();
  }

  let correct: boolean;
  if (row.method === 'sms') {
    // Twilio Verify owns the SMS code. Check against the pending phone during
    // enrollment (not yet on the user), otherwise the user's stored phone.
    const phone = pendingPhoneOf(row.metadata_json) ?? row.phone;
    correct = phone ? await checkVerification(env, phone, opts.code) : false;
  } else {
    const expected = await codeHash(row.id, opts.code);
    correct = constantTimeEqualHex(expected, row.code_hash);
  }

  await recordAttempt(env, row, correct, opts.ip);

  return {
    userId: row.user_id,
    purpose: row.purpose,
    method: row.method,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
  };
}

export interface PhoneEnrollmentResult {
  /** The E.164 number that was just verified. */
  phone: string;
}

/**
 * Verify the code for a pending phone enrollment. Unlike the login/enroll/
 * disable flows the client holds no challenge token here — the number is being
 * added inside an authenticated session — so we resolve the latest live
 * `enroll_phone` challenge by user id, check the code against Twilio Verify for
 * the pending phone, and consume it. The caller stores the number + consent.
 */
export async function verifyPhoneEnrollment(
  env: Env,
  opts: { userId: string; code: string; ip?: string | null },
): Promise<PhoneEnrollmentResult> {
  await rateLimit(env, { key: `2fa:verify:${opts.ip ?? 'unknown'}`, limit: VERIFY_LIMIT, windowSec: VERIFY_WINDOW_SEC });

  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT id, user_id, purpose, metadata_json, attempts
       FROM twofa_challenge
      WHERE user_id = ? AND purpose = 'enroll_phone'
        AND consumed_at IS NULL AND expires_at > ? AND attempts < ?
      ORDER BY created_at DESC
      LIMIT 1`,
  )
    .bind(opts.userId, now, MAX_ATTEMPTS)
    .first<{ id: string; user_id: string; purpose: TwofaPurpose; metadata_json: string | null; attempts: number }>();
  if (!row) throw twofaExpired();

  const phone = pendingPhoneOf(row.metadata_json);
  if (!phone) throw twofaExpired();

  const approved = await checkVerification(env, phone, opts.code);
  await recordAttempt(env, row, approved, opts.ip);
  return { phone };
}

/**
 * Regenerate the code on an existing challenge (same row, new code_hash) and
 * resend it. Enforces the 60s cooldown and the 3-send cap; both surface as
 * 429 rate_limited. A dead/expired challenge is `twofa_expired`.
 */
export async function resendChallenge(
  env: Env,
  opts: { token: string; ip?: string | null },
): Promise<{ resendCooldownSec: number }> {
  const row = await resolveChallenge(env, opts.token);
  if (!row || row.consumed_at !== null || row.expires_at <= Date.now() || row.attempts >= MAX_ATTEMPTS) {
    throw twofaExpired();
  }
  if (row.sends >= MAX_SENDS) {
    throw rateLimited('Too many codes sent — start again');
  }
  const now = Date.now();
  if (now - row.last_sent_at < RESEND_COOLDOWN_SEC * 1000) {
    throw rateLimited(`Please wait ${RESEND_COOLDOWN_SEC}s before requesting another code`);
  }

  await rateLimit(env, { key: `2fa:send:${row.user_id}`, limit: SEND_LIMIT, windowSec: SEND_WINDOW_SEC });

  if (row.method === 'sms') {
    // Twilio issues a new code on a fresh Verification start; our code_hash
    // stays unused. Target the pending phone (enrollment) or the stored phone.
    const phone = pendingPhoneOf(row.metadata_json) ?? row.phone;
    if (!phone) throw twofaExpired();
    await startVerification(env, phone);
    await env.DB.prepare(`UPDATE twofa_challenge SET sends = sends + 1, last_sent_at = ? WHERE id = ?`)
      .bind(now, row.id)
      .run();
  } else {
    const code = generateCode();
    const ch = await codeHash(row.id, code);
    await env.DB.prepare(
      `UPDATE twofa_challenge SET code_hash = ?, sends = sends + 1, last_sent_at = ? WHERE id = ?`,
    )
      .bind(ch, now, row.id)
      .run();
    await send2faCode(env, row.email, code);
  }

  return { resendCooldownSec: RESEND_COOLDOWN_SEC };
}

/**
 * Cron helper: drop expired or consumed challenge rows. Live challenges are
 * left alone. Returns the number of rows removed.
 */
export async function reapExpiredTwofaChallenges(env: Env): Promise<{ deleted: number }> {
  const res = await env.DB.prepare(
    `DELETE FROM twofa_challenge WHERE expires_at < ? OR consumed_at IS NOT NULL`,
  )
    .bind(Date.now())
    .run();
  const deleted = res.meta?.changes ?? 0;
  if (deleted) console.log(`[cron] reapExpiredTwofaChallenges deleted=${deleted}`);
  return { deleted };
}
