// Dedicated forum-image host (IMAGES_ORIGIN — img.gtfsx.com /
// staging-img.gtfsx.com, and any `img.*` host in dev/test). The worker routes
// these hostnames to forumImageOnlyHandler, which serves ONLY
// /_forum-images/... and 404s everything else — it must NOT expose the feeds
// API/RT/embeds/landing surface.

import { beforeEach, describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { ulid } from 'ulidx';
import { applyMigrations, resetDb, seedUser, env } from './_setup';

// A 1x1 PNG (header is enough — serveForumImage streams bytes verbatim and
// trusts the stored content_type; it does not re-decode).
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

async function seedImage(userId: string, opts: { deleted?: boolean } = {}): Promise<{ r2Key: string }> {
  const id = ulid();
  const r2Key = `images/${userId}/${id}.png`;
  await env.FORUM_IMAGES.put(r2Key, PNG_BYTES, {
    httpMetadata: { contentType: 'image/png' },
  });
  await env.DB.prepare(
    `INSERT INTO forum_image (id, user_id, r2_key, content_type, bytes, width, height, sha256, created_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, r2Key, 'image/png', PNG_BYTES.byteLength, 1, 1, 'deadbeef', Date.now(), opts.deleted ? Date.now() : null)
    .run();
  return { r2Key };
}

describe('forum-image host (img.*) handler', () => {
  beforeEach(async () => {
    await applyMigrations();
    await resetDb();
  });

  it('serves a forum image on the img host', async () => {
    const user = await seedUser({ email: 'img1@example.com' });
    const { r2Key } = await seedImage(user.id);

    const res = await SELF.fetch(`http://img.test.local/_forum-images/${r2Key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(PNG_BYTES);
  });

  it('returns 410 for a soft-deleted image', async () => {
    const user = await seedUser({ email: 'img2@example.com' });
    const { r2Key } = await seedImage(user.id, { deleted: true });

    const res = await SELF.fetch(`http://img.test.local/_forum-images/${r2Key}`);
    expect(res.status).toBe(410);
  });

  it('404s an unknown forum-image key', async () => {
    const res = await SELF.fetch('http://img.test.local/_forum-images/images/01ABC/01DEF.png');
    expect(res.status).toBe(404);
  });

  it('404s a non-image path (no feeds API/landing surface on the img host)', async () => {
    // A bare slug would be the feeds landing page on the feeds host; on the
    // img host it must 404 (handler only matches /_forum-images/...).
    const landing = await SELF.fetch('http://img.test.local/some-slug');
    expect(landing.status).toBe(404);
    // The feeds canonical-zip path must not be reachable either.
    const zip = await SELF.fetch('http://img.test.local/some-slug/gtfs.zip');
    expect(zip.status).toBe(404);
    // Arbitrary path.
    const other = await SELF.fetch('http://img.test.local/random/nope.html');
    expect(other.status).toBe(404);
  });
});
