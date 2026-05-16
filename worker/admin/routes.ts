import { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, AuthedUser, Env } from '../env';
import { requireAuth, requireStaff } from '../auth/middleware';
import {
  conflict,
  notFound,
  validationFailed,
} from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp, rateLimit } from '../util/rateLimit';
import {
  createSession,
  revokeAllSessions,
  revokeSession,
  sessionCookie,
  SESSION_COOKIE,
} from '../auth/session';
import {
  createAuthToken,
  invalidateAuthTokensForUser,
} from '../auth/tokens';
import { sendVerifyEmail } from '../email';

// ─── Helpers ──────────────────────────────────────────────────────────────

async function parseJson<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
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

const IMPERSONATOR_COOKIE = 'gb_impersonator';

function impersonatorCookie(staffUserId: string): string {
  // Mirror session cookie's attributes but scoped identically. Max-Age matches
  // the absolute session window (90 days) — the impersonation session will
  // typically expire first, but the cookie shouldn't linger past that.
  const maxAge = 90 * 24 * 60 * 60;
  return `${IMPERSONATOR_COOKIE}=${staffUserId}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearImpersonatorCookie(): string {
  return `${IMPERSONATOR_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readImpersonatorCookie(req: Request): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === IMPERSONATOR_COOKIE && v) return v;
  }
  return null;
}

function parsePage(raw: string | undefined, fallback = 1, max = 10_000): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function parsePageSize(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

// Format a ms timestamp to YYYY-WW (ISO week). Zero-padded.
function weekBucket(ms: number): string {
  const d = new Date(ms);
  // ISO week: Monday-based. Clone to UTC and push to nearest Thursday.
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = u.getUTCDay() || 7;
  u.setUTCDate(u.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(u.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((u.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${u.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

// ─── Stats ────────────────────────────────────────────────────────────────

interface AdminStats {
  users: { total: number; active: number; pending_verification: number; disabled: number; deleted_soft: number };
  organizations: { total: number };
  projects: { total: number; byOwnerType: { user: number; org: number } };
  snapshots: { total: number };
  publications: { total: number };
  signups: { last7d: number; last30d: number; allTime: number };
  activeUsers: { last24h: number; last7d: number; last30d: number };
  trend: {
    newUsersByWeek: { week: string; count: number }[];
    newProjectsByWeek: { week: string; count: number }[];
  };
}

const STATS_CACHE_KEY = 'admin:stats';
const STATS_CACHE_TTL = 60; // seconds

async function computeStats(env: Env): Promise<AdminStats> {
  const now = Date.now();
  const d7 = now - 7 * 24 * 60 * 60 * 1000;
  const d30 = now - 30 * 24 * 60 * 60 * 1000;
  const d24h = now - 24 * 60 * 60 * 1000;
  const d8w = now - 8 * 7 * 24 * 60 * 60 * 1000;

  // Users by status.
  const userRows = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM user GROUP BY status`,
  ).all<{ status: string; n: number }>();
  const users = { total: 0, active: 0, pending_verification: 0, disabled: 0, deleted_soft: 0 };
  for (const r of userRows.results ?? []) {
    users.total += r.n;
    if (r.status === 'active') users.active = r.n;
    else if (r.status === 'pending_verification') users.pending_verification = r.n;
    else if (r.status === 'disabled') users.disabled = r.n;
    else if (r.status === 'deleted_soft') users.deleted_soft = r.n;
  }

  // Organizations (excluding soft-deleted).
  const orgRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM organization WHERE deleted_at IS NULL`,
  ).first<{ n: number }>();
  const organizations = { total: orgRow?.n ?? 0 };

  // Projects (non-deleted), grouped by owner_type.
  const projectRows = await env.DB.prepare(
    `SELECT owner_type, COUNT(*) AS n FROM feed_project WHERE deleted_at IS NULL GROUP BY owner_type`,
  ).all<{ owner_type: string; n: number }>();
  const projects = { total: 0, byOwnerType: { user: 0, org: 0 } };
  for (const r of projectRows.results ?? []) {
    projects.total += r.n;
    if (r.owner_type === 'user') projects.byOwnerType.user = r.n;
    else if (r.owner_type === 'org') projects.byOwnerType.org = r.n;
  }

  // Snapshots.
  const snapRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM feed_snapshot`).first<{ n: number }>();
  const snapshots = { total: snapRow?.n ?? 0 };

  // Publications live.
  const pubRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM publication`).first<{ n: number }>();
  const publications = { total: pubRow?.n ?? 0 };

  // Signups buckets.
  const s7 = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`,
  ).bind(d7).first<{ n: number }>();
  const s30 = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user WHERE created_at >= ?`,
  ).bind(d30).first<{ n: number }>();
  const sAll = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM user`,
  ).first<{ n: number }>();
  const signups = {
    last7d: s7?.n ?? 0,
    last30d: s30?.n ?? 0,
    allTime: sAll?.n ?? 0,
  };

  // Active users: distinct session.user_id in each window.
  const a24 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM session WHERE last_used_at >= ?`,
  ).bind(d24h).first<{ n: number }>();
  const a7 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM session WHERE last_used_at >= ?`,
  ).bind(d7).first<{ n: number }>();
  const a30 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM session WHERE last_used_at >= ?`,
  ).bind(d30).first<{ n: number }>();
  const activeUsers = {
    last24h: a24?.n ?? 0,
    last7d: a7?.n ?? 0,
    last30d: a30?.n ?? 0,
  };

  // Trend: trailing 8 weeks. Compute client-side; D1 lacks strftime-week.
  const userTrendRows = await env.DB.prepare(
    `SELECT created_at FROM user WHERE created_at >= ?`,
  ).bind(d8w).all<{ created_at: number }>();
  const projectTrendRows = await env.DB.prepare(
    `SELECT created_at FROM feed_project WHERE created_at >= ? AND deleted_at IS NULL`,
  ).bind(d8w).all<{ created_at: number }>();

  const bucketCounts = (rows: { created_at: number }[]) => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const w = weekBucket(r.created_at);
      map.set(w, (map.get(w) ?? 0) + 1);
    }
    // Produce the trailing 8 week bucket labels in order (oldest to newest),
    // filling zeros for weeks with no entries.
    const out: { week: string; count: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const t = now - i * 7 * 24 * 60 * 60 * 1000;
      const w = weekBucket(t);
      out.push({ week: w, count: map.get(w) ?? 0 });
    }
    return out;
  };

  const trend = {
    newUsersByWeek: bucketCounts(userTrendRows.results ?? []),
    newProjectsByWeek: bucketCounts(projectTrendRows.results ?? []),
  };

  return { users, organizations, projects, snapshots, publications, signups, activeUsers, trend };
}

