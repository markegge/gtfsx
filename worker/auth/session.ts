import { ulid } from 'ulidx';
import type { Env, AuthedUser } from '../env';
import { generateToken, sha256Hex } from '../util/crypto';

// Session model: the cookie value is a random token; we store only its SHA-256
// hash in D1. A leaked DB row does not expose live sessions.
//
// Cookies are HTTP-only, Secure, SameSite=Lax, scoped to the editor origin.
// Idle timeout is enforced on every request by bumping `last_used_at` and
// checking (now - last_used_at > IDLE); absolute timeout uses `expires_at`.

export const SESSION_COOKIE = 'gb_session';
const IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000; // 30 days idle
const ABSOLUTE_TIMEOUT_MS = 90 * 24 * 60 * 60 * 1000; // 90 days absolute

export interface CreateSessionOpts {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(env: Env, opts: CreateSessionOpts): Promise<{ token: string; expiresAt: number }> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + ABSOLUTE_TIMEOUT_MS;
  await env.DB.prepare(
    `INSERT INTO session (id, token_hash, user_id, ip, user_agent, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ulid(), tokenHash, opts.userId, opts.ip ?? null, opts.userAgent ?? null, now, now, expiresAt)
    .run();
  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: AuthedUser;
}

export async function resolveSession(env: Env, token: string): Promise<ResolvedSession | null> {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT
        s.id AS session_id, s.user_id AS user_id, s.last_used_at AS last_used_at, s.expires_at AS expires_at, s.revoked_at AS revoked_at,
        u.email AS email, u.display_name AS display_name, u.status AS status, u.staff AS staff, u.deleted_at AS deleted_at
      FROM session s
      JOIN user u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      session_id: string;
      user_id: string;
      last_used_at: number;
      expires_at: number;
      revoked_at: number | null;
      email: string;
      display_name: string;
      status: AuthedUser['status'];
      staff: number;
      deleted_at: number | null;
    }>();

  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.deleted_at) return null;
  const now = Date.now();
  if (now >= row.expires_at) return null;
  if (now - row.last_used_at >= IDLE_TIMEOUT_MS) return null;

  // Bump last_used_at — but throttle to once per 60s to avoid a write on every request.
  if (now - row.last_used_at > 60 * 1000) {
    await env.DB.prepare(`UPDATE session SET last_used_at = ? WHERE id = ?`)
      .bind(now, row.session_id)
      .run();
  }

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      staff: row.staff === 1,
    },
  };
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`UPDATE session SET revoked_at = ? WHERE id = ?`)
    .bind(Date.now(), sessionId)
    .run();
}

export async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(Date.now(), userId)
    .run();
}

/** Build a Set-Cookie string for the session cookie. */
export function sessionCookie(token: string, expiresAt: number): string {
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000);
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === SESSION_COOKIE && v) return v;
  }
  return null;
}
