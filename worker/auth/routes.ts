import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, AuthedUser } from '../env';
import {
  conflict,
  emailSendFailed,
  emailUnverified,
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
import { googleRouter } from './google';
import { sendVerifyEmail, sendMagicLink, sendPasswordReset, sendWelcomeEmail } from '../email';
import { verifyTurnstile } from '../util/turnstile';

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(10).max(256);
const displayNameSchema = z.string().trim().min(1).max(120);

// `next` is the path to land on after verify-email completes. Used by the
// invitee flow to bounce the user back to /orgs/accept?token=… so they skip
// the tier picker entirely. Validated as a same-origin relative path before
// being honored at redirect time.
//
// `invitationToken` is the raw invitation token from the email link. Its
// presence is the signal that the signing-up user already proved ownership
// of this email address by clicking the invitation (which the server only
// ever sent to that email). When the token resolves and matches the
// submitted email, the user is activated immediately and gets a session —
// no second confirmation email is sent.
const signupSchema = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  turnstileToken: z.string().max(2048).optional(),
  next: z.string().max(512).optional(),
  invitationToken: z.string().max(2048).optional(),
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

// Validate a post-verify redirect path. Must be a same-origin relative path —
// reject anything that could resolve to a different host (`//evil`,
// `http://…`, protocol-relative or absolute URLs). Returns undefined to mean
// "no override; use the default redirect."
function safeNext(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (!raw.startsWith('/')) return undefined;
  if (raw.startsWith('//')) return undefined;
  if (raw.length > 512) return undefined;
  // Disallow control chars + newlines to keep this safe inside Location headers.
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return raw;
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
  plan?: AuthedUser['plan'] | null;
  plan_status?: AuthedUser['planStatus'] | null;
}

async function findUserByEmail(env: AppContext['Bindings'], email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status FROM user WHERE email = ?`,
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
    plan: row.plan ?? 'free',
    planStatus: row.plan_status ?? 'active',
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

// Google OAuth ("Continue with Google"), issue #20. Mounted at /auth/google.
authRouter.route('/google', googleRouter);

// ─── Signup ────────────────────────────────────────────────────────────────
//
// Three paths based on the existing user row:
//   - none / deleted_soft: fresh signup (insert user + credential + token, email).
//   - active / disabled:   409 — the email is in use by a real account.
//   - pending_verification: treat as a *retry*. Refresh the password credential,
//     invalidate outstanding verify tokens, send a new verify email. This
//     recovers users who hit a previous partial-signup bug (user row written
//     but credential INSERT failed — happened with an earlier PBKDF2-600k /
//     workerd ceiling combination). Safe because only the email owner can
//     consume the verify link; an unexpected email is the signal that
//     someone else tried to sign up with this address.
//
// Fresh-signup writes are followed by `sendVerifyEmail`; if that throws we
// roll back the user row (credential + token FK-cascade away) so the email
// isn't stuck in pending_verification limbo.
authRouter.post('/signup', async (c) => {
  const body = await parseJson(c, signupSchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:signup:ip:${ip}`, limit: 10, windowSec: 3600 });
  await rateLimit(c.env, { key: `auth:signup:email:${body.email}`, limit: 6, windowSec: 3600 });
  // Bot gate. Verifies the Turnstile token before any DB write or email
  // send. No-op when the secret isn't configured (dev fallback).
  await verifyTurnstile(c.env, body.turnstileToken, ip);

  // Invitation-token fast path. If the user clicked an invite email link
  // their possession of the token proves they own this address, so we skip
  // the verify-email round-trip and activate immediately. The token must
  // still be live and match the submitted email. We don't consume it here —
  // /api/orgs/invitations/accept will do that when the user joins the org.
  let autoActivate = false;
  if (body.invitationToken) {
    const resolved = await resolveAuthToken(c.env, body.invitationToken, 'invitation');
    if (
      resolved &&
      !resolved.consumedAt &&
      resolved.expiresAt > Date.now() &&
      resolved.email &&
      resolved.email.toLowerCase() === body.email.toLowerCase()
    ) {
      autoActivate = true;
    }
  }

  let autoActivatedUserId: string | null = null;

  await withMinDelay(200, async () => {
    const existing = await findUserByEmail(c.env, body.email);

    if (existing && (existing.status === 'active' || existing.status === 'disabled')) {
      throw conflict('Account already exists — sign in instead');
    }

    if (existing && existing.status === 'pending_verification') {
      // Retry path.
      const now = Date.now();
      const passwordHash = await hashPassword(body.password);

      // Update display name if the caller provided a different one, so users
      // can correct a typo from their first attempt.
      await c.env.DB.prepare(
        `UPDATE user SET display_name = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(body.displayName, now, existing.id)
        .run();

      const existingCred = await c.env.DB.prepare(
        `SELECT id FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
      )
        .bind(existing.id)
        .first<{ id: string }>();

      if (existingCred) {
        await c.env.DB.prepare(
          `UPDATE credential SET password_hash = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(passwordHash, now, existingCred.id)
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
           VALUES (?, ?, 'password', ?, ?, ?)`,
        )
          .bind(ulid(), existing.id, passwordHash, now, now)
          .run();
      }

      // Invitation-driven retry: activate the row and let the caller make a
      // session. Outstanding verify_email tokens get invalidated either way.
      await invalidateAuthTokensForUser(c.env, existing.id, 'verify_email');
      if (autoActivate) {
        await c.env.DB.prepare(
          `UPDATE user SET status = 'active', updated_at = ? WHERE id = ?`,
        )
          .bind(now, existing.id)
          .run();
        autoActivatedUserId = existing.id;
        await logAudit(c.env, {
          actorUserId: existing.id,
          subjectType: 'user',
          subjectId: existing.id,
          action: 'user.signup.activated_by_invitation',
          ip,
        });
        return;
      }
      // Tag this as a signup-flow verification so the post-verify redirect
      // can route the user through the welcome / pick-a-plan step.
      const token = await createAuthToken(c.env, {
        kind: 'verify_email',
        userId: existing.id,
        metadata: { flow: 'signup', next: safeNext(body.next) },
      });
      const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
      try {
        await sendVerifyEmail(c.env, body.email, link);
      } catch (err) {
        console.error('[signup:retry] verify email send failed', err);
        throw emailSendFailed();
      }

      await logAudit(c.env, {
        actorUserId: existing.id,
        subjectType: 'user',
        subjectId: existing.id,
        action: 'user.signup.retry',
        ip,
      });
      return;
    }

    // Fresh signup path (no existing user, or existing is deleted_soft).
    // Invitation-driven fresh signups go straight to active; everything else
    // starts pending_verification and waits for the email click.
    const now = Date.now();
    const userId = ulid();
    const initialStatus = autoActivate ? 'active' : 'pending_verification';
    await c.env.DB.prepare(
      `INSERT INTO user (id, email, display_name, status, staff, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
      .bind(userId, body.email, body.displayName, initialStatus, now, now)
      .run();

    try {
      const passwordHash = await hashPassword(body.password);
      await c.env.DB.prepare(
        `INSERT INTO credential (id, user_id, kind, password_hash, created_at, updated_at)
         VALUES (?, ?, 'password', ?, ?, ?)`,
      )
        .bind(ulid(), userId, passwordHash, now, now)
        .run();

      if (autoActivate) {
        autoActivatedUserId = userId;
        await logAudit(c.env, {
          actorUserId: userId,
          subjectType: 'user',
          subjectId: userId,
          action: 'user.signup.activated_by_invitation',
          ip,
        });
        return;
      }

      const token = await createAuthToken(c.env, {
        kind: 'verify_email',
        userId,
        metadata: { flow: 'signup', next: safeNext(body.next) },
      });
      const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
      await sendVerifyEmail(c.env, body.email, link);
    } catch (err) {
      // Roll back the user row so the email isn't blocked from retrying.
      // FK-cascades wipe any credential + auth_token we may have inserted.
      console.error('[signup] fresh signup failed — rolling back user row', err);
      await c.env.DB.prepare(`DELETE FROM user WHERE id = ?`).bind(userId).run();
      await logAudit(c.env, {
        actorUserId: null,
        subjectType: 'user',
        subjectId: userId,
        action: 'user.signup.rolled_back',
        metadata: { error: err instanceof Error ? err.message : String(err) },
        ip,
      });
      if (err instanceof Error && err.message.includes('Resend')) {
        throw emailSendFailed();
      }
      throw err;
    }

    await logAudit(c.env, {
      actorUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      action: 'user.signup',
      ip,
    });
  });

  // Invitation-driven signup: log the user in right now so the SPA can
  // redirect them straight to /orgs/accept without another round-trip
  // through verify-email. The user shape mirrors /api/me.
  if (autoActivatedUserId) {
    const userId = autoActivatedUserId;
    const userRow = await c.env.DB.prepare(
      `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status
         FROM user WHERE id = ?`,
    ).bind(userId).first<UserRow>();
    if (userRow) {
      const session = await createSession(c.env, {
        userId,
        ip,
        userAgent: c.req.header('User-Agent') ?? null,
      });
      c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));
      await logAudit(c.env, {
        actorUserId: userId,
        subjectType: 'session',
        subjectId: userId,
        action: 'session.login',
        metadata: { method: 'signup_invitation' },
        ip,
      });
      return c.json({ activated: true, user: shapeUser(userRow) });
    }
  }

  return c.json({ activated: false });
});

// ─── Verify email ──────────────────────────────────────────────────────────
// Activates the account, opens a session, and redirects to the editor with a
// welcome flag — mirrors the magic-link consume flow so users land signed in
// without re-entering credentials. The Set-Cookie on a same-origin 302 is the
// same pattern magic-link relies on; both are served by the Worker behind the
// SPA and via the Vite proxy in dev, so the cookie is set against the SPA
// origin and visible on the redirect target.
authRouter.get('/verify', async (c) => {
  const token = c.req.query('token');
  const invalidRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/verify-email?status=invalid`, 302);
  const alreadyVerifiedRedirect = () => c.redirect(`${c.env.APP_ORIGIN}/verify-email?status=already_verified`, 302);
  if (!token) return invalidRedirect();

  const resolved = await resolveAuthToken(c.env, token, 'verify_email');
  if (!resolved || !resolved.userId) {
    return invalidRedirect();
  }
  // Distinguish a re-clicked link (token already consumed for a now-active
  // user) from a genuinely invalid/expired token. The "already verified"
  // case shows friendlier copy + a sign-in CTA instead of a "resend" prompt.
  if (resolved.consumedAt) {
    const alreadyActive = await c.env.DB
      .prepare(`SELECT status FROM user WHERE id = ?`)
      .bind(resolved.userId)
      .first<{ status: string }>();
    if (alreadyActive?.status === 'active') return alreadyVerifiedRedirect();
    return invalidRedirect();
  }
  if (resolved.expiresAt <= Date.now()) return invalidRedirect();

  const userRow = await c.env.DB.prepare(`SELECT id, status, email FROM user WHERE id = ?`)
    .bind(resolved.userId)
    .first<{ id: string; status: string; email: string }>();
  if (!userRow || userRow.status === 'deleted_soft' || userRow.status === 'disabled') {
    return invalidRedirect();
  }
  // The pending_verification row is what we expect; if the user has already
  // been activated (e.g. another verify link from a duplicate signup retry
  // arrived first), short-circuit to the "already verified" page.
  if (userRow.status === 'active') {
    await consumeAuthToken(c.env, resolved.tokenHash);
    return alreadyVerifiedRedirect();
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending_verification'`,
  )
    .bind(now, resolved.userId)
    .run();
  await consumeAuthToken(c.env, resolved.tokenHash);

  const ip = clientIp(c.req.raw);
  const session = await createSession(c.env, {
    userId: resolved.userId,
    ip,
    userAgent: c.req.header('User-Agent') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, session.expiresAt));

  await logAudit(c.env, {
    actorUserId: resolved.userId,
    subjectType: 'user',
    subjectId: resolved.userId,
    action: 'user.verify_email',
    ip,
  });
  await logAudit(c.env, {
    actorUserId: resolved.userId,
    subjectType: 'session',
    subjectId: resolved.userId,
    action: 'session.login',
    metadata: { method: 'verify_email' },
    ip,
  });

  // First activation of a password account → send the one-time welcome email.
  // Best-effort: a Resend hiccup must never block activation or the redirect
  // (mirrors the signup-retry pattern above). The pending→active UPDATE above
  // only runs once per user, so this fires at most once.
  try {
    await sendWelcomeEmail(c.env, userRow.email);
  } catch (err) {
    console.error('[verify] welcome email send failed', err);
  }

  // Signup verifications land on the /pricing page unless the signup carried a
  // `next` (e.g. a /pricing card click carries ?plan= so checkout resumes
  // automatically, or an invitee accepting an org invite goes straight to the
  // accept page). Other verify-email flows fall back to the editor.
  const isSignupFlow = resolved.metadata?.flow === 'signup';
  const next = typeof resolved.metadata?.next === 'string'
    ? safeNext(resolved.metadata.next)
    : undefined;
  const target = next
    ? next
    : isSignupFlow
      ? '/pricing?source=welcome'
      : '/?welcome=1';
  return c.redirect(`${c.env.APP_ORIGIN}${target}`, 302);
});