// ─── Router ───────────────────────────────────────────────────────────────

export const adminRouter = new Hono<AppContext>();

// Every admin route requires an authenticated session; ONLY /end-impersonation
// is allowed to run under a non-staff session (the impersonated user's session),
// gated by the presence of the gb_impersonator cookie. Everything else is
// staff-only (returns 404 for non-staff to avoid surface enumeration).
adminRouter.use('*', requireAuth);
adminRouter.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/api/admin/end-impersonation') return next();
  return requireStaff(c, next);
});

// ─── Stats ────────────────────────────────────────────────────────────────

adminRouter.get('/stats', async (c) => {
  const cached = await c.env.KV.get(STATS_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as AdminStats;
      return c.json(parsed);
    } catch {
      // fall through to recompute
    }
  }
  const stats = await computeStats(c.env);
  await c.env.KV.put(STATS_CACHE_KEY, JSON.stringify(stats), { expirationTtl: STATS_CACHE_TTL });
  return c.json(stats);
});

// ─── Users: list ──────────────────────────────────────────────────────────

interface UserListRow {
  id: string;
  email: string;
  display_name: string;
  status: AuthedUser['status'];
  staff: number;
  created_at: number;
  last_session_at: number | null;
  project_count: number;
}

adminRouter.get('/users', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const status = c.req.query('status');
  const page = parsePage(c.req.query('page'), 1);
  const pageSize = parsePageSize(c.req.query('pageSize'), 25, 200);
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const binds: unknown[] = [];

  if (q) {
    where.push(`LOWER(u.email) LIKE ?`);
    binds.push(`%${q}%`);
  }
  if (status && ['active', 'pending_verification', 'disabled', 'deleted_soft'].includes(status)) {
    where.push(`u.status = ?`);
    binds.push(status);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Fetch pageSize+1 to know whether there's a next page.
  const rowsRes = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.status, u.staff, u.created_at,
            (SELECT MAX(last_used_at) FROM session s WHERE s.user_id = u.id) AS last_session_at,
            (SELECT COUNT(*) FROM feed_project p
                WHERE p.owner_type = 'user' AND p.owner_id = u.id AND p.deleted_at IS NULL) AS project_count
       FROM user u
       ${whereSql}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize + 1, offset)
    .all<UserListRow>();

  const all = rowsRes.results ?? [];
  const has_next = all.length > pageSize;
  const rows = has_next ? all.slice(0, pageSize) : all;

  const users = rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    staff: r.staff === 1,
    createdAt: r.created_at,
    lastSessionAt: r.last_session_at,
    projectCount: r.project_count,
  }));

  const nextCursor = has_next ? rows[rows.length - 1]!.id : null;
  return c.json({ users, nextCursor });
});

