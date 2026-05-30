import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, AuthedUser, Env } from '../env';
import { requireAuth } from '../auth/middleware';
import {
  conflict,
  forbidden,
  notFound,
  validationFailed,
  ApiError,
} from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp, rateLimit } from '../util/rateLimit';
import {
  createAuthToken,
  resolveAuthToken,
  consumeAuthToken,
} from '../auth/tokens';
import { sendInvitationEmail } from '../email';
import {
  requireOwnerFeature,
  requireOrgSeatAvailable,
} from '../billing/middleware';

// ─── Types ──────────────────────────────────────────────────────────────────

export type OrgRole = 'owner' | 'admin' | 'editor' | 'viewer';

const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export function roleAtLeast(have: OrgRole, need: OrgRole): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  deleted_at: number | null;
  brand_logo_r2_key: string | null;
  brand_logo_content_type: string | null;
  brand_logo_updated_at: number | null;
}

interface OrgMembershipRow {
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

async function fetchOrg(env: Env, orgId: string): Promise<OrgRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, slug, name, created_at, deleted_at,
            brand_logo_r2_key, brand_logo_content_type, brand_logo_updated_at
       FROM organization WHERE id = ?`,
  )
    .bind(orgId)
    .first<OrgRow>();
  if (!row || row.deleted_at !== null) return null;
  return row;
}

export async function getOrgMembership(
  env: Env,
  orgId: string,
  userId: string,
): Promise<OrgMembershipRow | null> {
  const row = await env.DB.prepare(
    `SELECT org_id, user_id, role, created_at
       FROM organization_membership
      WHERE org_id = ? AND user_id = ?`,
  )
    .bind(orgId, userId)
    .first<OrgMembershipRow>();
  return row ?? null;
}

/**
 * Load the org + the caller's membership. Returns 404 (not 403) for missing
 * org OR non-members, mirroring the project-level policy of not leaking
 * resource existence to unauthorized users.
 * If minRole is provided and the caller's role is below that rank, throws 403.
 */
export async function requireOrgRole(
  env: Env,
  user: AuthedUser,
  orgId: string,
  minRole?: OrgRole,
): Promise<{ org: OrgRow; role: OrgRole }> {
  const org = await fetchOrg(env, orgId);
  if (!org) throw notFound('Organization not found');
  const membership = await getOrgMembership(env, orgId, user.id);
  if (!membership) throw notFound('Organization not found');
  if (minRole && !roleAtLeast(membership.role, minRole)) {
    throw forbidden('You do not have permission to perform this action');
  }
  return { org, role: membership.role };
}

function shapeOrg(row: OrgRow) {
  // The actual logo bytes are served publicly from FEEDS_ORIGIN at
  // `/_/orgs/<id>/logo`. Frontend composes the URL from this timestamp
  // (used as a cache-buster query param) plus the FEEDS_ORIGIN var.
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: row.created_at,
    brandLogoUpdatedAt: row.brand_logo_r2_key ? row.brand_logo_updated_at : null,
  };
}

async function countOwners(env: Env, orgId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM organization_membership WHERE org_id = ? AND role = 'owner'`,
  )
    .bind(orgId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── Router ─────────────────────────────────────────────────────────────────

export const orgsRouter = new Hono<AppContext>();

orgsRouter.use('*', requireAuth);

// ─── Schemas ────────────────────────────────────────────────────────────────

const createOrgSchema = z.object({
  slug: z.string(),
  name: z.string().trim().min(1).max(200),
});

const patchOrgSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: z.string().optional(),
});

const roleSchema: z.ZodType<OrgRole> = z.enum(['owner', 'admin', 'editor', 'viewer']);
const inviteRoleSchema: z.ZodType<Exclude<OrgRole, 'owner'>> = z.enum(['admin', 'editor', 'viewer']);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: inviteRoleSchema,
});

const acceptSchema = z.object({
  token: z.string().min(1),
});

const patchMemberSchema = z.object({
  role: roleSchema,
});

const transferSchema = z.object({
  newOwnerUserId: z.string().min(1),
});

// ─── POST /api/orgs — create ────────────────────────────────────────────────