// ─── Resend verification email ─────────────────────────────────────────────
// Public (no auth) so a user blocked at login by email_unverified can still
// request a fresh link. Always returns 204 — no enumeration.
authRouter.post('/verify-resend', async (c) => {
  const body = await parseJson(c, emailOnlySchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:verify-resend:ip:${ip}`, limit: 10, windowSec: 3600 });
  await rateLimit(c.env, { key: `auth:verify-resend:email:${body.email}`, limit: 6, windowSec: 3600 });

  const user = await findUserByEmail(c.env, body.email);
  if (user && user.status === 'pending_verification') {
    await invalidateAuthTokensForUser(c.env, user.id, 'verify_email');
    // A pending_verification user only exists from a signup that hasn't yet
    // been confirmed, so the resend carries the same signup-flow tag.
    const token = await createAuthToken(c.env, {
      kind: 'verify_email',
      userId: user.id,
      metadata: { flow: 'signup' },
    });
    const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
    try {
      await sendVerifyEmail(c.env, user.email, link);
    } catch (err) {
      console.error('[verify-resend] send failed', err);
      throw emailSendFailed();
    }
  }

  return c.body(null, 204);
});

// ─── Login ─────────────────────────────────────────────────────────────────
authRouter.post('/login', async (c) => {
  const body = await parseJson(c, loginSchema);
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `auth:login:ip:${ip}`, limit: 20, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:login:email:${body.email}`, limit: 10, windowSec: 600 });

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

  if (user.status === 'pending_verification') {
    // Block login but echo the email so the frontend can offer "resend verification email".
    throw emailUnverified({ email: user.email });
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
  await rateLimit(c.env, { key: `auth:magic:ip:${ip}`, limit: 6, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:magic:email:${body.email}`, limit: 4, windowSec: 600 });

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
    `SELECT id, email, display_name, status, staff, deleted_at, plan, plan_status FROM user WHERE id = ?`,
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
  await rateLimit(c.env, { key: `auth:pwreset:ip:${ip}`, limit: 6, windowSec: 600 });
  await rateLimit(c.env, { key: `auth:pwreset:email:${body.email}`, limit: 4, windowSec: 600 });

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
