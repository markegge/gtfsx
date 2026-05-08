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
  rtBreakage,
  ApiError,
} from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
import { generateToken, sha256Hex } from '../util/crypto';
import { diffRemovedIds, isEmpty as rtReportEmpty } from '../publication/idStability';
import { submitToCatalogs } from '../publication/submit';
import { getOrgMembership, roleAtLeast, type OrgRole } from '../orgs/routes';
import { isValidSlug, slugify, uniqueSlug } from './slug';
import {
  MAX_BLOB_BYTES,
  MAX_PROJECTS_PER_OWNER,
  MAX_VERSIONS_PER_PROJECT,
  countProjects,
  countVersions,
  enforceBlobSize,
  enforceQuota,
} from './quotas';
import {
  deleteFeedBlob,
  draftZipKey,
  getFeedBlob,
  publicationZipKey,
  putFeedBlob,
  versionStateKey,
  versionZipKey,
  workingStateKey,
} from './r2';

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  owner_type: string;
  owner_id: string;
  working_state_r2_key: string | null;
  working_state_version: number;
  working_state_size: number | null;
  working_state_updated_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  brand_primary_color: string | null;
}

interface VersionRow {
  id: string;
  project_id: string;
  label: string | null;
  created_by_user_id: string | null;
  state_r2_key: string;
  zip_r2_key: string;
  zip_size: number;
  summary_json: string;
  validation_errors: number;
  validation_warnings: number;
  created_at: number;
}

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

function shapeProject(row: ProjectRow) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    workingStateVersion: row.working_state_version,
    workingStateSize: row.working_state_size,
    workingStateUpdatedAt: row.working_state_updated_at,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    brandPrimaryColor: row.brand_primary_color,
  };
}

function shapeVersion(row: VersionRow) {
  let summary: unknown = null;
  try {
    summary = JSON.parse(row.summary_json);
  } catch {
    summary = null;
  }
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    zipSize: row.zip_size,
    validationErrors: row.validation_errors,
    validationWarnings: row.validation_warnings,
    summary,
  };
}

type ProjectAccess = 'personal' | `org:${OrgRole}`;
type RequiredProjectLevel = 'viewer' | 'editor' | 'admin';

interface ProjectAccessResult {
  row: ProjectRow;
  access: ProjectAccess;
}

const ACCESS_RANK: Record<RequiredProjectLevel, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

/**
 * Load a project and the caller's access to it. Returns 404 (not 403) when
 * the caller has no access, mirroring the cross-user isolation policy.
 *
 * `access` is one of:
 *   'personal' — project owned by the user directly (always full permission);
 *   'org:<role>' — the project is owned by an org the user belongs to.
 *
 * `required` gates access for this operation:
 *   'viewer'  — any member (or personal owner) may access
 *   'editor'  — org editor+ (viewer denied → 403)
 *   'admin'   — org admin+ (only admins/owners can delete org projects)
 * Personal owners always satisfy every level.
 */
async function requireOwnedProject(
  env: Env,
  user: AuthedUser,
  projectId: string,
  required: RequiredProjectLevel = 'viewer',
): Promise<ProjectAccessResult> {
  const row = await env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color
       FROM feed_project WHERE id = ?`,
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row || row.deleted_at !== null) throw notFound('Project not found');

  if (row.owner_type === 'user') {
    if (row.owner_id !== user.id) throw notFound('Project not found');
    return { row, access: 'personal' };
  }

  if (row.owner_type === 'org') {
    const membership = await getOrgMembership(env, row.owner_id, user.id);
    if (!membership) throw notFound('Project not found');
    // Map org role to the highest project-level it satisfies.
    const orgAccessLevel: RequiredProjectLevel =
      membership.role === 'viewer'
        ? 'viewer'
        : membership.role === 'editor'
          ? 'editor'
          : 'admin'; // admin + owner both satisfy 'admin'
    if (ACCESS_RANK[orgAccessLevel] < ACCESS_RANK[required]) {
      throw forbidden('You do not have permission to perform this action');
    }
    return { row, access: `org:${membership.role}` };
  }

  throw notFound('Project not found');
}

async function requireOwnedVersion(env: Env, projectId: string, versionId: string): Promise<VersionRow> {
  const row = await env.DB.prepare(
    `SELECT id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at
       FROM feed_version WHERE id = ? AND project_id = ?`,
  )
    .bind(versionId, projectId)
    .first<VersionRow>();
  if (!row) throw notFound('Version not found');
  return row;
}

function setQuotaWarningHeader(c: { header: (k: string, v: string) => void }, warning: string | null) {
  if (warning) c.header('X-Quota-Warning', warning);
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  slug: z.string().optional(),
  owner: z
    .object({
      type: z.enum(['user', 'org']),
      id: z.string().optional(),
    })
    .optional(),
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  slug: z.string().optional(),
  archivedAt: z.union([z.null(), z.literal('now')]).optional(),
  // 6-char hex without leading "#", or null to clear.
  brandPrimaryColor: z.union([z.string().regex(/^[0-9a-fA-F]{6}$/), z.null()]).optional(),
});

const importItemSchema = z.object({
  slug: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  workingState: z.string().min(1),
  workingStateSize: z.number().int().nonnegative(),
});

const importSchema = z.object({
  projects: z.array(importItemSchema).max(50),
});

const versionMetaSchema = z.object({
  label: z.string().trim().max(200).optional(),
  summary: z.record(z.string(), z.unknown()),
  validationErrors: z.number().int().nonnegative(),
  validationWarnings: z.number().int().nonnegative(),
});

export const projectsRouter = new Hono<AppContext>();

projectsRouter.use('*', requireAuth);

projectsRouter.post('/', async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, createSchema);

  // Determine owner. Default = personal (user).
  const ownerType: 'user' | 'org' = body.owner?.type ?? 'user';
  let ownerId: string;
  if (ownerType === 'user') {
    ownerId = user.id;
  } else {
    if (!body.owner?.id) {
      throw validationFailed('owner.id is required when owner.type is org');
    }
    ownerId = body.owner.id;
    const membership = await getOrgMembership(c.env, ownerId, user.id);
    if (!membership) throw notFound('Organization not found');
    if (!roleAtLeast(membership.role, 'editor')) {
      throw forbidden('Editor role or higher required to create projects in this organization');
    }
  }

  const used = await countProjects(c.env, ownerType, ownerId);
  const { warning } = enforceQuota(c.env, 'projects', used, MAX_PROJECTS_PER_OWNER);
  setQuotaWarningHeader(c, warning);

  let desiredSlug: string;
  if (body.slug !== undefined) {
    if (!isValidSlug(body.slug)) {
      throw validationFailed('Invalid slug — lowercase ASCII letters/digits/dashes, must start with letter or digit, max 63 chars');
    }
    desiredSlug = body.slug;
  } else {
    desiredSlug = slugify(body.name);
  }
  const finalSlug = await uniqueSlug(c.env, ownerType, ownerId, desiredSlug);

  const now = Date.now();
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO feed_project
       (id, slug, name, description, owner_type, owner_id,
        working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
        archived_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(id, finalSlug, body.name, body.description ?? null, ownerType, ownerId, now, now)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color
       FROM feed_project WHERE id = ?`,
  )
    .bind(id)
    .first<ProjectRow>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: id,
    action: 'project.create',
    metadata: { slug: finalSlug, name: body.name, ownerType, ownerId },
    ip: clientIp(c.req.raw),
  });

  return c.json(shapeProject(row!), 201);
});