orgsRouter.post('/', async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, createOrgSchema);

  if (!ORG_SLUG_RE.test(body.slug)) {
    throw validationFailed(
      'Invalid slug — lowercase ASCII letters/digits/dashes, 3-63 chars, must start with letter or digit',
    );
  }

  // Rate-limit: 10 org creations per day per user.
  await rateLimit(c.env, {
    key: `orgs:create:user:${user.id}`,
    limit: 10,
    windowSec: 24 * 60 * 60,
  });

  // Uniqueness check. Soft-deleted slugs are still blocked (so the slug is
  // permanently retired) — matches the `UNIQUE` constraint on the column.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM organization WHERE slug = ? LIMIT 1`,
  )
    .bind(body.slug)
    .first<{ id: string }>();
  if (existing) throw conflict('Slug is already in use');

  const now = Date.now();
  const id = ulid();
  // Staff orgs land on agency so internal demo / support orgs aren't blocked
  // by the "paid plan required to add members" gate on day one. Real users
  // still get free until they go through Stripe Checkout.
  const initialPlan: 'free' | 'agency' = user.staff ? 'agency' : 'free';
  try {
    await c.env.DB.prepare(
      `INSERT INTO organization (id, slug, name, created_at, plan, plan_status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
    )
      .bind(id, body.slug, body.name, now, initialPlan)
      .run();
  } catch (err) {
    // Race with the uniqueness check — surface as 409.
    if (String(err).includes('UNIQUE')) throw conflict('Slug is already in use');
    throw err;
  }
  await c.env.DB.prepare(
    `INSERT INTO organization_membership (org_id, user_id, role, created_at)
     VALUES (?, ?, 'owner', ?)`,
  )
    .bind(id, user.id, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.create',
    metadata: { slug: body.slug, name: body.name, plan: initialPlan, byStaff: user.staff },
    ip: clientIp(c.req.raw),
  });

  return c.json(
    {
      organization: {
        ...shapeOrg({
          id,
          slug: body.slug,
          name: body.name,
          created_at: now,
          deleted_at: null,
          brand_logo_r2_key: null,
          brand_logo_content_type: null,
          brand_logo_updated_at: null,
        }),
        role: 'owner' as OrgRole,
        plan: initialPlan,
        planStatus: 'active' as const,
      },
    },
    201,
  );
});

// ─── GET /api/orgs — list orgs for current user ─────────────────────────────

orgsRouter.get('/', async (c) => {
  const user = c.var.user!;
  const res = await c.env.DB.prepare(
    `SELECT o.id, o.slug, o.name, o.created_at, o.plan, o.plan_status,
            m.role AS role,
            (SELECT COUNT(*) FROM organization_membership mm WHERE mm.org_id = o.id) AS member_count,
            (SELECT COUNT(*) FROM feed_project p
               WHERE p.owner_type = 'org' AND p.owner_id = o.id AND p.deleted_at IS NULL) AS project_count
       FROM organization o
       JOIN organization_membership m ON m.org_id = o.id
      WHERE m.user_id = ? AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC`,
  )
    .bind(user.id)
    .all<{
      id: string;
      slug: string;
      name: string;
      created_at: number;
      plan: string | null;
      plan_status: string | null;
      role: OrgRole;
      member_count: number;
      project_count: number;
    }>();

  const orgs = (res.results ?? []).map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    role: r.role,
    plan: (r.plan ?? 'free') as 'free' | 'pro' | 'agency' | 'enterprise',
    planStatus: (r.plan_status ?? 'active') as 'active' | 'past_due' | 'canceled' | 'trialing',
    memberCount: r.member_count,
    projectCount: r.project_count,
    createdAt: r.created_at,
  }));
  return c.json({ orgs });
});

// ─── Invitations (pending list — current user, no org id) ──────────────────
// NOTE: this route must be registered BEFORE `/:id` patterns so it isn't
// shadowed by the param route (Hono matches in registration order).

orgsRouter.get('/invitations/pending', async (c) => {
  const user = c.var.user!;
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `SELECT t.token_hash, t.email, t.expires_at, t.created_at, t.metadata_json
       FROM auth_token t
      WHERE t.kind = 'invitation'
        AND t.consumed_at IS NULL
        AND t.expires_at > ?
        AND LOWER(t.email) = LOWER(?)
      ORDER BY t.created_at DESC`,
  )
    .bind(now, user.email)
    .all<{
      token_hash: string;
      email: string;
      expires_at: number;
      created_at: number;
      metadata_json: string | null;
    }>();

  const invitations: Array<{
    orgId: string;
    orgName: string;
    role: OrgRole;
    invitedBy: string | null;
    inviterName: string | null;
    expiresAt: number;
  }> = [];
  for (const r of res.results ?? []) {
    const meta = r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : {};
    invitations.push({
      orgId: String(meta.orgId ?? ''),
      orgName: String(meta.orgName ?? ''),
      role: (meta.role as OrgRole) ?? 'viewer',
      invitedBy: (meta.invitedBy as string | undefined) ?? null,
      inviterName: (meta.inviterName as string | undefined) ?? null,
      expiresAt: r.expires_at,
    });
  }
  return c.json({ invitations });
});

// ─── POST /api/orgs/invitations/accept — consume invite token ──────────────

orgsRouter.post('/invitations/accept', async (c) => {
  const user = c.var.user!;
  // This endpoint is reachable by any authenticated user (including
  // pending_verification). requireAuth's path-based gate already allows
  // /api/me and /auth/verify, so pending users are blocked here. That's
  // intentional — we require a verified email before joining an org.
  if (user.status !== 'active') {
    throw forbidden('Please verify your email address before accepting invitations');
  }

  const body = await parseJson(c, acceptSchema);

  const resolved = await resolveAuthToken(c.env, body.token, 'invitation');
  if (!resolved) throw validationFailed('Invalid or expired invitation');
  if (resolved.consumedAt) throw validationFailed('This invitation has already been used');
  if (resolved.expiresAt <= Date.now()) throw validationFailed('This invitation has expired');
  if (!resolved.email) throw validationFailed('Invalid invitation');

  if (resolved.email.toLowerCase() !== user.email.toLowerCase()) {
    throw forbidden('Invitation is for a different email address');
  }

  const meta = resolved.metadata ?? {};
  const orgId = typeof meta.orgId === 'string' ? meta.orgId : null;
  const role = typeof meta.role === 'string' ? (meta.role as OrgRole) : null;
  if (!orgId || !role || !ROLE_RANK[role]) {
    throw validationFailed('Invalid invitation metadata');
  }

  const org = await fetchOrg(c.env, orgId);
  if (!org) {
    // Consume the token so the email link can't be reused against a recreated org.
    await consumeAuthToken(c.env, resolved.tokenHash);
    throw notFound('Organization no longer exists');
  }

  const existing = await getOrgMembership(c.env, orgId, user.id);
  if (existing) {
    // Consume the token so it can't be reused, but don't error — idempotent join.
    await consumeAuthToken(c.env, resolved.tokenHash);
    return c.json({
      organization: shapeOrg(org),
      role: existing.role,
    });
  }

  // Org must be on a paid plan (Agency/Enterprise hosts the membership; the
  // member doesn't need their own subscription). For Agency/Enterprise we
  // skip the seat-cap check entirely — see worker/billing/middleware.ts.
  await requireOrgSeatAvailable(c.env, orgId);

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO organization_membership (org_id, user_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(orgId, user.id, role, now)
    .run();
  await consumeAuthToken(c.env, resolved.tokenHash);

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: orgId,
    action: 'org.member_joined',
    metadata: { role, invitedBy: meta.invitedBy ?? null },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    organization: shapeOrg(org),
    role,
  });
});

// ─── GET /api/orgs/:id ──────────────────────────────────────────────────────

orgsRouter.get('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { org } = await requireOrgRole(c.env, user, id);

  const members = await c.env.DB.prepare(
    `SELECT m.user_id AS user_id, m.role AS role, m.created_at AS created_at,
            u.email AS email, u.display_name AS display_name
       FROM organization_membership m
       JOIN user u ON u.id = m.user_id
      WHERE m.org_id = ?
      ORDER BY m.created_at ASC`,
  )
    .bind(id)
    .all<{
      user_id: string;
      role: OrgRole;
      created_at: number;
      email: string;
      display_name: string;
    }>();

  const projectCountRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feed_project
       WHERE owner_type = 'org' AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ n: number }>();

  return c.json({
    organization: shapeOrg(org),
    members: (members.results ?? []).map((m) => ({
      userId: m.user_id,
      email: m.email,
      displayName: m.display_name,
      role: m.role,
      createdAt: m.created_at,
    })),
    projectCount: projectCountRow?.n ?? 0,
  });
});

// ─── PATCH /api/orgs/:id ────────────────────────────────────────────────────

orgsRouter.patch('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, patchOrgSchema);
  const { org } = await requireOrgRole(c.env, user, id, 'admin');

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.name !== undefined && body.name !== org.name) {
    updates.push('name = ?');
    binds.push(body.name);
  }
  if (body.slug !== undefined && body.slug !== org.slug) {
    if (!ORG_SLUG_RE.test(body.slug)) {
      throw validationFailed(
        'Invalid slug — lowercase ASCII letters/digits/dashes, 3-63 chars',
      );
    }
    const collision = await c.env.DB.prepare(
      `SELECT id FROM organization WHERE slug = ? AND id != ? LIMIT 1`,
    )
      .bind(body.slug, id)
      .first<{ id: string }>();
    if (collision) throw conflict('Slug is already in use');
    updates.push('slug = ?');
    binds.push(body.slug);
  }

  if (updates.length === 0) {
    return c.json({ organization: shapeOrg(org) });
  }

  binds.push(id);
  try {
    await c.env.DB.prepare(`UPDATE organization SET ${updates.join(', ')} WHERE id = ?`)
      .bind(...binds)
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw conflict('Slug is already in use');
    throw err;
  }

  const fresh = await fetchOrg(c.env, id);
  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.update',
    metadata: { name: body.name !== undefined, slug: body.slug !== undefined },
    ip: clientIp(c.req.raw),
  });
  return c.json({ organization: fresh ? shapeOrg(fresh) : shapeOrg(org) });
});

// ─── POST /api/orgs/:id/logo — upload brand logo ───────────────────────────

const LOGO_MAX_BYTES = 1_000_000; // 1 MB
const ALLOWED_LOGO_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
]);

function logoR2Key(orgId: string): string {
  return `orgs/${orgId}/logo`;
}

orgsRouter.post('/:id/logo', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  // Admins + owners can manage branding.
  await requireOrgRole(c.env, user, id, 'admin');
  // Custom org logo is an Agency+ feature.
  await requireOwnerFeature(c.env, 'org', id, 'org_logo', user);

  const form = await c.req.formData().catch(() => null);
  if (!form) throw validationFailed('multipart/form-data body required');
  const file: unknown = form.get('file');
  // Workers treats uploaded files as Blob; the type lib may not have File
  // available globally, so accept either.
  if (
    !file ||
    typeof file !== 'object' ||
    typeof (file as Blob).arrayBuffer !== 'function' ||
    typeof (file as Blob).size !== 'number'
  ) {
    throw validationFailed('file field required');
  }
  const blob = file as Blob;
  const contentType = blob.type || 'application/octet-stream';
  if (!ALLOWED_LOGO_TYPES.has(contentType)) {
    throw validationFailed('Allowed logo types: PNG, JPEG, WebP, SVG');
  }
  if (blob.size > LOGO_MAX_BYTES) {
    throw validationFailed(`Logo file too large (max ${Math.round(LOGO_MAX_BYTES / 1000)} KB)`);
  }

  const buf = await blob.arrayBuffer();
  await c.env.FEEDS.put(logoR2Key(id), buf, {
    httpMetadata: { contentType },
  });

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE organization
        SET brand_logo_r2_key = ?, brand_logo_content_type = ?, brand_logo_updated_at = ?
      WHERE id = ?`,
  )
    .bind(logoR2Key(id), contentType, now, id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.logo.upload',
    metadata: { contentType, size: blob.size },
    ip: clientIp(c.req.raw),
  });

  const fresh = await fetchOrg(c.env, id);
  return c.json({ organization: fresh ? shapeOrg(fresh) : null });
});

