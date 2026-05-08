import type { Env } from '../env';
import { getFeedBlob } from '../projects/r2';
import type { FeedState, LoadedEmbedFeed } from './types';

interface PublicationRow {
  project_id: string;
  version_id: string;
  published_at: number;
}

interface VersionRow {
  state_r2_key: string;
}

interface ProjectRow {
  name: string;
  brand_primary_color: string | null;
}

/**
 * Load the parsed JSON state for the canonical published version of a
 * feed slug. Returns null when the slug is not published. The returned
 * `state` is the same shape produced by the editor's `buildSnapshot()`
 * (see `src/db/serverPersistence.ts`).
 */
export async function loadEmbedFeed(env: Env, slug: string): Promise<LoadedEmbedFeed | null> {
  const pub = await env.DB.prepare(
    `SELECT p.project_id, p.version_id, p.published_at
       FROM publication p
       JOIN feed_project fp ON fp.id = p.project_id
      WHERE p.canonical_slug = ? AND fp.deleted_at IS NULL`,
  )
    .bind(slug)
    .first<PublicationRow>();

  if (!pub) return null;

  const [version, project] = await Promise.all([
    env.DB.prepare(`SELECT state_r2_key FROM feed_version WHERE id = ?`)
      .bind(pub.version_id)
      .first<VersionRow>(),
    env.DB.prepare(`SELECT name, brand_primary_color FROM feed_project WHERE id = ?`)
      .bind(pub.project_id)
      .first<ProjectRow>(),
  ]);

  if (!version || !project) return null;

  const blob = await getFeedBlob(env, version.state_r2_key);
  if (!blob) return null;

  // The blob is gzipped JSON. Decompress + parse.
  const decompressed = blob.body.pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(decompressed).text();
  let parsed: Partial<FeedState>;
  try {
    parsed = JSON.parse(text) as Partial<FeedState>;
  } catch {
    console.error('[embeds] feed JSON parse failed', { slug, versionId: pub.version_id });
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
    versionId: pub.version_id,
    publishedAt: pub.published_at,
    projectName: project.name,
    brandPrimaryColor: project.brand_primary_color,
    state,
  };
}