projectsRouter.get('/', async (c) => {
  const user = c.var.user!;
  const includeArchived = c.req.query('include_archived') === '1';
  const scope = c.req.query('scope') ?? 'personal';

  let ownerType: 'user' | 'org';
  let ownerId: string;
  if (scope === 'personal') {
    ownerType = 'user';
    ownerId = user.id;
  } else if (scope.startsWith('org:')) {
    ownerType = 'org';
    ownerId = scope.slice(4);
    if (!ownerId) throw validationFailed('Invalid scope');
    const membership = await getOrgMembership(c.env, ownerId, user.id);
    if (!membership) throw notFound('Organization not found');
  } else {
    throw validationFailed('scope must be "personal" or "org:<id>"');
  }

  const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.owner_type, p.owner_id,
            p.working_state_r2_key, p.working_state_version, p.working_state_size, p.working_state_updated_at,
            p.archived_at, p.deleted_at, p.created_at, p.updated_at, p.brand_primary_color,
            (SELECT COUNT(*) FROM feed_version v WHERE v.project_id = p.id) AS version_count,
            (SELECT MAX(v.created_at) FROM feed_version v WHERE v.project_id = p.id) AS last_version_created_at
       FROM feed_project p
       WHERE p.owner_type = ? AND p.owner_id = ? AND p.deleted_at IS NULL${archivedFilter}
       ORDER BY COALESCE(p.working_state_updated_at, p.updated_at) DESC`,
  )
    .bind(ownerType, ownerId)
    .all<ProjectRow & { version_count: number; last_version_created_at: number | null }>();

  const projects = (rows.results ?? []).map((r) => ({
    ...shapeProject(r),
    versionCount: r.version_count,
    lastVersionCreatedAt: r.last_version_created_at,
  }));

  const used = await countProjects(c.env, ownerType, ownerId);
  const warnAt = Math.floor(MAX_PROJECTS_PER_OWNER * 0.9);
  const warning = used >= warnAt ? `${used}/${MAX_PROJECTS_PER_OWNER}` : null;

  return c.json({
    projects,
    quota: {
      projects: { used, limit: MAX_PROJECTS_PER_OWNER },
      warning,
    },
  });
});

projectsRouter.get('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row, access } = await requireOwnedProject(c.env, user, id, 'viewer');

  const versions = await c.env.DB.prepare(
    `SELECT id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at
       FROM feed_version WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(id)
    .all<VersionRow>();

  return c.json({
    ...shapeProject(row),
    access,
    versions: (versions.results ?? []).map(shapeVersion),
  });
});

