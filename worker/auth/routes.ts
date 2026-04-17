import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, AuthedUser } from '../env';
import {
  conflict,
  forbidden,
  invalidCredentials,
  validationFailed,
} from '../util/errors';
import { hashPassword, verifyPassword } from '../util/crypto';
import { rateLimit, clientIp } from '../util/rateLimit';
import { logAudit } from '../util/audit';
import {
  createSession,
  revokeSession,
  revokeAllSessions,
  sessionCookie,
  clearSessionCookie,
} from './session';
import {
  createAuthToken,
  resolveAuthToken,
  consumeAuthToken,
  invalidateAuthTokensForUser,
} from './tokens';
import { requireAuth } from './middleware';
import { sendVerifyEmail, sendMagicLink, sendPasswordReset } from '../email';

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(10).max(256);
const displayNameSchema = z.string().trim().min(1).max(120);

const signupSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
});

const emailOnlySchema = z.object({ email: emailSchema });

const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

// Equalizes timing between "user not found" and "bad password". Generated lazily once.
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('timing-equalizer-' + ulid());
  return dummyHashPromise;
}

// Fixed minimum latency on signup paths to avoid leaking existence via response-time skew.
// The delay must settle even when `work()` throws — otherwise the conflict path returns
// faster than the success path and the email-taken check becomes observable.
async function withMinDelay<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await work();
  } finally {
    const remaining = ms - (Date.now() - start);
    if (remaining > 0) {
      await new Promise<void>((res) => setTimeout(res, remaining));
    }
  }
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  status: AuthedUser['status'];
  staff: number;
  deleted_at: number | null;
}

async function findUserByEmail(env: AppContext['Bindings'], email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, status, staff, deleted_at FROM user WHERE email = ?`,
  )
    .bind(email)
    .first<UserRow>();
}

function shapeUser(row: UserRow): AuthedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    staff: row.staff === 1,
  };
}

async function parseJson<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw validationFailed('Invalid JSON body');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed('Invalid request', { issues: result.error.issues });
  }
  return result.data;
}

export const authRouter = new Hono<AppContext>();

authRouter.get('/ping', (c) => c.json({ ok: true }));

// ─── Signup ────────────────────────────────────────────────────────────────
authRouter.post('/signup', async (c) => {
  const body = await parseJson(c, signupSchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:signup:ip:${ip}`, limit: 5, windowSec: 3600 });
  await rateLimit(c.env, { key: `auth:signup:email:${body.email}`, limit: 3, windowSec: 3600 });

  await withMinDelay(200, async () => {
    const existing = await findUserByEmail(c.env, body.email);
    if (existing && existing.status !== 'deleted_soft') {
      throw conflict('Account already exists — sign in instead');
    }

    const now = Date.now();
    const userId = ulid();
    await c.env.DB.prepare(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES (?, ?, ?, 'pending_verification', 0, ?, ?)`,
    )
      .bind(userId, body.email, body.displayName, now, now)
      .run();

    const passwordHash = await hashPassword(body.password);
    await c.env.DB.prepare(
      `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
       VALUES (?, ?, 'password', ?, ?, ?)`,
    )
      .bind(ulid(), userId, passwordHash, now, now)
      .run();

    const token = await createAuthToken(c.env, { kind: 'verify_email', userId });
    const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
    await sendVerifyEmail(c.env, body.email, link);

    await logAudit(c.env, {
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      action: 'user.signup',
      ip,
    });
  });

  return c.body(null, 204);
});

// ─── Verify email ──────────────────────────────────────────────────────────
authRouter.get('/verify', async (c) => {
  const token = c.req.query('token');
  const invalidRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/verify-email?status=invalid`, 302);
  if (!token) return invalidRedirect();

  const resolved = await resolveAuthToken(c.env, token, 'verify_email');
  if (!resolved || resolved.consumedAt || resolved.expiresAt <= Date.now() || !resolved.userId) {
    return invalidRedirect();
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending_verification'`,
  )
    .bind(now, resolved.userId)
    .run();
  await consumeAuthToken(c.env, resolved.tokenHash);

  const session = await createSession(c.env, {
    userId: resolved.userId,
    ip: clientIp(c.req.raw),
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: resolved.userId,
    subjectType: 'user',
    subjectId: resolved.userId,
    action: 'user.verify_email',
    ip: clientIp(c.req.raw),
  });

  return c.redirect(`${c.env.APP_ORIGIN}/?welcome=1`, 302);
});

// ─── Resend verification email ─────────────────────────────────────────────
authRouter.post('/verify-resend', requireAuth, async (c) => {
  const user = c.var.user!;
  if (user.status === 'active') throw conflict('Email already verified');

  await rateLimit(c.env, { key: `auth:verify-resend:user:${user.id}`, limit: 3, windowSec: 3600 });

  await invalidateAuthTokensForUser(c.env, user.id, 'verify_email');
  const token = await createAuthToken(c.env, { kind: 'verify_email', userId: user.id });
  const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
  await sendVerifyEmail(c.env, user.email, link);

  return c.body(null, 204);
});