// ─── DELETE /api/orgs/:id/logo — clear brand logo ──────────────────────────

orgsRouter.delete('/:id/logo', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  await requireOrgRole(c.env, user, id, 'admin');

  await c.env.FEEDS.delete(logoR2Key(id)).catch(() => {});
  await c.env.DB.prepare(
    `UPDATE organization
        SET brand_logo_r2_key = NULL, brand_logo_content_type = NULL, brand_logo_updated_at = NULL
      WHERE id = ?`,
  )
    .bind(id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.logo.remove',
    ip: clientIp(c.req.raw),
  });

  const fresh = await fetchOrg(c.env, id);
  return c.json({ organization: fresh ? shapeOrg(fresh) : null });
});

// ─── DELETE /api/orgs/:id — soft-delete ─────────────────────────────────────

orgsRouter.delete('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { org } = await requireOrgRole(c.env, user, id, 'owner');

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE organization SET deleted_at = ? WHERE id = ?`)
    .bind(now, id)
    .run();
  // Cascade: soft-delete org-owned projects.
  await c.env.DB.prepare(
    `UPDATE feed_project
        SET deleted_at = ?, updated_at = ?
      WHERE owner_type = 'org' AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(now, now, id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.delete',
    metadata: { slug: org.slug },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── POST /api/orgs/:id/invitations — invite by email ──────────────────────

orgsRouter.post('/:id/invitations', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, inviteSchema);
  const { org, role: callerRole } = await requireOrgRole(c.env, user, id, 'admin');

  // admins can only invite editor/viewer; owners can invite admin/editor/viewer.
  if (body.role === 'admin' && callerRole !== 'owner') {
    throw forbidden('Only owners can invite admins');
  }

  // Org must be on a paid plan and have an open seat before issuing invites.
  await requireOrgSeatAvailable(c.env, id);

  // Rate-limit: 50 invites per org per day (covers even generous onboarding).
  await rateLimit(c.env, {
    key: `orgs:invite:org:${id}`,
    limit: 50,
    windowSec: 24 * 60 * 60,
  });

  // Always audit (using the email we were given — this reveals nothing to the
  // caller they didn't already type).
  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.invitation_sent',
    metadata: { email: body.email, role: body.role },
    ip: clientIp(c.req.raw),
  });

  // Resolve the target user if one exists — only to decide whether they're
  // already a member of this org (an idempotent no-op).
  const targetUser = await c.env.DB.prepare(
    `SELECT id FROM user WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
  )
    .bind(body.email)
    .first<{ id: string }>();
  if (targetUser) {
    const already = await getOrgMembership(c.env, id, targetUser.id);
    if (already) {
      // Silent no-op — we don't tell the inviter "already a member" vs
      // "invited" because that would enable email enumeration.
      return c.body(null, 204);
    }
  }

  const token = await createAuthToken(c.env, {
    kind: 'invitation',
    userId: targetUser?.id ?? null,
    email: body.email,
    metadata: {
      orgId: id,
      orgName: org.name,
      role: body.role,
      invitedBy: user.id,
      inviterName: user.displayName,
    },
  });
  // Include the invited email as a query param so the SPA can pre-fill the
  // signup form when the recipient doesn't already have an account. The
  // server side is the real authority (token's metadata.email is checked at
  // accept time), so this is informational only.
  const link = `${c.env.APP_ORIGIN}/orgs/accept?token=${token}&email=${encodeURIComponent(body.email)}`;

  try {
    await sendInvitationEmail(c.env, body.email, user.displayName, org.name, body.role, link);
  } catch (err) {
    // Swallow — no enumeration. The token is still live; admin can rescind.
    console.error('invitation email send failed', err);
  }

  return c.body(null, 204);
});

// ─── GET /api/orgs/:id/invitations — list pending ───────────────────────────

orgsRouter.get('/:id/invitations', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  await requireOrgRole(c.env, user, id, 'admin');

  const now = Date.now();
  const res = await c.env.DB.prepare(
    `SELECT token_hash, email, expires_at, created_at, metadata_json
       FROM auth_token
      WHERE kind = 'invitation'
        AND consumed_at IS NULL
        AND expires_at > ?
      ORDER BY created_at DESC`,
  )
    .bind(now)
    .all<{
      token_hash: string;
      email: string | null;
      expires_at: number;
      created_at: number;
      metadata_json: string | null;
    }>();

  const invitations: Array<{
    tokenHash: string;
    email: string | null;
    role: OrgRole;
    invitedBy: string | null;
    expiresAt: number;
    createdAt: number;
  }> = [];
  for (const r of res.results ?? []) {
    const meta = r.metadata_json ? (JSON.parse(r.metadata_json) as Record<string, unknown>) : {};
    if (meta.orgId !== id) continue;
    invitations.push({
      tokenHash: r.token_hash,
      email: r.email,
      role: (meta.role as OrgRole) ?? 'viewer',
      invitedBy: (meta.invitedBy as string | undefined) ?? null,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    });
  }
  return c.json({ invitations });
});

// ─── DELETE /api/orgs/:id/invitations/:tokenHash — rescind ─────────────────

orgsRouter.delete('/:id/invitations/:tokenHash', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const tokenHash = c.req.param('tokenHash');
  await requireOrgRole(c.env, user, id, 'admin');

  // Only rescind if it belongs to this org. We verify via metadata.
  const row = await c.env.DB.prepare(
    `SELECT metadata_json, consumed_at FROM auth_token
      WHERE token_hash = ? AND kind = 'invitation' LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{ metadata_json: string | null; consumed_at: number | null }>();
  if (!row) return c.body(null, 204); // idempotent
  const meta = row.metadata_json ? JSON.parse(row.metadata_json) : {};
  if (meta.orgId !== id) throw notFound('Invitation not found');

  if (row.consumed_at == null) {
    await c.env.DB.prepare(`UPDATE auth_token SET consumed_at = ? WHERE token_hash = ?`)
      .bind(Date.now(), tokenHash)
      .run();
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.invitation_rescinded',
    metadata: { tokenHash },
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// ─── PATCH /api/orgs/:id/members/:userId — change role ─────────────────────

orgsRouter.patch('/:id/members/:userId', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const body = await parseJson(c, patchMemberSchema);
  const { role: callerRole } = await requireOrgRole(c.env, user, id, 'admin');

  const target = await getOrgMembership(c.env, id, targetUserId);
  if (!target) throw notFound('Member not found');

  // Only owners can change an owner's role.
  if (target.role === 'owner' && callerRole !== 'owner') {
    throw forbidden('Only an owner can change another owner\'s role');
  }
  // Only owners can promote to owner.
  if (body.role === 'owner' && callerRole !== 'owner') {
    throw forbidden('Only an owner can grant owner role');
  }

  // Last-owner protection: if we're demoting the last remaining owner, block.
  if (target.role === 'owner' && body.role !== 'owner') {
    const owners = await countOwners(c.env, id);
    if (owners <= 1) {
      throw new ApiError(409, 'conflict', 'Cannot demote the last owner — transfer ownership first', {
        reason: 'last_owner',
      });
    }
  }

  if (target.role === body.role) {
    // No-op.
    return c.body(null, 204);
  }

  await c.env.DB.prepare(
    `UPDATE organization_membership SET role = ? WHERE org_id = ? AND user_id = ?`,
  )
    .bind(body.role, id, targetUserId)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.member_role_changed',
    metadata: { targetUserId, from: target.role, to: body.role },
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// ─── DELETE /api/orgs/:id/members/:userId — remove / leave ─────────────────

orgsRouter.delete('/:id/members/:userId', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const targetUserId = c.req.param('userId');
  const { role: callerRole } = await requireOrgRole(c.env, user, id);

  const target = await getOrgMembership(c.env, id, targetUserId);
  if (!target) throw notFound('Member not found');

  const isSelf = targetUserId === user.id;
  if (!isSelf && !roleAtLeast(callerRole, 'admin')) {
    throw forbidden('Only admins or the member themselves can remove a member');
  }
  // Admins cannot remove owners.
  if (!isSelf && target.role === 'owner' && callerRole !== 'owner') {
    throw forbidden('Only an owner can remove another owner');
  }

  // Last-owner protection.
  if (target.role === 'owner') {
    const owners = await countOwners(c.env, id);
    if (owners <= 1) {
      throw new ApiError(409, 'conflict', 'Cannot remove the last owner — transfer ownership first', {
        reason: 'last_owner',
      });
    }
  }

  await c.env.DB.prepare(
    `DELETE FROM organization_membership WHERE org_id = ? AND user_id = ?`,
  )
    .bind(id, targetUserId)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: isSelf ? 'org.member_left' : 'org.member_removed',
    metadata: { targetUserId, role: target.role },
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// ─── POST /api/orgs/:id/transfer — ownership handoff ───────────────────────

orgsRouter.post('/:id/transfer', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, transferSchema);
  const { role: callerRole } = await requireOrgRole(c.env, user, id, 'owner');
  if (callerRole !== 'owner') throw forbidden('Only the owner can transfer ownership');

  if (body.newOwnerUserId === user.id) {
    throw validationFailed('Cannot transfer ownership to yourself');
  }

  const newOwner = await getOrgMembership(c.env, id, body.newOwnerUserId);
  if (!newOwner) throw notFound('Target user is not a member of this organization');

  // Promote target first (so there are momentarily two owners), THEN demote
  // the caller. That way we never pass through a zero-owner window.
  await c.env.DB.prepare(
    `UPDATE organization_membership SET role = 'owner' WHERE org_id = ? AND user_id = ?`,
  )
    .bind(id, body.newOwnerUserId)
    .run();
  await c.env.DB.prepare(
    `UPDATE organization_membership SET role = 'admin' WHERE org_id = ? AND user_id = ?`,
  )
    .bind(id, user.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'org',
    subjectId: id,
    action: 'org.ownership_transferred',
    metadata: { newOwnerUserId: body.newOwnerUserId, previousOwnerUserId: user.id },
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});