projectsRouter.patch('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, patchSchema);
  const { row: current } = await requireOwnedProject(c.env, user, id, 'editor');

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    binds.push(body.name);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    binds.push(body.description);
  }
  if (body.brandPrimaryColor !== undefined) {
    updates.push('brand_primary_color = ?');
    binds.push(body.brandPrimaryColor === null ? null : body.brandPrimaryColor.toLowerCase());
  }
  if (body.slug !== undefined && body.slug !== current.slug) {
    if (!isValidSlug(body.slug)) {
      throw validationFailed('Invalid slug');
    }
    const existing = await c.env.DB.prepare(
      `SELECT id FROM feed_project
         WHERE owner_type = ? AND owner_id = ? AND slug = ? AND deleted_at IS NULL AND id != ?
         LIMIT 1`,
    )
      .bind(current.owner_type, current.owner_id, body.slug, current.id)
      .first<{ id: string }>();
    if (existing) throw conflict('Slug is already in use');
    updates.push('slug = ?');
    binds.push(body.slug);
  }
  if (body.archivedAt !== undefined) {
    updates.push('archived_at = ?');
    binds.push(body.archivedAt === 'now' ? Date.now() : null);
  }

  if (updates.length === 0) {
    return c.json(shapeProject(current));
  }

  const now = Date.now();
  updates.push('updated_at = ?');
  binds.push(now);
  binds.push(current.id);

  await c.env.DB.prepare(`UPDATE feed_project SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: current.id,
    action: 'project.update',
    metadata: {
      name: body.name !== undefined,
      description: body.description !== undefined,
      slug: body.slug !== undefined,
      archived: body.archivedAt !== undefined,
    },
    ip: clientIp(c.req.raw),
  });

  const updated = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at, brand_primary_color
       FROM feed_project WHERE id = ?`,
  )
    .bind(current.id)
    .first<ProjectRow>();
  return c.json(shapeProject(updated!));
});

projectsRouter.delete('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: current } = await requireOwnedProject(c.env, user, id, 'admin');

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE feed_project SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(now, now, current.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: current.id,
    action: 'project.delete',
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

projectsRouter.get('/:id/working-state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');
  if (!row.working_state_r2_key) throw notFound('No working state yet');

  const object = await getFeedBlob(c.env, row.working_state_r2_key);
  if (!object) throw notFound('Working state blob missing');

  c.header('Content-Type', 'application/json');
  c.header('X-Working-State-Version', String(row.working_state_version));
  // Decompress in the worker. Manually-set Content-Encoding on a Worker
  // response isn't auto-decompressed by browser fetch (only transport-layer
  // negotiated encodings are), so the client receives raw gzip bytes and
  // JSON.parse fails with "Could not load feed". Streaming through
  // DecompressionStream gives the client plain JSON; CF's edge re-gzips on
  // the wire if the client sent Accept-Encoding: gzip.
  const decompressed = object.body.pipeThrough(new DecompressionStream('gzip'));
  return c.body(decompressed);
});

projectsRouter.put('/:id/working-state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');

  const ifMatchHeader = c.req.header('If-Match');
  const ifMatch = ifMatchHeader != null ? parseInt(ifMatchHeader, 10) : NaN;
  if (!Number.isFinite(ifMatch) || ifMatch !== row.working_state_version) {
    throw new ApiError(409, 'conflict', 'Working state has been updated elsewhere', {
      currentVersion: row.working_state_version,
    });
  }

  const contentEncoding = c.req.header('Content-Encoding');
  if (contentEncoding !== 'gzip') {
    throw validationFailed('Content-Encoding: gzip required');
  }

  const buf = await c.req.raw.arrayBuffer();
  const size = buf.byteLength;
  if (size === 0) throw validationFailed('Empty body');
  if (size > MAX_BLOB_BYTES) {
    throw new ApiError(413, 'quota_exceeded', `Working state exceeds ${MAX_BLOB_BYTES} bytes`, {
      kind: 'blob',
      used: size,
      limit: MAX_BLOB_BYTES,
    });
  }

  const key = workingStateKey(row.id);
  await putFeedBlob(c.env, key, buf, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
  });

  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE feed_project
        SET working_state_version = working_state_version + 1,
            working_state_size = ?,
            working_state_updated_at = ?,
            updated_at = ?,
            working_state_r2_key = ?
      WHERE id = ? AND working_state_version = ?`,
  )
    .bind(size, now, now, key, row.id, row.working_state_version)
    .run();

  const changes = (result.meta as { changes?: number } | undefined)?.changes ?? 0;
  if (changes === 0) {
    const fresh = await c.env.DB.prepare(
      `SELECT working_state_version FROM feed_project WHERE id = ?`,
    )
      .bind(row.id)
      .first<{ working_state_version: number }>();
    throw new ApiError(409, 'conflict', 'Working state was updated concurrently', {
      currentVersion: fresh?.working_state_version ?? row.working_state_version,
    });
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: row.id,
    action: 'project.save_working_state',
    metadata: { size, version: row.working_state_version + 1 },
    ip: clientIp(c.req.raw),
  });

  return c.json({ workingStateVersion: row.working_state_version + 1 });
});

projectsRouter.post('/:id/versions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');

  let parsed: Record<string, string | File | (string | File)[]>;
  try {
    parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File | (string | File)[]>;
  } catch {
    throw validationFailed('Invalid multipart body');
  }

  const statePart = parsed['state'];
  const metaPart = parsed['meta'];
  if (!(statePart instanceof File) && !(statePart instanceof Blob)) {
    throw validationFailed('Missing state file');
  }
  if (typeof metaPart !== 'string') {
    throw validationFailed('Missing meta JSON');
  }

  let metaObj: unknown;
  try {
    metaObj = JSON.parse(metaPart);
  } catch {
    throw validationFailed('Invalid meta JSON');
  }
  const metaResult = versionMetaSchema.safeParse(metaObj);
  if (!metaResult.success) {
    throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
  }
  const meta = metaResult.data;

  const versionsUsed = await countVersions(c.env, row.id);
  const { warning } = enforceQuota(c.env, 'versions', versionsUsed, MAX_VERSIONS_PER_PROJECT);
  setQuotaWarningHeader(c, warning);

  const stateBuf = await (statePart as Blob).arrayBuffer();
  const stateSize = stateBuf.byteLength;
  if (stateSize === 0) throw validationFailed('Empty state file');
  enforceBlobSize(stateSize);

  const versionId = ulid();
  const stateKey = versionStateKey(row.id, versionId);
  await putFeedBlob(c.env, stateKey, stateBuf, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
  });

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO feed_version
       (id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
        summary_json, validation_errors, validation_warnings, created_at)
     VALUES (?, ?, ?, ?, ?, '', 0, ?, ?, ?, ?)`,
  )
    .bind(
      versionId,
      row.id,
      meta.label ?? null,
      user.id,
      stateKey,
      JSON.stringify(meta.summary),
      meta.validationErrors,
      meta.validationWarnings,
      now,
    )
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'version',
    subjectId: versionId,
    action: 'project.create_version',
    metadata: { projectId: row.id, label: meta.label ?? null, size: stateSize },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    version: {
      id: versionId,
      label: meta.label ?? null,
      createdAt: now,
      summary: meta.summary,
      validationErrors: meta.validationErrors,
      validationWarnings: meta.validationWarnings,
    },
  });
});

