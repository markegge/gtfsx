import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext } from './env';
import { requireAuth } from './auth/middleware';
import {
  ApiError,
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
import { registerAlertRoutes } from './projects/alerts';
import { computeUserUsage } from './me/usage';
import { buildUserExport, EXPORT_RATE_KEY_PREFIX, EXPORT_RATE_WINDOW_SEC } from './me/export';

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

// FROZEN CONTRACT — the in-app upgrade-nudge frontend POSTs this exact shape.
const proIntentSchema = z.object({
  action: z.enum(['publish_intent', 'feed_cap', 'mini_site', 'mdb_submit', 'checkout_started']),
  source: z.string().max(64).optional(),
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

apiRouter.get('/me', requireAuth, async (c) => {
  const user = c.var.user!;
  const usage = await computeUserUsage(c.env, user.id);
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      staff: user.staff,
      plan: user.plan,
      planStatus: user.planStatus,
    },
    usage: { user: usage },
  });
});

apiRouter.get('/me/usage', requireAuth, async (c) => {
  const user = c.var.user!;
  const userUsage = await computeUserUsage(c.env, user.id);
  return c.json({ user: userUsage });
});

// Record a pro-intent signal (legacy name; now "paid intent") — fired when a
// free user reaches for a paid-gated action (publish, 4th saved feed,
// mini-site/embed, MobilityDatabase submit) or starts Stripe checkout. THE hottest warm-lead signal; surfaced (ranked) by
// GET /api/admin/warm-cohort.csv. Inherits the global X-GB-Client CSRF +
// rate-limit middleware. Cheap and idempotency-free on purpose — multiple fires
// per user are expected and fine. We record it here in authenticated D1
// because the cookieless `event` table is deliberately anonymous (no user_id)
// and can't carry a per-account signal. See migration 0023_pro_intent.sql.
apiRouter.post('/me/pro-intent', requireAuth, async (c) => {
  const body = await parseJson(c, proIntentSchema);
  const user = c.var.user!;
  await c.env.DB.prepare(
    `INSERT INTO pro_intent (id, user_id, ts, action, source) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(ulid(), user.id, Date.now(), body.action, body.source ?? null)
    .run();
  return c.body(null, 204);
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

// ─── Audit log — events visible to the current user ────────────────────────
//
// Visibility rule: events where
//   (a) the user IS the subject (subject_type='user' AND subject_id=user.id),
//   (b) the user is the actor (actor_user_id=user.id),
//   (c) the event is about a project the user owns (subject_type='project'
//       joined to feed_project.owner_type='user' AND owner_id=user.id).
// Paginated by ULID id: pass `before=<last_id_seen>` for the next page.
apiRouter.get('/me/audit', requireAuth, async (c) => {
  const user = c.var.user!;
  const limitRaw = c.req.query('limit');
  const before = c.req.query('before');
  let limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const binds: unknown[] = [user.id, user.id, user.id];
  let beforeClause = '';
  if (before) {
    beforeClause = ' AND e.id < ?';
    binds.push(before);
  }
  binds.push(limit);

  const stmt = `
    SELECT e.id, e.actor_user_id, e.subject_type, e.subject_id, e.action,
           e.metadata_json, e.created_at
      FROM audit_event e
      LEFT JOIN feed_project p ON e.subject_type = 'project' AND p.id = e.subject_id
     WHERE (
             (e.subject_type = 'user' AND e.subject_id = ?)
          OR e.actor_user_id = ?
          OR (e.subject_type = 'project' AND p.owner_type = 'user' AND p.owner_id = ?)
           )
       ${beforeClause}
     ORDER BY e.id DESC
     LIMIT ?
  `;

  const result = await c.env.DB.prepare(stmt)
    .bind(...binds)
    .all<{
      id: string;
      actor_user_id: string | null;
      subject_type: string;
      subject_id: string | null;
      action: string;
      metadata_json: string | null;
      created_at: number;
    }>();

  const events = (result.results ?? []).map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    action: r.action,
    metadataJson: r.metadata_json,
    createdAt: r.created_at,
  }));

  return c.json({ events });
});

// Per-user data export — ZIP with profile.json, audit.json, and every
// personally-owned project's blobs. Rate-limited to 1/24h per user.
apiRouter.get('/me/export', requireAuth, async (c) => {
  const user = c.var.user!;
  const rateKey = `${EXPORT_RATE_KEY_PREFIX}${user.id}`;
  const existing = await c.env.KV.get(rateKey);
  if (existing) {
    throw new ApiError(
      429,
      'rate_limited',
      'Data export limit: 1 per 24 hours. Try again later.',
    );
  }

  const { body, filename } = await buildUserExport(c.env, user);

  // Mark the window as used BEFORE streaming back — even if the client drops
  // the connection, we should still count it to prevent hammering.
  await c.env.KV.put(rateKey, String(Date.now()), { expirationTtl: EXPORT_RATE_WINDOW_SEC });

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'user.data_export',
    ip: clientIp(c.req.raw),
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

registerAlertRoutes(projectsRouter);
apiRouter.route('/projects', projectsRouter);

// ─── SUBROUTER MOUNTS ──────────────────────────────────────────────────────
// /api/me is inline above (auth-adjacent, small). Everything else is in a
// feature module — add new routers here.
import { orgsRouter } from './orgs/routes';
import { adminRouter } from './admin/routes';
import { billingRouter } from './billing/routes';
import { eventsRouter } from './events/routes';
import { importRouter } from './import/routes';
import { forumRouter } from './forum/routes';
import { demoLeadRouter } from './marketing/demoLead';
import { assistantRouter } from './assistant/routes';
apiRouter.route('/orgs', orgsRouter);
apiRouter.route('/admin', adminRouter);
apiRouter.route('/billing', billingRouter);
apiRouter.route('/events', eventsRouter);
apiRouter.route('/import', importRouter);
apiRouter.route('/forum', forumRouter);
// "Ask GTFS·X" embedded help assistant (issue #68). requireAuth per-route; the
// streamed chat endpoint rides the same session + CSRF middleware as /api/*.
apiRouter.route('/assistant', assistantRouter);
// /book-demo lead form submit (the demo_request conversion emission). Public,
// cookieless; inherits the X-GB-Client CSRF check. See worker/marketing/demoLead.ts.
apiRouter.route('/demo-leads', demoLeadRouter);
// Publication and distribution endpoints hang off the projects router
// (/api/projects/:id/publish, /catalog-submissions, etc.) so project-ownership
// checks stay co-located with their endpoints. See worker/projects/routes.ts.