// ─── Users: detail ────────────────────────────────────────────────────────

adminRouter.get('/users/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.status, u.staff, u.created_at,
            (SELECT MAX(last_used_at) FROM session s WHERE s.user_id = u.id) AS last_session_at,
            (SELECT COUNT(*) FROM feed_project p
                WHERE p.owner_type = 'user' AND p.owner_id = u.id AND p.deleted_at IS NULL) AS project_count
       FROM user u WHERE u.id = ?`,
  ).bind(id).first<UserListRow>();
  if (!row) throw notFound('User not found');

  const memberships = await c.env.DB.prepare(
    `SELECT m.org_id AS orgId, m.role AS role, o.slug AS slug, o.name AS name
       FROM organization_membership m
       JOIN organization o ON o.id = m.org_id
       WHERE m.user_id = ? AND o.deleted_at IS NULL
       ORDER BY m.created_at DESC`,
  ).bind(id).all<{ orgId: string; role: string; slug: string; name: string }>();

  const audit = await c.env.DB.prepare(
    `SELECT id, actor_user_id, subject_type, subject_id, action, metadata_json, ip, created_at
       FROM audit_event
       WHERE actor_user_id = ? OR (subject_type = 'user' AND subject_id = ?)
       ORDER BY created_at DESC
       LIMIT 20`,
  ).bind(id, id).all<{
    id: string;
    actor_user_id: string | null;
    subject_type: string;
    subject_id: string | null;
    action: string;
    metadata_json: string | null;
    ip: string | null;
    created_at: number;
  }>();

  return c.json({
    user: {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      staff: row.staff === 1,
      createdAt: row.created_at,
      lastSessionAt: row.last_session_at,
      projectCount: row.project_count,
    },
    memberships: memberships.results ?? [],
    auditEvents: (audit.results ?? []).map((e) => ({
      id: e.id,
      actorUserId: e.actor_user_id,
      subjectType: e.subject_type,
      subjectId: e.subject_id,
      action: e.action,
      metadataJson: e.metadata_json,
      ip: e.ip,
      createdAt: e.created_at,
    })),
  });
});

// ─── Users: patch (status / staff) ────────────────────────────────────────

const patchUserSchema = z.object({
  status: z.enum(['active', 'disabled']).optional(),
  staff: z.boolean().optional(),
});

adminRouter.patch('/users/:id', async (c) => {
  const id = c.req.param('id');
  const body = await parseJson(c, patchUserSchema);
  const actor = c.var.user!;

  const existing = await c.env.DB.prepare(
    `SELECT id, status, staff FROM user WHERE id = ?`,
  ).bind(id).first<{ id: string; status: AuthedUser['status']; staff: number }>();
  if (!existing) throw notFound('User not found');

  if (existing.status === 'deleted_soft' && body.status !== undefined) {
    throw conflict('Cannot change status of a deleted user');
  }

  const updates: string[] = [];
  const binds: unknown[] = [];
  if (body.status !== undefined && body.status !== existing.status) {
    updates.push('status = ?');
    binds.push(body.status);
  }
  if (body.staff !== undefined && (body.staff ? 1 : 0) !== existing.staff) {
    updates.push('staff = ?');
    binds.push(body.staff ? 1 : 0);
  }
  if (updates.length === 0) {
    // Return current state anyway.
    return c.json({
      user: {
        id: existing.id,
        status: existing.status,
        staff: existing.staff === 1,
      },
    });
  }

  const now = Date.now();
  updates.push('updated_at = ?');
  binds.push(now);
  binds.push(id);

  await c.env.DB.prepare(
    `UPDATE user SET ${updates.join(', ')} WHERE id = ?`,
  ).bind(...binds).run();

  // If we just disabled the user, also revoke their active sessions.
  if (body.status === 'disabled') {
    await revokeAllSessions(c.env, id);
  }

  await logAudit(c.env, {
    actorUserId: actor.id,
    subjectType: 'user',
    subjectId: id,
    action: 'admin.user.patch',
    metadata: {
      status: body.status ?? null,
      staff: body.staff ?? null,
    },
    ip: clientIp(c.req.raw),
  });

  const refreshed = await c.env.DB.prepare(
    `SELECT id, status, staff FROM user WHERE id = ?`,
  ).bind(id).first<{ id: string; status: AuthedUser['status']; staff: number }>();
  return c.json({
    user: {
      id: refreshed!.id,
      status: refreshed!.status,
      staff: refreshed!.staff === 1,
    },
  });
});

// ─── Users: resend verification ───────────────────────────────────────────

adminRouter.post('/users/:id/resend-verification', async (c) => {
  const id = c.req.param('id');
  const actor = c.var.user!;

  const row = await c.env.DB.prepare(
    `SELECT id, email, status FROM user WHERE id = ?`,
  ).bind(id).first<{ id: string; email: string; status: AuthedUser['status'] }>();
  if (!row) throw notFound('User not found');

  if (row.status !== 'pending_verification') {
    throw conflict('User is not awaiting email verification');
  }

  await invalidateAuthTokensForUser(c.env, id, 'verify_email');
  const token = await createAuthToken(c.env, { kind: 'verify_email', userId: id });
  const link = `${c.env.APP_ORIGIN}/auth/verify?token=${token}`;
  await sendVerifyEmail(c.env, row.email, link);

  await logAudit(c.env, {
    actorUserId: actor.id,
    subjectType: 'user',
    subjectId: id,
    action: 'admin.user.resend_verification',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Users: soft-delete ───────────────────────────────────────────────────

adminRouter.post('/users/:id/delete', async (c) => {
  const id = c.req.param('id');
  const actor = c.var.user!;

  const row = await c.env.DB.prepare(
    `SELECT id, status FROM user WHERE id = ?`,
  ).bind(id).first<{ id: string; status: AuthedUser['status'] }>();
  if (!row) throw notFound('User not found');
  if (row.status === 'deleted_soft') {
    // Idempotent: already deleted.
    return c.body(null, 204);
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user SET status = 'deleted_soft', deleted_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(now, now, id).run();
  await revokeAllSessions(c.env, id);

  await logAudit(c.env, {
    actorUserId: actor.id,
    subjectType: 'user',
    subjectId: id,
    action: 'admin.user.delete',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Impersonation ────────────────────────────────────────────────────────

adminRouter.post('/users/:id/impersonate', async (c) => {
  const targetId = c.req.param('id');
  const staff = c.var.user!;
  const currentSession = c.var.session!;

  if (targetId === staff.id) {
    throw conflict('Cannot impersonate yourself');
  }

  const already = readImpersonatorCookie(c.req.raw);
  if (already) {
    throw conflict('Already impersonating another user — exit first');
  }

  const target = await c.env.DB.prepare(
    `SELECT id, email, status FROM user WHERE id = ?`,
  ).bind(targetId).first<{ id: string; email: string; status: AuthedUser['status'] }>();
  if (!target) throw notFound('User not found');
  if (target.status !== 'active') {
    throw conflict('Cannot impersonate inactive user');
  }

  // Revoke the staff user's current session so it can't be used to bypass
  // impersonation (the impersonator cookie captures their identity for resume).
  await revokeSession(c.env, currentSession.id);

  const ip = clientIp(c.req.raw);
  const userAgent = c.req.header('User-Agent') ?? null;
  const newSession = await createSession(c.env, {
    userId: target.id,
    ip,
    userAgent,
  });

  c.header('Set-Cookie', sessionCookie(newSession.token, newSession.expiresAt), { append: true });
  c.header('Set-Cookie', impersonatorCookie(staff.id), { append: true });

  // Audit on BOTH timelines.
  await logAudit(c.env, {
    actorUserId: staff.id,
    subjectType: 'user',
    subjectId: staff.id,
    action: 'admin.impersonate.start',
    metadata: { targetUserId: target.id, targetEmail: target.email },
    ip,
  });
  await logAudit(c.env, {
    actorUserId: staff.id,
    subjectType: 'user',
    subjectId: target.id,
    action: 'admin.impersonate.start',
    metadata: { targetUserId: target.id, targetEmail: target.email, staffUserId: staff.id },
    ip,
  });

  return c.json({
    user: {
      id: target.id,
      email: target.email,
      status: target.status,
    },
    impersonator: { userId: staff.id },
  });
});

adminRouter.post('/end-impersonation', async (c) => {
  const staffUserId = readImpersonatorCookie(c.req.raw);
  if (!staffUserId) {
    throw validationFailed('No impersonation session in progress');
  }

  // The current session is the impersonated one. The staff user is the
  // identity recorded in the impersonator cookie.
  const impersonatedSession = c.var.session;
  const impersonatedUser = c.var.user;

  // Revoke impersonated session (best effort — may already be revoked).
  if (impersonatedSession) {
    await revokeSession(c.env, impersonatedSession.id);
  }

  // Load the staff user to confirm they're still active + staff.
  const staffRow = await c.env.DB.prepare(
    `SELECT id, email, status, staff FROM user WHERE id = ?`,
  ).bind(staffUserId).first<{ id: string; email: string; status: AuthedUser['status']; staff: number }>();
  if (!staffRow || staffRow.status !== 'active' || staffRow.staff !== 1) {
    // Clear both cookies.
    c.header('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`, { append: true });
    c.header('Set-Cookie', clearImpersonatorCookie(), { append: true });
    throw validationFailed('Staff user no longer eligible');
  }

  const ip = clientIp(c.req.raw);
  const userAgent = c.req.header('User-Agent') ?? null;
  const newSession = await createSession(c.env, {
    userId: staffRow.id,
    ip,
    userAgent,
  });

  c.header('Set-Cookie', sessionCookie(newSession.token, newSession.expiresAt), { append: true });
  c.header('Set-Cookie', clearImpersonatorCookie(), { append: true });

  // Audit on both timelines.
  await logAudit(c.env, {
    actorUserId: staffRow.id,
    subjectType: 'user',
    subjectId: staffRow.id,
    action: 'admin.impersonate.end',
    metadata: impersonatedUser ? { targetUserId: impersonatedUser.id, targetEmail: impersonatedUser.email } : undefined,
    ip,
  });
  if (impersonatedUser) {
    await logAudit(c.env, {
      actorUserId: staffRow.id,
      subjectType: 'user',
      subjectId: impersonatedUser.id,
      action: 'admin.impersonate.end',
      metadata: { staffUserId: staffRow.id, targetUserId: impersonatedUser.id, targetEmail: impersonatedUser.email },
      ip,
    });
  }

  return c.body(null, 204);
});