projectsRouter.get('/:id/versions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');

  const result = await c.env.DB.prepare(
    `SELECT id, project_id, label, created_by_user_id, state_r2_key, zip_r2_key, zip_size,
            summary_json, validation_errors, validation_warnings, created_at
       FROM feed_version WHERE project_id = ? ORDER BY created_at DESC`,
  )
    .bind(row.id)
    .all<VersionRow>();

  return c.json({
    versions: (result.results ?? []).map(shapeVersion),
  });
});

projectsRouter.get('/:id/versions/:vid/state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');
  const version = await requireOwnedVersion(c.env, row.id, vid);

  const object = await getFeedBlob(c.env, version.state_r2_key);
  if (!object) throw notFound('Version state missing');

  c.header('Content-Type', 'application/json');
  const decompressed = object.body.pipeThrough(new DecompressionStream('gzip'));
  return c.body(decompressed);
});

projectsRouter.post('/:id/versions/:vid/restore', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');
  const version = await requireOwnedVersion(c.env, row.id, vid);

  const source = await getFeedBlob(c.env, version.state_r2_key);
  if (!source) throw notFound('Version state missing');
  const buf = await source.arrayBuffer();
  const size = buf.byteLength;

  const key = workingStateKey(row.id);
  await putFeedBlob(c.env, key, buf, {
    contentType: 'application/json',
    contentEncoding: 'gzip',
  });

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE feed_project
        SET working_state_version = working_state_version + 1,
            working_state_size = ?,
            working_state_updated_at = ?,
            updated_at = ?,
            working_state_r2_key = ?
      WHERE id = ?`,
  )
    .bind(size, now, now, key, row.id)
    .run();

  const after = await c.env.DB.prepare(
    `SELECT working_state_version FROM feed_project WHERE id = ?`,
  )
    .bind(row.id)
    .first<{ working_state_version: number }>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: row.id,
    action: 'project.restore_version',
    metadata: { versionId: version.id },
    ip: clientIp(c.req.raw),
  });

  return c.json({ workingStateVersion: after?.working_state_version ?? row.working_state_version + 1 });
});

projectsRouter.delete('/:id/versions/:vid', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const { row } = await requireOwnedProject(c.env, user, id, 'editor');
  const version = await requireOwnedVersion(c.env, row.id, vid);

  await deleteFeedBlob(c.env, version.state_r2_key);
  if (version.zip_r2_key) {
    await deleteFeedBlob(c.env, version.zip_r2_key);
  }
  await c.env.DB.prepare(`DELETE FROM feed_version WHERE id = ? AND project_id = ?`)
    .bind(version.id, row.id)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'version',
    subjectId: version.id,
    action: 'project.delete_version',
    metadata: { projectId: row.id },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// GET /api/projects/:id/audit — append-only event log for this project.
// Gated on project ownership; reuses the same visibility rule as the editor.
projectsRouter.get('/:id/audit', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row } = await requireOwnedProject(c.env, user, id, 'viewer');

  const limitRaw = c.req.query('limit');
  const before = c.req.query('before');
  let limit = limitRaw ? parseInt(limitRaw, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;

  const binds: unknown[] = [row.id];
  let beforeClause = '';
  if (before) {
    beforeClause = ' AND id < ?';
    binds.push(before);
  }
  binds.push(limit);

  const result = await c.env.DB.prepare(
    `SELECT id, actor_user_id, subject_type, subject_id, action, metadata_json, created_at
       FROM audit_event
      WHERE subject_type = 'project' AND subject_id = ?${beforeClause}
      ORDER BY id DESC
      LIMIT ?`,
  )
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

projectsRouter.post('/import', async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, importSchema);

  const imported: unknown[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const item of body.projects) {
    const used = await countProjects(c.env, 'user', user.id);
    if (used >= MAX_PROJECTS_PER_OWNER) {
      skipped.push({ name: item.name, reason: 'quota_exceeded' });
      continue;
    }

    let decoded: Uint8Array;
    try {
      decoded = base64ToBytes(item.workingState);
    } catch {
      skipped.push({ name: item.name, reason: 'invalid_base64' });
      continue;
    }
    if (decoded.byteLength === 0) {
      skipped.push({ name: item.name, reason: 'empty_state' });
      continue;
    }
    if (decoded.byteLength > MAX_BLOB_BYTES) {
      skipped.push({ name: item.name, reason: 'too_large' });
      continue;
    }

    let desiredSlug: string;
    if (item.slug !== undefined && isValidSlug(item.slug)) {
      desiredSlug = item.slug;
    } else {
      desiredSlug = slugify(item.name);
    }
    const finalSlug = await uniqueSlug(c.env, 'user', user.id, desiredSlug);

    const projectId = ulid();
    const now = Date.now();
    const key = workingStateKey(projectId);

    await putFeedBlob(c.env, key, decoded, {
      contentType: 'application/json',
      contentEncoding: 'gzip',
    });

    await c.env.DB.prepare(
      `INSERT INTO feed_project
         (id, slug, name, description, owner_type, owner_id,
          working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', ?, ?, 1, ?, ?, NULL, NULL, ?, ?)`,
    )
      .bind(
        projectId,
        finalSlug,
        item.name,
        item.description ?? null,
        user.id,
        key,
        decoded.byteLength,
        now,
        now,
        now,
      )
      .run();

    const row = await c.env.DB.prepare(
      `SELECT id, slug, name, description, owner_type, owner_id,
              working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
              archived_at, deleted_at, created_at, updated_at
         FROM feed_project WHERE id = ?`,
    )
      .bind(projectId)
      .first<ProjectRow>();

    imported.push(shapeProject(row!));
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'project.imported_from_local',
    metadata: { count: imported.length, skipped: skipped.length },
    ip: clientIp(c.req.raw),
  });

  return c.json({ imported, skipped });
});

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/\s+/g, '');
  const bin = atob(normalized);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLICATION, DRAFT LINKS, CATALOGS, RT FEEDS — §5/§6 of BACKEND_REQUIREMENTS
