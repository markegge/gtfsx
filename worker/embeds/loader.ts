import type { Env } from '../env';
import { getFeedBlob } from '../projects/r2';
import type { FeedState, LoadedEmbedFeed } from './types';

interface PublicationRow {
  project_id: string;
  snapshot_id: string;
  published_at: number;
}

interface SnapshotRow {
  state_r2_key: string;
}

interface ProjectRow {
  name: string;
  brand_primary_color: string | null;
  owner_type: string;
  owner_id: string;
  thumbnail_version: number;
}

interface OrgLogoRow {
  brand_logo_r2_key: string | null;
  brand_logo_updated_at: number | null;
}

/**
 * Load the parsed JSON state for the canonical published version of a
 * feed slug. Returns null when the slug is not published. The returned
 * `state` is the same shape produced by the editor's `buildSnapshot()`
 * (see `src/db/serverPersistence.ts`).
 */
export async function loadEmbedFeed(env: Env, slug: string): Promise<LoadedEmbedFeed | null> {
  const pub = await env.DB.prepare(
    `SELECT p.project_id, p.snapshot_id, p.published_at
       FROM publication p
       JOIN feed_project fp ON fp.id = p.project_id
      WHERE p.canonical_slug = ? AND fp.deleted_at IS NULL`,
  )
    .bind(slug)
    .first<PublicationRow>();

  if (!pub) return null;

  const [snapshot, project] = await Promise.all([
    env.DB.prepare(`SELECT state_r2_key FROM feed_snapshot WHERE id = ?`)
      .bind(pub.snapshot_id)
      .first<SnapshotRow>(),
    env.DB.prepare(
      `SELECT name, brand_primary_color, owner_type, owner_id, thumbnail_version FROM feed_project WHERE id = ?`,
    )
      .bind(pub.project_id)
      .first<ProjectRow>(),
  ]);

  if (!snapshot || !project) return null;

  let brandLogoUrl: string | null = null;
  if (project.owner_type === 'org') {
    const orgLogo = await env.DB.prepare(
      `SELECT brand_logo_r2_key, brand_logo_updated_at FROM organization WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(project.owner_id)
      .first<OrgLogoRow>();
    if (orgLogo?.brand_logo_r2_key) {
      const origin = env.FEEDS_ORIGIN.replace(/\/$/, '');
      const v = orgLogo.brand_logo_updated_at ? `?v=${orgLogo.brand_logo_updated_at}` : '';
      brandLogoUrl = `${origin}/_/orgs/${project.owner_id}/logo${v}`;
    }
  }

  const blob = await getFeedBlob(env, snapshot.state_r2_key);
  if (!blob) return null;

  // The blob is gzipped JSON. Decompress + parse.
  const decompressed = blob.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(decompressed).text();
  let parsed: Partial<FeedState>;
  try {
    parsed = JSON.parse(text) as Partial<FeedState>;
  } catch {
    console.error('[embeds] feed JSON parse failed', { slug, snapshotId: pub.snapshot_id });
    return null;
  }

  const state: FeedState = {
    agencies: parsed.agencies ?? [],
    calendars: parsed.calendars ?? [],
    calendarDates: parsed.calendarDates ?? [],
    routes: parsed.routes ?? [],
    stops: parsed.stops ?? [],
    trips: parsed.trips ?? [],
    stopTimes: parsed.stopTimes ?? [],
    shapes: parsed.shapes ?? [],
    feedInfo: parsed.feedInfo ?? null,
  };

  return {
    slug,
    projectId: pub.project_id,
    snapshotId: pub.snapshot_id,
    publishedAt: pub.published_at,
    projectName: project.name,
    brandPrimaryColor: project.brand_primary_color,
    brandLogoUrl,
    thumbnailVersion: project.thumbnail_version ?? 0,
    state,
  };
}