// ─── Enterprise plan grants (staff-only) ──────────────────────────────────
//
// Bypasses Stripe — no subscription is created. The cached plan column on
// user/org is set to 'enterprise' and (optionally) plan_expires_at is set
// so the nightly cron can downgrade lapsed grants.

const enterpriseGrantSchema = z.object({
  // Unix ms. Null/undefined = open-ended grant (no expiry).
  expiresAt: z.number().int().positive().nullable().optional(),
  note: z.string().max(500).optional(),
});

adminRouter.post('/users/:id/enterprise-grant', async (c) => {
  const staff = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, enterpriseGrantSchema);

  const target = await c.env.DB.prepare(`SELECT id, email FROM user WHERE id = ?`)
    .bind(id)
    .first<{ id: string; email: string }>();
  if (!target) throw notFound('User not found');

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user
        SET plan = 'enterprise', plan_status = 'active',
            plan_expires_at = ?, plan_renewal_at = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(body.expiresAt ?? null, body.expiresAt ?? null, now, id)
    .run();

  await logAudit(c.env, {
    actorUserId: staff.id,
    subjectType: 'user',
    subjectId: id,
    action: 'admin.enterprise_grant',
    metadata: { targetEmail: target.email, expiresAt: body.expiresAt ?? null, note: body.note ?? null },
    ip: clientIp(c.req.raw),
  });

  return c.json({ ok: true, userId: id, expiresAt: body.expiresAt ?? null });
});