// ═══════════════════════════════════════════════════════════════════════════

const publishJsonSchema = z.object({
  versionId: z.string().min(1),
  ignoreWarnings: z.boolean().optional(),
  ignoreRtBreakage: z.boolean().optional(),
});

const draftLinkCreateSchema = z.object({
  versionId: z.string().min(1),
  ttlDays: z.number().int().positive().max(365).optional(),
});

const catalogCreateSchema = z.object({
  catalog: z.enum(['mobility_db', 'transit_land']),
});

const rtFeedItemSchema = z.object({
  kind: z.enum(['vehicle_positions', 'trip_updates', 'alerts']),
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'URL must be https://'),
});
const rtFeedsPutSchema = z.object({
  feeds: z.array(rtFeedItemSchema).max(10),
});

interface PublicationRow {
  project_id: string;
  version_id: string;
  published_by_user_id: string | null;
  published_at: number;
  canonical_slug: string;
  zip_r2_key: string;
}

async function loadPublication(env: Env, projectId: string): Promise<PublicationRow | null> {
  return env.DB.prepare(
    `SELECT project_id, version_id, published_by_user_id, published_at, canonical_slug, zip_r2_key
       FROM publication WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<PublicationRow>();
}

// ─── POST /api/projects/:id/publish ────────────────────────────────────────────
//
// Two request shapes:
//   1. multipart/form-data with `meta` (JSON) and `zip` (file) — used when the
//      version row doesn't yet carry a rendered ZIP in R2 (the common case
//      today; Phase 2's snapshot path only stores state, not the ZIP).
//   2. application/json with `{ versionId, ignoreWarnings?, ignoreRtBreakage? }`
//      — used when the version row already has `zip_r2_key` populated.
projectsRouter.post('/:id/publish', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const now = Date.now();

  const contentType = c.req.header('Content-Type') ?? '';
  let versionId: string;
  let ignoreWarnings = false;
  let ignoreRtBreakage = false;
  let incomingZip: ArrayBuffer | null = null;

  if (contentType.includes('multipart/form-data')) {
    let parsed: Record<string, string | File | (string | File)[]>;
    try {
      parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File | (string | File)[]>;
    } catch {
      throw validationFailed('Invalid multipart body');
    }
    const metaPart = parsed['meta'];
    const zipPart = parsed['zip'];
    if (typeof metaPart !== 'string') throw validationFailed('Missing meta JSON');
    if (!(zipPart instanceof File) && !(zipPart instanceof Blob)) {
      throw validationFailed('Missing zip file');
    }
    let metaObj: unknown;
    try { metaObj = JSON.parse(metaPart); } catch { throw validationFailed('Invalid meta JSON'); }
    const metaResult = publishJsonSchema.safeParse(metaObj);
    if (!metaResult.success) {
      throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
    }
    versionId = metaResult.data.versionId;
    ignoreWarnings = metaResult.data.ignoreWarnings ?? false;
    ignoreRtBreakage = metaResult.data.ignoreRtBreakage ?? false;
    incomingZip = await (zipPart as Blob).arrayBuffer();
    if (incomingZip.byteLength === 0) throw validationFailed('Empty zip');
    enforceBlobSize(incomingZip.byteLength);
  } else {
    const body = await parseJson(c, publishJsonSchema);
    versionId = body.versionId;
    ignoreWarnings = body.ignoreWarnings ?? false;
    ignoreRtBreakage = body.ignoreRtBreakage ?? false;
  }

  const version = await requireOwnedVersion(c.env, project.id, versionId);

  // Validation gate: errors block publish unless ignoreWarnings=true.
  // (The flag is slightly misnamed — in practice it's "publish anyway" — but
  // matches the requirement spec's vocabulary and the frontend field name.)
  if (version.validation_errors > 0 && !ignoreWarnings) {
    throw validationFailed('Feed has validation errors. Fix them or pass ignoreWarnings=true to publish anyway.', {
      validationErrors: version.validation_errors,
      validationWarnings: version.validation_warnings,
    });
  }

  // ID-stability check (BE-88). Only runs when the project has RT feed URLs
  // registered AND there's an existing publication to diff against.
  const existing = await loadPublication(c.env, project.id);
  const rtCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM project_rt_feed WHERE project_id = ?`,
  )
    .bind(project.id)
    .first<{ n: number }>();
  if (existing && (rtCount?.n ?? 0) > 0 && existing.version_id !== version.id && !ignoreRtBreakage) {
    const prior = await requireOwnedVersion(c.env, project.id, existing.version_id);
    const removed = await diffRemovedIds(c.env, prior.state_r2_key, version.state_r2_key);
    if (!rtReportEmpty(removed)) {
      throw rtBreakage({
        removed: {
          agencies: removed.agencies,
          routes: removed.routes,
          stops: removed.stops,
          trips: removed.trips,
        },
      });
    }
  }

  // Copy the rendered ZIP into the publication slot in R2.
  const pubKey = publicationZipKey(project.id, version.id);
  let publishedBytes = 0;
  if (incomingZip) {
    await putFeedBlob(c.env, pubKey, incomingZip, { contentType: 'application/zip' });
    publishedBytes = incomingZip.byteLength;
  } else {
    // JSON path — require an existing rendered ZIP on the version row.
    if (!version.zip_r2_key) {
      throw validationFailed('This version has no rendered ZIP. Publish with multipart form instead.');
    }
    const source = await getFeedBlob(c.env, version.zip_r2_key);
    if (!source) throw notFound('Rendered ZIP missing from storage');
    const buf = await source.arrayBuffer();
    publishedBytes = buf.byteLength;
    await putFeedBlob(c.env, pubKey, buf, { contentType: 'application/zip' });
  }

  // Upsert publication + append history.
  const wasRollback = existing && existing.version_id !== version.id;
  await c.env.DB.prepare(
    `INSERT INTO publication (project_id, version_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       version_id = excluded.version_id,
       published_by_user_id = excluded.published_by_user_id,
       published_at = excluded.published_at,
       canonical_slug = excluded.canonical_slug,
       zip_r2_key = excluded.zip_r2_key`,
  )
    .bind(project.id, version.id, user.id, now, project.slug, pubKey)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, version_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'publish', ?, ?)`,
  )
    .bind(ulid(), project.id, version.id, user.id, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.publish',
    metadata: { versionId: version.id, size: publishedBytes, rollback: !!wasRollback },
    ip: clientIp(c.req.raw),
  });

  // Auto-submit to any opted-in catalogs (BE-80/83). Background, so the
  // response returns immediately. Submission routines never throw — they
  // record errors in project_catalog_submission.status for the UI to surface.
  const feedsOrigin = c.env.FEEDS_ORIGIN;
  const slug = project.slug;
  const name = project.name;
  c.executionCtx.waitUntil(
    submitToCatalogs(c.env, {
      projectId: project.id,
      slug,
      feedsOrigin,
      feedTitle: name,
    }).catch((err) => {
      console.error('[publish] catalog submission error', err);
    }),
  );

  const canonicalUrl = `${feedsOrigin.replace(/\/$/, '')}/${project.slug}/gtfs.zip`;
  return c.json({
    publication: {
      projectId: project.id,
      versionId: version.id,
      publishedAt: now,
      canonicalUrl,
    },
  });
});

// ─── POST /api/projects/:id/unpublish ──────────────────────────────────────────
projectsRouter.post('/:id/unpublish', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  const existing = await loadPublication(c.env, project.id);
  if (!existing) {
    // Idempotent — no-op.
    return c.body(null, 204);
  }

  const now = Date.now();
  await c.env.DB.prepare(`DELETE FROM publication WHERE project_id = ?`)
    .bind(project.id)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, version_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'unpublish', ?, ?)`,
  )
    .bind(ulid(), project.id, existing.version_id, user.id, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.unpublish',
    metadata: { versionId: existing.version_id },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── POST /api/projects/:id/publish/rollback ───────────────────────────────────
projectsRouter.post('/:id/publish/rollback', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const body = await parseJson(c, publishJsonSchema);
  const version = await requireOwnedVersion(c.env, project.id, body.versionId);

  // We require either (a) an already-published ZIP in the publication slot
  // (i.e. we rolled off this version, now rolling back), or (b) a rendered
  // ZIP on the version row. If neither, the client must use the multipart
  // publish endpoint instead.
  const pubKey = publicationZipKey(project.id, version.id);
  const existingPubObj = await getFeedBlob(c.env, pubKey);
  let sourceKey: string | null = null;
  if (existingPubObj) {
    sourceKey = pubKey;
  } else if (version.zip_r2_key) {
    const versionObj = await getFeedBlob(c.env, version.zip_r2_key);
    if (versionObj) sourceKey = version.zip_r2_key;
  }
  if (!sourceKey) {
    throw validationFailed('No rendered ZIP available for this version. Re-publish with a zip upload.');
  }

  if (sourceKey !== pubKey) {
    const source = await getFeedBlob(c.env, sourceKey);
    if (!source) throw notFound('Rendered ZIP missing');
    const buf = await source.arrayBuffer();
    await putFeedBlob(c.env, pubKey, buf, { contentType: 'application/zip' });
  }

  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO publication (project_id, version_id, published_by_user_id, published_at, canonical_slug, zip_r2_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       version_id = excluded.version_id,
       published_by_user_id = excluded.published_by_user_id,
       published_at = excluded.published_at,
       canonical_slug = excluded.canonical_slug,
       zip_r2_key = excluded.zip_r2_key`,
  )
    .bind(project.id, version.id, user.id, now, project.slug, pubKey)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO publication_history (id, project_id, version_id, action, actor_user_id, created_at)
     VALUES (?, ?, ?, 'rollback', ?, ?)`,
  )
    .bind(ulid(), project.id, version.id, user.id, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.publish',
    metadata: { versionId: version.id, rollback: true },
    ip: clientIp(c.req.raw),
  });

  const canonicalUrl = `${c.env.FEEDS_ORIGIN.replace(/\/$/, '')}/${project.slug}/gtfs.zip`;
  return c.json({
    publication: {
      projectId: project.id,
      versionId: version.id,
      publishedAt: now,
      canonicalUrl,
    },
  });
});

