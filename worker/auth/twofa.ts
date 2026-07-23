import { ulid } from 'ulidx';
import type { Env } from '../env';
import { generateToken, sha256Hex } from '../util/crypto';
import { rateLimit } from '../util/rateLimit';
import { logAudit } from '../util/audit';
import { rateLimited, twofaInvalidCode, twofaExpired } from '../util/errors';
import { send2faCode } from '../email';

// Two-factor challenge lifecycle: create + send a 6-digit code, verify/consume
// it, and resend. Codes are single-use, TTL-bounded, and attempt-capped. Only
// hashes are stored at rest — a leaked DB row exposes neither the client token
// nor the code. Codes never appear in logs or audit payloads.

export type TwofaPurpose = 'login' | 'enroll' | 'disable';
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
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID);
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

/** Deliver a code over the challenge's method. Email today; SMS is phase 2. */
async function deliverCode(env: Env, method: TwofaMethod, email: string, code: string): Promise<void> {
  if (method === 'email') {
    await send2faCode(env, email, code);
    return;
  }
  // SMS delivery arrives with Twilio Verify (phase 2). No code path issues an
  // 'sms' challenge until then, so this is unreachable in phase 1.
  throw new Error('SMS 2FA delivery is not available yet');
}

export interface StartChallengeOpts {
  user: { id: string; email: string };
  purpose: TwofaPurpose;
  method: TwofaMethod;
  metadata?: Record<string, unknown>;
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
 */
export async function startChallenge(env: Env, opts: StartChallengeOpts): Promise<StartedChallenge> {
  await rateLimit(env, { key: `2fa:send:${opts.user.id}`, limit: SEND_LIMIT, windowSec: SEND_WINDOW_SEC });

  const id = ulid();
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const code = generateCode();
  const ch = await codeHash(id, code);
  const now = Date.now();

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
      ch,
      opts.purpose,
      opts.method,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      now,
      now + CODE_TTL_MS,
      now,
    )
    .run();

  await deliverCode(env, opts.method, opts.user.email, code);

  await logAudit(env, {
    actorUserId: opts.user.id,
    subjectType: 'session',
    subjectId: opts.user.id,
    action: 'session.twofa_challenged',
    metadata: { purpose: opts.purpose, method: opts.method },
    ip: opts.ip,
  });

  return {
    token,
    method: opts.method,
    destination: maskEmail(opts.user.email),
    resendCooldownSec: RESEND_COOLDOWN_SEC,
  };
}

async function resolveChallenge(env: Env, token: string): Promise<ChallengeRow | null> {
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    `SELECT c.id, c.user_id, c.code_hash, c.purpose, c.method, c.metadata_json,
            c.attempts, c.sends, c.expires_at, c.last_sent_at, c.consumed_at,
            u.email AS email
       FROM twofa_challenge c
       JOIN user u ON u.id = c.user_id
      WHERE c.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<ChallengeRow>();
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

  const expected = await codeHash(row.id, opts.code);
  if (!constantTimeEqualHex(expected, row.code_hash)) {
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
      ip: opts.ip,
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
    ip: opts.ip,
  });

  return {
    userId: row.user_id,
    purpose: row.purpose,
    method: row.method,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
  };
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

  const code = generateCode();
  const ch = await codeHash(row.id, code);
  await env.DB.prepare(
    `UPDATE twofa_challenge SET code_hash = ?, sends = sends + 1, last_sent_at = ? WHERE id = ?`,
  )
    .bind(ch, now, row.id)
    .run();

  await deliverCode(env, row.method, row.email, code);

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
