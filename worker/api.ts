import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext } from './env';
import { requireAuth } from './auth/middleware';
import {
  conflict,
  forbidden,
  invalidCredentials,
  validationFailed,
} from './util/errors';
import { hashPassword, verifyPassword } from './util/crypto';
import { logAudit } from './util/audit';
import { clientIp } from './util/rateLimit';
import { revokeAllSessions, revokeSession } from './auth/session';
import {
  createAuthToken,
  resolveAuthToken,
  consumeAuthToken,
  invalidateAuthTokensForUser,
} from './auth/tokens';
import { sendVerifyEmail } from './email';
import { projectsRouter } from './projects/routes';

const emailSchema = z.string().trim().toLowerCase().email();
const passwordSchema = z.string().min(10).max(256);
const displayNameSchema = z.string().trim().min(1).max(120);

const patchMeSchema = z.object({
  displayName: displayNameSchema.optional(),
});

const changeEmailSchema = z.object({
  newEmail: emailSchema,
});

const changeEmailConfirmSchema = z.object({
  token: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

const deleteMeSchema = z.object({
  password: z.string().min(1).max(256).optional(),
});

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

export const apiRouter = new Hono<AppContext>();

apiRouter.get('/me', requireAuth, (c) => {
  const user = c.var.user!;
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      staff: user.staff,
    },
    usage: null,
  });
});

apiRouter.patch('/me', requireAuth, async (c) => {
  const body = await parseJson(c, patchMeSchema);
  const user = c.var.user!;

  if (body.displayName !== undefined) {
    const now = Date.now();
    await c.env.DB.prepare(`UPDATE user SET display_name = ?, updated_at = ? WHERE id = ?`)
      .bind(body.displayName, now, user.id)
      .run();
    await logAudit(c.env, {
      actorUserId: user.id,
      subjectType: 'user',
      subjectId: user.id,
      action: 'user.update_profile',
      metadata: { displayName: true },
      ip: clientIp(c.req.raw),
    });
  }

  const row = await c.env.DB.prepare(
    `SELECT id, email, display_name, status, staff FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<{ id: string; email: string; display_name: string; status: typeof user.status; staff: number }>();
  if (!row) throw forbidden('Account unavailable');

  return c.json({
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      staff: row.staff === 1,
    },
  });
});

apiRouter.post('/me/change-email', requireAuth, async (c) => {
  const body = await parseJson(c, changeEmailSchema);
  const user = c.var.user!;

  if (body.newEmail === user.email) {
    throw conflict('New email is the same as current email');
  }
  const existing = await c.env.DB.prepare(
    `SELECT id FROM user WHERE email = ? AND (deleted_at IS NULL)`,
  )
    .bind(body.newEmail)
    .first<{ id: string }>();
  if (existing) {
    throw conflict('That email is already in use');
  }

  await invalidateAuthTokensForUser(c.env, user.id, 'verify_email');
  const token = await createAuthToken(c.env, {
    kind: 'verify_email',
    userId: user.id,
    email: body.newEmail,
    metadata: { targetEmail: body.newEmail, flow: 'change_email' },
  });
  const link = `${c.env.APP_ORIGIN}/change-email?token=${token}`;
  await sendVerifyEmail(c.env, body.newEmail, link);

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'user.change_email_requested',
    metadata: { targetEmail: body.newEmail },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

apiRouter.post('/me/change-email/confirm', requireAuth, async (c) => {
  const body = await parseJson(c, changeEmailConfirmSchema);
  const user = c.var.user!;

  const resolved = await resolveAuthToken(c.env, body.token, 'verify_email');
  if (
    !resolved
    || resolved.consumedAt
    || resolved.expiresAt <= Date.now()
    || resolved.userId !== user.id
    || resolved.metadata?.flow !== 'change_email'
  ) {
    throw validationFailed('Invalid or expired token');
  }
  const target = resolved.metadata?.targetEmail;
  if (typeof target !== 'string') throw validationFailed('Invalid token metadata');

  // Re-check collision at confirm time to avoid a race.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM user WHERE email = ? AND id != ? AND (deleted_at IS NULL)`,
  )
    .bind(target, user.id)
    .first<{ id: string }>();
  if (existing) throw conflict('That email is already in use');

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE user SET email = ?, updated_at = ? WHERE id = ?`)
    .bind(target, now, user.id)
    .run();
  await consumeAuthToken(c.env, resolved.tokenHash);

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'user.change_email',
    metadata: { oldEmail: user.email, newEmail: target },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

apiRouter.post('/me/change-password', requireAuth, async (c) => {
  const body = await parseJson(c, changePasswordSchema);
  const user = c.var.user!;
  const session = c.var.session!;

  const credential = await c.env.DB.prepare(
    `SELECT id, password_hash FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
  )
    .bind(user.id)
    .first<{ id: string; password_hash: string | null }>();
  if (!credential?.password_hash) throw invalidCredentials();

  const ok = await verifyPassword(body.currentPassword, credential.password_hash);
  if (!ok) throw invalidCredentials();

  const newHash = await hashPassword(body.newPassword);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE credential SET password_hash = ?, updated_at = ? WHERE id = ?`)
    .bind(newHash, now, credential.id)
    .run();

  // Revoke all other sessions; keep this one active.
  await c.env.DB.prepare(
    `UPDATE session SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
  )
    .bind(now, user.id, session.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'user.change_password',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

apiRouter.delete('/me', requireAuth, async (c) => {
  const body = await parseJson(c, deleteMeSchema);
  const user = c.var.user!;
  const session = c.var.session!;

  const credential = await c.env.DB.prepare(
    `SELECT id, password_hash FROM credential WHERE user_id = ? AND kind = 'password' LIMIT 1`,
  )
    .bind(user.id)
    .first<{ id: string; password_hash: string | null }>();

  if (credential?.password_hash) {
    if (!body.password) throw validationFailed('Password confirmation required');
    const ok = await verifyPassword(body.password, credential.password_hash);
    if (!ok) throw invalidCredentials();
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user SET status = 'deleted_soft', deleted_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(now, now, user.id)
    .run();
  await revokeAllSessions(c.env, user.id);
  await revokeSession(c.env, session.id);

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'user.delete',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

apiRouter.route('/projects', projectsRouter);
// Phase 4 agent will mount: apiRouter.route('/orgs', orgsRouter).