// ─── GET /api/projects/:id/publish/history ─────────────────────────────────────
projectsRouter.get('/:id/publish/history', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  const history = await c.env.DB.prepare(
    `SELECT id, version_id, action, actor_user_id, created_at
       FROM publication_history
       WHERE project_id = ?
       ORDER BY created_at DESC`,
  )
    .bind(project.id)
    .all<{ id: string; version_id: string | null; action: string; actor_user_id: string | null; created_at: number }>();

  const current = await loadPublication(c.env, project.id);
  return c.json({
    history: (history.results ?? []).map((r) => ({
      id: r.id,
      versionId: r.version_id,
      action: r.action,
      actorUserId: r.actor_user_id,
      createdAt: r.created_at,
    })),
    current: current
      ? { versionId: current.version_id, publishedAt: current.published_at }
      : null,
  });
});

// ─── Draft links ───────────────────────────────────────────────────────────────

projectsRouter.post('/:id/draft-links', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const now = Date.now();

  const contentType = c.req.header('Content-Type') ?? '';
  let versionId: string;
  let ttlDays = 30;
  let incomingZip: ArrayBuffer | null = null;

  if (contentType.includes('multipart/form-data')) {
    let parsed: Record<string, string | File | (string | File)[]>;
    try {
      parsed = (await c.req.parseBody({ all: false })) as Record<string, string | File | (string | File)[]>;
    } catch {
      throw validationFailed('Invalid multipart body');
    }
    const metaPart = parsed['meta'];
    const zipPart = parsed['zip'];
    if (typeof metaPart !== 'string') throw validationFailed('Missing meta JSON');
    if (!(zipPart instanceof File) && !(zipPart instanceof Blob)) {
      throw validationFailed('Missing zip file');
    }
    let metaObj: unknown;
    try { metaObj = JSON.parse(metaPart); } catch { throw validationFailed('Invalid meta JSON'); }
    const metaResult = draftLinkCreateSchema.safeParse(metaObj);
    if (!metaResult.success) throw validationFailed('Invalid meta', { issues: metaResult.error.issues });
    versionId = metaResult.data.versionId;
    ttlDays = metaResult.data.ttlDays ?? 30;
    incomingZip = await (zipPart as Blob).arrayBuffer();
    if (incomingZip.byteLength === 0) throw validationFailed('Empty zip');
    enforceBlobSize(incomingZip.byteLength);
  } else {
    const body = await parseJson(c, draftLinkCreateSchema);
    versionId = body.versionId;
    ttlDays = body.ttlDays ?? 30;
  }

  const version = await requireOwnedVersion(c.env, project.id, versionId);

  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const key = draftZipKey(project.id, tokenHash);

  if (incomingZip) {
    await putFeedBlob(c.env, key, incomingZip, { contentType: 'application/zip' });
  } else {
    if (!version.zip_r2_key) {
      throw validationFailed('This version has no rendered ZIP. Create a draft link with multipart form instead.');
    }
    const source = await getFeedBlob(c.env, version.zip_r2_key);
    if (!source) throw notFound('Rendered ZIP missing from storage');
    const buf = await source.arrayBuffer();
    await putFeedBlob(c.env, key, buf, { contentType: 'application/zip' });
  }

  const expiresAt = now + ttlDays * 24 * 60 * 60 * 1000;
  await c.env.DB.prepare(
    `INSERT INTO draft_link (token_hash, project_id, version_id, created_by_user_id, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(tokenHash, project.id, version.id, user.id, expiresAt, now)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.create_draft_link',
    metadata: { versionId: version.id, expiresAt },
    ip: clientIp(c.req.raw),
  });

  const url = `${c.env.FEEDS_ORIGIN.replace(/\/$/, '')}/${project.slug}/draft/${token}.zip`;
  return c.json({ url, token, tokenHash, expiresAt });
});

projectsRouter.get('/:id/draft-links', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');
  const now = Date.now();

  const rows = await c.env.DB.prepare(
    `SELECT token_hash, version_id, expires_at, created_at
       FROM draft_link
       WHERE project_id = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       ORDER BY created_at DESC`,
  )
    .bind(project.id, now)
    .all<{ token_hash: string; version_id: string; expires_at: number; created_at: number }>();

  return c.json({
    links: (rows.results ?? []).map((r) => ({
      tokenHash: r.token_hash,
      versionId: r.version_id,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    })),
  });
});

projectsRouter.delete('/:id/draft-links/:tokenHash', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const tokenHash = c.req.param('tokenHash');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  const row = await c.env.DB.prepare(
    `SELECT token_hash, project_id, revoked_at FROM draft_link WHERE token_hash = ? AND project_id = ?`,
  )
    .bind(tokenHash, project.id)
    .first<{ token_hash: string; project_id: string; revoked_at: number | null }>();
  if (!row) throw notFound('Draft link not found');

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE draft_link SET revoked_at = ? WHERE token_hash = ?`,
  )
    .bind(now, tokenHash)
    .run();
  // Best-effort: remove the R2 blob so it can't leak via a stale URL.
  await deleteFeedBlob(c.env, draftZipKey(project.id, tokenHash));

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.revoke_draft_link',
    metadata: { tokenHash },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── Catalog submissions (BE-80..83) ───────────────────────────────────────────

projectsRouter.post('/:id/catalog-submissions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const body = await parseJson(c, catalogCreateSchema);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO project_catalog_submission
       (project_id, catalog, external_feed_id, opted_in_at, last_submitted_at, status, last_error)
     VALUES (?, ?, NULL, ?, NULL, 'pending', NULL)
     ON CONFLICT(project_id, catalog) DO UPDATE SET
       opted_in_at = excluded.opted_in_at,
       status = 'pending',
       last_error = NULL`,
  )
    .bind(project.id, body.catalog, now)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT project_id, catalog, external_feed_id, opted_in_at, last_submitted_at, status, last_error
       FROM project_catalog_submission WHERE project_id = ? AND catalog = ?`,
  )
    .bind(project.id, body.catalog)
    .first<{
      project_id: string;
      catalog: string;
      external_feed_id: string | null;
      opted_in_at: number;
      last_submitted_at: number | null;
      status: string;
      last_error: string | null;
    }>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.catalog_opt_in',
    metadata: { catalog: body.catalog },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    submission: row && {
      projectId: row.project_id,
      catalog: row.catalog,
      externalFeedId: row.external_feed_id,
      optedInAt: row.opted_in_at,
      lastSubmittedAt: row.last_submitted_at,
      status: row.status,
      lastError: row.last_error,
    },
  });
});