adminRouter.post('/orgs/:id/enterprise-grant', async (c) => {
  const staff = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, enterpriseGrantSchema);

  const org = await c.env.DB.prepare(`SELECT id, name FROM organization WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<{ id: string; name: string }>();
  if (!org) throw notFound('Organization not found');

  await c.env.DB.prepare(
    `UPDATE organization
        SET plan = 'enterprise', plan_status = 'active',
            plan_expires_at = ?, plan_renewal_at = ?
      WHERE id = ?`,
  )
    .bind(body.expiresAt ?? null, body.expiresAt ?? null, id)
    .run();

  await logAudit(c.env, {
    actorUserId: staff.id,
    subjectType: 'org',
    subjectId: id,
    action: 'admin.enterprise_grant',
    metadata: { targetOrgName: org.name, expiresAt: body.expiresAt ?? null, note: body.note ?? null },
    ip: clientIp(c.req.raw),
  });

  return c.json({ ok: true, orgId: id, expiresAt: body.expiresAt ?? null });
});

// Revoke an enterprise grant — drops the principal back to 'free'.
adminRouter.post('/users/:id/enterprise-revoke', async (c) => {
  const staff = c.var.user!;
  const id = c.req.param('id');
  const target = await c.env.DB.prepare(`SELECT id, email, plan FROM user WHERE id = ?`)
    .bind(id)
    .first<{ id: string; email: string; plan: string }>();
  if (!target) throw notFound('User not found');
  if (target.plan !== 'enterprise') throw validationFailed('User is not on enterprise plan');

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE user SET plan = 'free', plan_status = 'active', plan_expires_at = NULL, plan_renewal_at = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(now, id)
    .run();
  await logAudit(c.env, {
    actorUserId: staff.id,
    subjectType: 'user',
    subjectId: id,
    action: 'admin.enterprise_revoke',
    metadata: { targetEmail: target.email },
    ip: clientIp(c.req.raw),
  });
  return c.json({ ok: true });
});

adminRouter.post('/orgs/:id/enterprise-revoke', async (c) => {
  const staff = c.var.user!;
  const id = c.req.param('id');
  const target = await c.env.DB.prepare(`SELECT id, name, plan FROM organization WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; plan: string }>();
  if (!target) throw notFound('Organization not found');
  if (target.plan !== 'enterprise') throw validationFailed('Organization is not on enterprise plan');

  await c.env.DB.prepare(
    `UPDATE organization SET plan = 'free', plan_status = 'active', plan_expires_at = NULL, plan_renewal_at = NULL WHERE id = ?`,
  )
    .bind(id)
    .run();
  await logAudit(c.env, {
    actorUserId: staff.id,
    subjectType: 'org',
    subjectId: id,
    action: 'admin.enterprise_revoke',
    metadata: { targetOrgName: target.name },
    ip: clientIp(c.req.raw),
  });
  return c.json({ ok: true });
});

