import type { Env } from '../env';
import { quotaExceeded } from '../util/errors';

export const MAX_PROJECTS_PER_OWNER = 20;
export const MAX_VERSIONS_PER_PROJECT = 50;
export const MAX_BLOB_BYTES = 50 * 1024 * 1024;

export type QuotaKind = 'projects' | 'versions' | 'blob';

export interface EnforceResult {
  warning: string | null;
}

export async function countProjects(env: Env, ownerType: string, ownerId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feed_project WHERE owner_type = ? AND owner_id = ? AND deleted_at IS NULL`,
  )
    .bind(ownerType, ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countVersions(env: Env, projectId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feed_version WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function isHard(env: Env): boolean {
  return env.HARD_LIMITS === 'true';
}

export function enforceQuota(
  env: Env,
  kind: QuotaKind,
  used: number,
  limit: number,
): EnforceResult {
  if (used >= limit) {
    if (isHard(env)) {
      throw quotaExceeded(quotaMessage(kind, used, limit), { kind, used, limit });
    }
    return { warning: `${used}/${limit}` };
  }
  const warnAt = Math.floor(limit * 0.9);
  if (used >= warnAt) {
    return { warning: `${used}/${limit}` };
  }
  return { warning: null };
}

export function enforceBlobSize(size: number): void {
  if (size > MAX_BLOB_BYTES) {
    throw quotaExceeded(`Feed state exceeds the ${Math.floor(MAX_BLOB_BYTES / (1024 * 1024))} MB limit`, {
      kind: 'blob',
      used: size,
      limit: MAX_BLOB_BYTES,
    });
  }
}

function quotaMessage(kind: QuotaKind, used: number, limit: number): string {
  switch (kind) {
    case 'projects':
      return `Project limit reached (${used}/${limit}). Archive or delete a project to free space.`;
    case 'versions':
      return `Version limit reached for this project (${used}/${limit}). Delete old versions to free space.`;
    case 'blob':
      return `Feed state size exceeds the allowed limit (${used}/${limit} bytes).`;
  }
}