projectsRouter.get('/:id/catalog-submissions', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  const rows = await c.env.DB.prepare(
    `SELECT project_id, catalog, external_feed_id, opted_in_at, last_submitted_at, status, last_error
       FROM project_catalog_submission WHERE project_id = ? ORDER BY catalog`,
  )
    .bind(project.id)
    .all<{
      project_id: string;
      catalog: string;
      external_feed_id: string | null;
      opted_in_at: number;
      last_submitted_at: number | null;
      status: string;
      last_error: string | null;
    }>();

  return c.json({
    submissions: (rows.results ?? []).map((r) => ({
      projectId: r.project_id,
      catalog: r.catalog,
      externalFeedId: r.external_feed_id,
      optedInAt: r.opted_in_at,
      lastSubmittedAt: r.last_submitted_at,
      status: r.status,
      lastError: r.last_error,
    })),
  });
});

projectsRouter.delete('/:id/catalog-submissions/:catalog', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const catalog = c.req.param('catalog');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  if (catalog !== 'mobility_db' && catalog !== 'transit_land') {
    throw validationFailed('Unknown catalog');
  }
  await c.env.DB.prepare(
    `DELETE FROM project_catalog_submission WHERE project_id = ? AND catalog = ?`,
  )
    .bind(project.id, catalog)
    .run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.catalog_opt_out',
    metadata: { catalog },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// ─── RT feed URLs (BE-87..89) ──────────────────────────────────────────────────

projectsRouter.get('/:id/rt-feeds', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'viewer');

  const rows = await c.env.DB.prepare(
    `SELECT id, kind, url FROM project_rt_feed WHERE project_id = ? ORDER BY created_at`,
  )
    .bind(project.id)
    .all<{ id: string; kind: string; url: string }>();
  return c.json({ feeds: rows.results ?? [] });
});