// ─── Login ─────────────────────────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await parseJson(c, loginSchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:login:ip:${ip}`, limit: 10, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:login:email:${body.email}`, limit: 5, windowSec: 600 });

  const user = await findUserByEmail(c.env, body.email);
  const credential = user
    ? await c.env.DB.prepare(
        `SELECT password_hash FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
      )
        .bind(user.id)
        .first<{ password_hash: string | null }>()
    : null;

  if (!user || !credential?.password_hash) {
    // Equalize timing with a dummy verify.
    await verifyPassword(body.password, await dummyHash());
    throw invalidCredentials();
  }

  const ok = await verifyPassword(body.password, credential.password_hash);
  if (!ok) throw invalidCredentials();

  if (user.status === 'deleted_soft' || user.status === 'disabled') {
    throw forbidden('Account unavailable');
  }

  const session = await createSession(c.env, {
    userId: user.id,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'session',
    subjectId: user.id,
    action: 'session.login',
    metadata: { method: 'password' },
    ip,
  });

  return c.json({ user: shapeUser(user) });
});

// ─── Magic link request ────────────────────────────────────────────────────
authRouter.post('/magic-link/request', async (c) => {
  const body = await parseJson(c, emailOnlySchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:magic:ip:${ip}`, limit: 3, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:magic:email:${body.email}`, limit: 2, windowSec: 600 });

  const user = await findUserByEmail(c.env, body.email);
  if (user && user.status !== 'deleted_soft') {
    const token = await createAuthToken(c.env, { kind: 'magic_link', userId: user.id });
    const link = `${c.env.APP_ORIGIN}/auth/magic-link/consume?token=${token}`;
    await sendMagicLink(c.env, user.email, link);
    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'session',
      subjectId: user.id,
      action: 'session.magic_link_requested',
      ip,
    });
  }

  return c.body(null, 204);
});

// ─── Magic link consume ────────────────────────────────────────────────────
authRouter.get('/magic-link/consume', async (c) => {
  const token = c.req.query('token');
  const failRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/login?error=magic_link_invalid`, 302);
  if (!token) return failRedirect();

  const resolved = await resolveAuthToken(c.env, token, 'magic_link');
  if (!resolved || resolved.consumedAt || resolved.expiresAt <= Date.now() || !resolved.userId) {
    return failRedirect();
  }

  const userRow = await c.env.DB.prepare(
    `SELECT id, email, display_name, status, staff, deleted_at FROM user WHERE id = ?`,
  )
    .bind(resolved.userId)
    .first<UserRow>();
  if (!userRow || userRow.deleted_at || userRow.status === 'deleted_soft' || userRow.status === 'disabled') {
    return failRedirect();
  }

  const now = Date.now();
  if (userRow.status === 'pending_verification') {
    await c.env.DB.prepare(`UPDATE user SET status = 'active', updated_at = ? WHERE id = ?`)
      .bind(now, userRow.id)
      .run();
  }
  await consumeAuthToken(c.env, resolved.tokenHash);

  const ip = clientIp(c.req.raw);
  const session = await createSession(c.env, {
    userId: userRow.id,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: userRow.id,
    subjectType: 'session',
    subjectId: userRow.id,
    action: 'session.login',
    metadata: { method: 'magic_link' },
    ip,
  });

  return c.redirect(`${c.env.APP_ORIGIN}/?welcome=1`, 302);
});

// ─── Password reset: request ───────────────────────────────────────────────
authRouter.post('/password-reset/request', async (c) => {
  const body = await parseJson(c, emailOnlySchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:pwreset:ip:${ip}`, limit: 3, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:pwreset:email:${body.email}`, limit: 2, windowSec: 600 });

  const user = await findUserByEmail(c.env, body.email);
  if (user && user.status !== 'deleted_soft') {
    const token = await createAuthToken(c.env, { kind: 'password_reset', userId: user.id });
    const link = `${c.env.APP_ORIGIN}/reset-password?token=${token}`;
    await sendPasswordReset(c.env, user.email, link);
  }

  return c.body(null, 204);
});

// ─── Password reset: confirm ───────────────────────────────────────────────
authRouter.post('/password-reset/confirm', async (c) => {
  const body = await parseJson(c, passwordResetConfirmSchema);

  const resolved = await resolveAuthToken(c.env, body.token, 'password_reset');
  if (!resolved || resolved.consumedAt || resolved.expiresAt <= Date.now() || !resolved.userId) {
    throw validationFailed('Invalid or expired token');
  }

  const userId = resolved.userId;
  const newHash = await hashPassword(body.password);
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    `SELECT id FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
  )
    .bind(userId)
    .first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE credential SET password_hash = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(newHash, now, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
       VALUES (?, ?, 'password', ?, ?, ?)`,
    )
      .bind(ulid(), userId, newHash, now, now)
      .run();
  }

  await consumeAuthToken(c.env, resolved.tokenHash);
  await invalidateAuthTokensForUser(c.env, userId, 'password_reset');
  await revokeAllSessions(c.env, userId);

  await logAudit(c.env, {
    actorUserId: userId,
    subjectType: 'user',
    subjectId: userId,
    action: 'user.password_reset',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Logout ────────────────────────────────────────────────────────────────
authRouter.post('/logout', requireAuth, async (c) => {
  const session = c.var.session!;
  await revokeSession(c.env, session.id);
  c.header('Set-Cookie', clearSessionCookie());
  await logAudit(c.env, {
    actorUserId: session.userId,
    subjectType: 'session',
    subjectId: session.id,
    action: 'session.logout',
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// ─── Logout all ────────────────────────────────────────────────────────────
authRouter.post('/logout-all', requireAuth, async (c) => {
  const user = c.var.user!;
  await revokeAllSessions(c.env, user.id);
  c.header('Set-Cookie', clearSessionCookie());
  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'session',
    subjectId: user.id,
    action: 'session.logout_all',
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});
