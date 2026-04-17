import type { Env } from '../env';
import { generateToken, sha256Hex } from '../util/crypto';

// Single-use auth tokens (email verify, magic link, password reset, invitation).
// Cleartext delivered once via email; only the hash is stored.

export type TokenKind = 'verify_email' | 'magic_link' | 'password_reset' | 'invitation';

const TTLS: Record<TokenKind, number> = {
  verify_email: 24 * 60 * 60 * 1000, // 24 h
  magic_link: 15 * 60 * 1000, // 15 min
  password_reset: 60 * 60 * 1000, // 1 h
  invitation: 7 * 24 * 60 * 60 * 1000, // 7 days
};

export interface CreateTokenOpts {
  kind: TokenKind;
  userId?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown>;
  ttlMs?: number;
}

export async function createAuthToken(env: Env, opts: CreateTokenOpts): Promise<string> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const ttl = opts.ttlMs ?? TTLS[opts.kind];
  await env.DB.prepare(
    `INSERT INTO auth_token (token_hash, kind, user_id, email, expires_at, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      tokenHash,
      opts.kind,
      opts.userId ?? null,
      opts.email ?? null,
      now + ttl,
      opts.metadata ? JSON.stringify(opts.metadata) : null,
      now,
    )
    .run();
  return token;
}

export interface ResolvedToken {
  kind: TokenKind;
  userId: string | null;
  email: string | null;
  metadata: Record<string, unknown> | null;
  expiresAt: number;
  consumedAt: number | null;
  tokenHash: string;
}

export async function resolveAuthToken(env: Env, token: string, kind: TokenKind): Promise<ResolvedToken | null> {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT kind, user_id, email, metadata_json, expires_at, consumed_at
       FROM auth_token WHERE token_hash = ? AND kind = ?`,
  )
    .bind(tokenHash, kind)
    .first<{
      kind: TokenKind;
      user_id: string | null;
      email: string | null;
      metadata_json: string | null;
      expires_at: number;
      consumed_at: number | null;
    }>();
  if (!row) return null;
  return {
    kind: row.kind,
    userId: row.user_id,
    email: row.email,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    tokenHash,
  };
}

export async function consumeAuthToken(env: Env, tokenHash: string): Promise<void> {
  await env.DB.prepare(`UPDATE auth_token SET consumed_at = ? WHERE token_hash = ?`)
    .bind(Date.now(), tokenHash)
    .run();
}

export async function invalidateAuthTokensForUser(env: Env, userId: string, kind: TokenKind): Promise<void> {
  // Mark all outstanding tokens of a kind as consumed — used e.g. when a user
  // changes their password to invalidate pending reset links.
  await env.DB.prepare(`UPDATE auth_token SET consumed_at = ? WHERE user_id = ? AND kind = ? AND consumed_at IS NULL`)
    .bind(Date.now(), userId, kind)
    .run();
}