// ─── Organizations ────────────────────────────────────────────────────────

interface OrgListRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  member_count: number;
  project_count: number;
}

adminRouter.get('/orgs', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const page = parsePage(c.req.query('page'), 1);
  const pageSize = parsePageSize(c.req.query('pageSize'), 25, 200);
  const offset = (page - 1) * pageSize;

  const where: string[] = ['o.deleted_at IS NULL'];
  const binds: unknown[] = [];
  if (q) {
    where.push(`(LOWER(o.name) LIKE ? OR LOWER(o.slug) LIKE ?)`);
    binds.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rowsRes = await c.env.DB.prepare(
    `SELECT o.id, o.slug, o.name, o.created_at,
            (SELECT COUNT(*) FROM organization_membership m WHERE m.org_id = o.id) AS member_count,
            (SELECT COUNT(*) FROM feed_project p
               WHERE p.owner_type = 'org' AND p.owner_id = o.id AND p.deleted_at IS NULL) AS project_count
       FROM organization o
       ${whereSql}
       ORDER BY o.created_at DESC, o.id DESC
       LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize + 1, offset)
    .all<OrgListRow>();

  const all = rowsRes.results ?? [];
  const has_next = all.length > pageSize;
  const rows = has_next ? all.slice(0, pageSize) : all;
  const orgs = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    createdAt: r.created_at,
    memberCount: r.member_count,
    projectCount: r.project_count,
  }));
  const nextCursor = has_next ? rows[rows.length - 1]!.id : null;

  return c.json({ orgs, nextCursor });
});

adminRouter.get('/orgs/:id', async (c) => {
  const id = c.req.param('id');
  const org = await c.env.DB.prepare(
    `SELECT id, slug, name, created_at FROM organization WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first<{ id: string; slug: string; name: string; created_at: number }>();
  if (!org) throw notFound('Organization not found');

  const members = await c.env.DB.prepare(
    `SELECT m.user_id AS userId, m.role AS role, m.created_at AS createdAt,
            u.email AS email, u.display_name AS displayName
       FROM organization_membership m
       JOIN user u ON u.id = m.user_id
       WHERE m.org_id = ?
       ORDER BY m.created_at ASC`,
  ).bind(id).all<{ userId: string; role: string; createdAt: number; email: string; displayName: string }>();

  const projects = await c.env.DB.prepare(
    `SELECT id, slug, name, created_at AS createdAt
       FROM feed_project
       WHERE owner_type = 'org' AND owner_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC`,
  ).bind(id).all<{ id: string; slug: string; name: string; createdAt: number }>();

  return c.json({
    org: {
      id: org.id,
      slug: org.slug,
      name: org.name,
      createdAt: org.created_at,
    },
    members: members.results ?? [],
    projects: projects.results ?? [],
  });
});

const patchMemberSchema = z.object({
  role: z.enum(['owner', 'admin', 'editor', 'viewer']),
});

async function countOwners(env: Env, orgId: string, excludeUserId?: string): Promise<number> {
  let sql = `SELECT COUNT(*) AS n FROM organization_membership WHERE org_id = ? AND role = 'owner'`;
  const binds: unknown[] = [orgId];
  if (excludeUserId) {
    sql += ` AND user_id != ?`;
    binds.push(excludeUserId);
  }
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

adminRouter.patch('/orgs/:id/members/:userId', async (c) => {
  const orgId = c.req.param('id');
  const userId = c.req.param('userId');
  const body = await parseJson(c, patchMemberSchema);
  const actor = c.var.user!;

  const org = await c.env.DB.prepare(
    `SELECT id FROM organization WHERE id = ? AND deleted_at IS NULL`,
  ).bind(orgId).first<{ id: string }>();
  if (!org) throw notFound('Organization not found');

  const mem = await c.env.DB.prepare(
    `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
  ).bind(orgId, userId).first<{ role: string }>();
  if (!mem) throw notFound('Member not found');

  // Last-owner protection: if we're demoting the last owner, refuse.
  if (mem.role === 'owner' && body.role !== 'owner') {
    const otherOwners = await countOwners(c.env, orgId, userId);
    if (otherOwners === 0) {
      throw conflict('Cannot demote the last owner — transfer ownership first');
    }
  }

  if (mem.role === body.role) {
    return c.json({ member: { userId, role: mem.role } });
  }

  await c.env.DB.prepare(
    `UPDATE organization_membership SET role = ? WHERE org_id = ? AND user_id = ?`,
  ).bind(body.role, orgId, userId).run();

  await logAudit(c.env, {
    actorUserId: actor.id,
    subjectType: 'org',
    subjectId: orgId,
    action: 'admin.org.member.patch',
    metadata: { userId, fromRole: mem.role, toRole: body.role },
    ip: clientIp(c.req.raw),
  });

  return c.json({ member: { userId, role: body.role } });
});

adminRouter.delete('/orgs/:id/members/:userId', async (c) => {
  const orgId = c.req.param('id');
  const userId = c.req.param('userId');
  const actor = c.var.user!;

  const org = await c.env.DB.prepare(
    `SELECT id FROM organization WHERE id = ? AND deleted_at IS NULL`,
  ).bind(orgId).first<{ id: string }>();
  if (!org) throw notFound('Organization not found');

  const mem = await c.env.DB.prepare(
    `SELECT role FROM organization_membership WHERE org_id = ? AND user_id = ?`,
  ).bind(orgId, userId).first<{ role: string }>();
  if (!mem) throw notFound('Member not found');

  if (mem.role === 'owner') {
    const otherOwners = await countOwners(c.env, orgId, userId);
    if (otherOwners === 0) {
      throw conflict('Cannot remove the last owner — transfer ownership first');
    }
  }

  await c.env.DB.prepare(
    `DELETE FROM organization_membership WHERE org_id = ? AND user_id = ?`,
  ).bind(orgId, userId).run();

  await logAudit(c.env, {
    actorUserId: actor.id,
    subjectType: 'org',
    subjectId: orgId,
    action: 'admin.org.member.remove',
    metadata: { userId, role: mem.role },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Audit log ────────────────────────────────────────────────────────────

interface AuditFilters {
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  action?: string;
  from?: number;
  to?: number;
}

function readAuditFilters(url: URL): AuditFilters {
  const f: AuditFilters = {};
  const actor = url.searchParams.get('actorUserId');
  if (actor) f.actorUserId = actor;
  const st = url.searchParams.get('subjectType');
  if (st) f.subjectType = st;
  const sid = url.searchParams.get('subjectId');
  if (sid) f.subjectId = sid;
  const action = url.searchParams.get('action');
  if (action) f.action = action;
  const from = url.searchParams.get('from');
  if (from) {
    const n = Number(from);
    if (Number.isFinite(n)) f.from = n;
  }
  const to = url.searchParams.get('to');
  if (to) {
    const n = Number(to);
    if (Number.isFinite(n)) f.to = n;
  }
  return f;
}

function buildAuditWhere(f: AuditFilters): { sql: string; binds: unknown[] } {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.actorUserId) {
    where.push(`e.actor_user_id = ?`);
    binds.push(f.actorUserId);
  }
  if (f.subjectType) {
    where.push(`e.subject_type = ?`);
    binds.push(f.subjectType);
  }
  if (f.subjectId) {
    where.push(`e.subject_id = ?`);
    binds.push(f.subjectId);
  }
  if (f.action) {
    where.push(`e.action = ?`);
    binds.push(f.action);
  }
  if (f.from !== undefined) {
    where.push(`e.created_at >= ?`);
    binds.push(f.from);
  }
  if (f.to !== undefined) {
    where.push(`e.created_at <= ?`);
    binds.push(f.to);
  }
  return {
    sql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    binds,
  };
}

interface AuditRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  subject_type: string;
  subject_id: string | null;
  action: string;
  metadata_json: string | null;
  ip: string | null;
  created_at: number;
}

adminRouter.get('/audit', async (c) => {
  const staff = c.var.user!;
  await rateLimit(c.env, { key: `admin:audit:${staff.id}`, limit: 60, windowSec: 60 });

  const url = new URL(c.req.url);
  const filters = readAuditFilters(url);
  const page = parsePage(url.searchParams.get('page') ?? undefined, 1);
  const pageSize = parsePageSize(url.searchParams.get('pageSize') ?? undefined, 50, 200);
  const offset = (page - 1) * pageSize;

  const { sql: whereSql, binds } = buildAuditWhere(filters);

  const rowsRes = await c.env.DB.prepare(
    `SELECT e.id, e.actor_user_id, e.subject_type, e.subject_id, e.action, e.metadata_json, e.ip, e.created_at,
            (SELECT u.email FROM user u WHERE u.id = e.actor_user_id) AS actor_email
       FROM audit_event e
       ${whereSql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize + 1, offset)
    .all<AuditRow>();

  const all = rowsRes.results ?? [];
  const has_next = all.length > pageSize;
  const rows = has_next ? all.slice(0, pageSize) : all;

  const events = rows.map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    action: r.action,
    metadataJson: r.metadata_json,
    ip: r.ip,
    createdAt: r.created_at,
  }));

  return c.json({ events, page, pageSize, hasNext: has_next });
});