projectsRouter.put('/:id/rt-feeds', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');
  const body = await parseJson(c, rtFeedsPutSchema);
  const now = Date.now();

  await c.env.DB.prepare(`DELETE FROM project_rt_feed WHERE project_id = ?`)
    .bind(project.id)
    .run();
  for (const feed of body.feeds) {
    await c.env.DB.prepare(
      `INSERT INTO project_rt_feed (id, project_id, kind, url, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(ulid(), project.id, feed.kind, feed.url, now)
      .run();
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.rt_feeds_update',
    metadata: { count: body.feeds.length },
    ip: clientIp(c.req.raw),
  });

  const rows = await c.env.DB.prepare(
    `SELECT id, kind, url FROM project_rt_feed WHERE project_id = ? ORDER BY created_at`,
  )
    .bind(project.id)
    .all<{ id: string; kind: string; url: string }>();
  return c.json({ feeds: rows.results ?? [] });
});

projectsRouter.delete('/:id/rt-feeds/:rtId', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const rtId = c.req.param('rtId');
  const { row: project } = await requireOwnedProject(c.env, user, id, 'editor');

  const row = await c.env.DB.prepare(
    `SELECT id FROM project_rt_feed WHERE id = ? AND project_id = ?`,
  )
    .bind(rtId, project.id)
    .first<{ id: string }>();
  if (!row) throw notFound('RT feed not found');
  await c.env.DB.prepare(`DELETE FROM project_rt_feed WHERE id = ?`).bind(rtId).run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'publication',
    subjectId: project.id,
    action: 'project.rt_feed_delete',
    metadata: { rtId },
    ip: clientIp(c.req.raw),
  });

  return c.body(null, 204);
});

// Keep versionZipKey imported — future Phase 2 work will begin writing ZIPs
// into version slots, at which point publish's JSON body path exercises it.
void versionZipKey;
