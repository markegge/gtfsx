import type { Env } from '../env';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = base.slice(0, 63);
  const leading = trimmed.replace(/^-+/, '');
  if (leading.length === 0) return 'feed';
  return leading;
}

export async function uniqueSlug(
  env: Env,
  ownerType: string,
  ownerId: string,
  desired: string,
  excludeProjectId?: string,
): Promise<string> {
  let candidate = desired;
  let n = 2;
  while (await slugExists(env, ownerType, ownerId, candidate, excludeProjectId)) {
    const suffix = `-${n}`;
    const base = desired.slice(0, 63 - suffix.length);
    candidate = `${base}${suffix}`;
    n += 1;
    if (n > 1000) throw new Error('could not allocate unique slug');
  }
  return candidate;
}

async function slugExists(
  env: Env,
  ownerType: string,
  ownerId: string,
  slug: string,
  excludeProjectId?: string,
): Promise<boolean> {
  const sql = excludeProjectId
    ? `SELECT id FROM feed_project WHERE owner_type = ? AND owner_id = ? AND slug = ? AND deleted_at IS NULL AND id != ? LIMIT 1`
    : `SELECT id FROM feed_project WHERE owner_type = ? AND owner_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1`;
  const stmt = excludeProjectId
    ? env.DB.prepare(sql).bind(ownerType, ownerId, slug, excludeProjectId)
    : env.DB.prepare(sql).bind(ownerType, ownerId, slug);
  const row = await stmt.first<{ id: string }>();
  return !!row;
}