// ─── Audit CSV export ─────────────────────────────────────────────────────

const CSV_CAP = 50_000;

function csvEscape(s: string): string {
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

adminRouter.get('/audit.csv', async (c) => {
  const staff = c.var.user!;
  await rateLimit(c.env, { key: `admin:audit:${staff.id}`, limit: 60, windowSec: 60 });

  const url = new URL(c.req.url);
  const filters = readAuditFilters(url);
  const { sql: whereSql, binds } = buildAuditWhere(filters);

  // Fetch CAP+1 to know if we hit the cap.
  const rowsRes = await c.env.DB.prepare(
    `SELECT e.id, e.actor_user_id, e.subject_type, e.subject_id, e.action, e.metadata_json, e.ip, e.created_at,
            (SELECT u.email FROM user u WHERE u.id = e.actor_user_id) AS actor_email
       FROM audit_event e
       ${whereSql}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
  )
    .bind(...binds, CSV_CAP + 1)
    .all<AuditRow>();

  const all = rowsRes.results ?? [];
  const capped = all.length > CSV_CAP;
  const rows = capped ? all.slice(0, CSV_CAP) : all;

  const header = [
    'id', 'created_at', 'action',
    'actor_user_id', 'actor_email',
    'subject_type', 'subject_id',
    'ip', 'metadata_json',
  ];
  const lines: string[] = [header.join(',')];
  for (const r of rows) {
    lines.push([
      csvEscape(r.id),
      String(r.created_at),
      csvEscape(r.action),
      csvEscape(r.actor_user_id ?? ''),
      csvEscape(r.actor_email ?? ''),
      csvEscape(r.subject_type),
      csvEscape(r.subject_id ?? ''),
      csvEscape(r.ip ?? ''),
      csvEscape(r.metadata_json ?? ''),
    ].join(','));
  }

  const body = lines.join('\n') + '\n';
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="audit.csv"',
    'X-Audit-Row-Count': String(rows.length),
  };
  if (capped) {
    headers['X-Audit-Capped'] = `1; limit=${CSV_CAP}`;
  }
  return new Response(body, { status: 200, headers });
});

// ─── Analytics events summary ──────────────────────────────────────────────
//
// Aggregates the `event` table written by /api/events/track. The dashboard
// shows inbound referrals grouped by `ref`, where a "visit" is a distinct
// session_id within the requested window. Null ref renders as "direct".

adminRouter.get('/events/summary', async (c) => {
  const staff = c.var.user!;
  await rateLimit(c.env, { key: `admin:events:${staff.id}`, limit: 60, windowSec: 60 });

  const url = new URL(c.req.url);
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');

  const from = fromRaw ? Number(fromRaw) : null;
  const to = toRaw ? Number(toRaw) : null;
  if ((fromRaw && !Number.isFinite(from)) || (toRaw && !Number.isFinite(to))) {
    throw validationFailed('Invalid from/to (expected unix ms)');
  }

  const binds: unknown[] = [];
  const clauses: string[] = [`kind = 'page_view'`];
  if (from !== null) {
    clauses.push('ts >= ?');
    binds.push(from);
  }
  if (to !== null) {
    clauses.push('ts <= ?');
    binds.push(to);
  }
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rowsRes = await c.env.DB.prepare(
    `SELECT COALESCE(ref, '') AS ref,
            COUNT(DISTINCT session_id) AS visits,
            COUNT(*) AS page_views
       FROM event
       ${whereSql}
       GROUP BY COALESCE(ref, '')
       ORDER BY visits DESC, ref ASC`,
  )
    .bind(...binds)
    .all<{ ref: string; visits: number; page_views: number }>();

  const rows = (rowsRes.results ?? []).map((r) => ({
    ref: r.ref || null,
    visits: r.visits,
    pageViews: r.page_views,
  }));

  const totalsRes = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT session_id) AS visits,
            COUNT(*) AS page_views
       FROM event
       ${whereSql}`,
  )
    .bind(...binds)
    .first<{ visits: number; page_views: number }>();

  return c.json({
    rows,
    totals: {
      visits: totalsRes?.visits ?? 0,
      pageViews: totalsRes?.page_views ?? 0,
    },
    from,
    to,
  });
});
