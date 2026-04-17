import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext, AuthedUser, Env } from '../env';
import { requireAuth } from '../auth/middleware';
import {
  conflict,
  notFound,
  validationFailed,
  ApiError,
} from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
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
  getFeedBlob,
  putFeedBlob,
  versionStateKey,
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

async function requireOwnedProject(
  env: Env,
  user: AuthedUser,
  projectId: string,
): Promise<ProjectRow> {
  const row = await env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at
       FROM feed_project WHERE id = ?`,
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row || row.deleted_at !== null) throw notFound('Project not found');
  if (row.owner_type !== 'user' || row.owner_id !== user.id) throw notFound('Project not found');
  return row;
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
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  slug: z.string().optional(),
  archivedAt: z.union([z.null(), z.literal('now')]).optional(),
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

  const used = await countProjects(c.env, 'user', user.id);
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
  const finalSlug = await uniqueSlug(c.env, 'user', user.id, desiredSlug);

  const now = Date.now();
  const id = ulid();
  await c.env.DB.prepare(
    `INSERT INTO feed_project
       (id, slug, name, description, owner_type, owner_id,
        working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
        archived_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'user', ?, NULL, 0, NULL, NULL, NULL, NULL, ?, ?)`,
  )
    .bind(id, finalSlug, body.name, body.description ?? null, user.id, now, now)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT id, slug, name, description, owner_type, owner_id,
            working_state_r2_key, working_state_version, working_state_size, working_state_updated_at,
            archived_at, deleted_at, created_at, updated_at
       FROM feed_project WHERE id = ?`,
  )
    .bind(id)
    .first<ProjectRow>();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'project',
    subjectId: id,
    action: 'project.create',
    metadata: { slug: finalSlug, name: body.name },
    ip: clientIp(c.req.raw),
  });

  return c.json(shapeProject(row!), 201);
});

projectsRouter.get('/', async (c) => {
  const user = c.var.user!;
  const includeArchived = c.req.query('include_archived') === '1';
  const scope = c.req.query('scope') ?? 'personal';
  if (scope !== 'personal') {
    throw validationFailed('Only scope=personal is supported');
  }

  const archivedFilter = includeArchived ? '' : ' AND archived_at IS NULL';
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.description, p.owner_type, p.owner_id,
            p.working_state_r2_key, p.working_state_version, p.working_state_size, p.working_state_updated_at,
            p.archived_at, p.deleted_at, p.created_at, p.updated_at,
            (SELECT COUNT(*) FROM feed_version v WHERE v.project_id = p.id) AS version_count,
            (SELECT MAX(v.created_at) FROM feed_version v WHERE v.project_id = p.id) AS last_version_created_at
       FROM feed_project p
       WHERE p.owner_type = 'user' AND p.owner_id = ? AND p.deleted_at IS NULL${archivedFilter}
       ORDER BY COALESCE(p.working_state_updated_at, p.updated_at) DESC`,
  )
    .bind(user.id)
    .all<ProjectRow & { version_count: number; last_version_created_at: number | null }>();

  const projects = (rows.results ?? []).map((r) => ({
    ...shapeProject(r),
    versionCount: r.version_count,
    lastVersionCreatedAt: r.last_version_created_at,
  }));

  const used = await countProjects(c.env, 'user', user.id);
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
  const row = await requireOwnedProject(c.env, user, id);

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
    versions: (versions.results ?? []).map(shapeVersion),
  });
});

projectsRouter.patch('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const body = await parseJson(c, patchSchema);
  const current = await requireOwnedProject(c.env, user, id);

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
            archived_at, deleted_at, created_at, updated_at
       FROM feed_project WHERE id = ?`,
  )
    .bind(current.id)
    .first<ProjectRow>();
  return c.json(shapeProject(updated!));
});

projectsRouter.delete('/:id', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const current = await requireOwnedProject(c.env, user, id);

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
  const row = await requireOwnedProject(c.env, user, id);
  if (!row.working_state_r2_key) throw notFound('No working state yet');

  const object = await getFeedBlob(c.env, row.working_state_r2_key);
  if (!object) throw notFound('Working state blob missing');

  c.header('Content-Type', 'application/json');
  c.header('Content-Encoding', 'gzip');
  c.header('X-Working-State-Version', String(row.working_state_version));
  if (row.working_state_size != null) {
    c.header('Content-Length', String(row.working_state_size));
  }
  return c.body(object.body);
});

projectsRouter.put('/:id/working-state', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const row = await requireOwnedProject(c.env, user, id);

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
  const row = await requireOwnedProject(c.env, user, id);

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
  const row = await requireOwnedProject(c.env, user, id);

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
  const row = await requireOwnedProject(c.env, user, id);
  const version = await requireOwnedVersion(c.env, row.id, vid);

  const object = await getFeedBlob(c.env, version.state_r2_key);
  if (!object) throw notFound('Version state missing');

  c.header('Content-Type', 'application/json');
  c.header('Content-Encoding', 'gzip');
  return c.body(object.body);
});

projectsRouter.post('/:id/versions/:vid/restore', async (c) => {
  const user = c.var.user!;
  const id = c.req.param('id');
  const vid = c.req.param('vid');
  const row = await requireOwnedProject(c.env, user, id);
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
  const row = await requireOwnedProject(c.env, user, id);
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
