import type { Env } from '../env';

export function workingStateKey(projectId: string): string {
  return `projects/${projectId}/working-state.json.gz`;
}

export function snapshotStateKey(projectId: string, snapshotId: string): string {
  return `projects/${projectId}/snapshots/${snapshotId}/state.json.gz`;
}

export function snapshotZipKey(projectId: string, snapshotId: string): string {
  return `projects/${projectId}/snapshots/${snapshotId}/gtfs.zip`;
}

export function publicationZipKey(projectId: string, snapshotId: string): string {
  return `publications/${projectId}/${snapshotId}/gtfs.zip`;
}

export type ThumbnailSize = 'lg' | 'sm';

// Per-project route-map thumbnail (rendered via Mapbox Static Images, see
// worker/embeds/thumbnail.ts). One pair per project; overwritten on regen.
export function thumbnailKey(projectId: string, size: ThumbnailSize): string {
  const dims = size === 'sm' ? '400x300' : '1200x630';
  return `projects/${projectId}/thumbnail-${dims}.png`;
}

export function draftZipKey(projectId: string, tokenHash: string): string {
  return `draft-links/${projectId}/${tokenHash}.zip`;
}

export function projectPrefix(projectId: string): string {
  return `projects/${projectId}/`;
}

export interface BlobWriteOpts {
  contentType: string;
  contentEncoding?: string;
}

export async function putFeedBlob(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array,
  opts: BlobWriteOpts,
): Promise<void> {
  await env.FEEDS.put(key, body, {
    httpMetadata: {
      contentType: opts.contentType,
      ...(opts.contentEncoding ? { contentEncoding: opts.contentEncoding } : {}),
    },
  });
}

export async function getFeedBlob(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.FEEDS.get(key);
}

export async function deleteFeedBlob(env: Env, key: string): Promise<void> {
  await env.FEEDS.delete(key);
}

export async function deleteProjectBlobs(env: Env, projectId: string): Promise<void> {
  const prefix = projectPrefix(projectId);
  let cursor: string | undefined = undefined;
  while (true) {
    const listed: R2Objects = await env.FEEDS.list({ prefix, cursor });
    if (listed.objects.length > 0) {
      await env.FEEDS.delete(listed.objects.map((o) => o.key));
    }
    if (!listed.truncated) break;
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor) break;
  }
}
