/**
 * Unit tests for src/components/community/permalinks.ts
 *
 * threadPath() is a pure function (no window dependency) — tested directly.
 * threadPermalink() / postPermalink() prepend window.location.origin — tested
 * with a stubbed global following the same pattern as trackBeacon.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threadPath } from '../permalinks';

// A minimal ForumThread-shaped fixture (only the fields threadPath needs).
const THREAD = {
  categoryId: 'general',
  id: '01HN8Q7GP0X3VY2JBKWZ3MHJT',
  slug: 'my-first-post',
} as const;

describe('threadPath', () => {
  it('builds the SPA path in <catId>/<id>-<slug> form', () => {
    expect(threadPath(THREAD)).toBe(
      '/community/general/01HN8Q7GP0X3VY2JBKWZ3MHJT-my-first-post',
    );
  });

  it('encodes reserved characters in categoryId', () => {
    const t = { ...THREAD, categoryId: 'bugs & features' };
    expect(threadPath(t)).toBe(
      '/community/bugs%20%26%20features/01HN8Q7GP0X3VY2JBKWZ3MHJT-my-first-post',
    );
  });

  it('leaves the slug unencoded (it is already URL-safe by construction)', () => {
    const t = { ...THREAD, slug: 'hello-world' };
    // Slug is appended after the thread id with a hyphen separator, not a slash
    expect(threadPath(t)).toContain('-hello-world');
    expect(threadPath(t)).not.toContain('%');
  });

  it('round-trips: first path segment after /community/ decodes to the categoryId', () => {
    const path = threadPath(THREAD);
    const segments = path.split('/');
    // /community/<catId>/<threadKey>
    expect(decodeURIComponent(segments[2])).toBe(THREAD.categoryId);
  });

  it('round-trips: threadKey prefix before first hyphen is the thread id (ULID, no hyphens)', () => {
    const path = threadPath(THREAD);
    const segments = path.split('/');
    const threadKey = decodeURIComponent(segments[3]);
    // ThreadView extracts the id via threadKey.split('-')[0]
    expect(threadKey.split('-')[0]).toBe(THREAD.id);
  });
});

describe('post anchor hash', () => {
  const POST_ID = '01HN8Q7GP0X3VY2JBKWZ3ABCD';

  it('hash fragment matches the PostCard article id attribute', () => {
    const hash = `#post-${POST_ID}`;
    // PostCard renders: id={`post-${post.id}`}
    // ThreadView parses: hash.match(/^#post-(.+)$/)
    const match = hash.match(/^#post-(.+)$/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(POST_ID);
  });

  it('non-post hashes are not mistaken for post anchors', () => {
    for (const h of ['', '#top', '#section-1', '#postXYZ']) {
      const match = h.match(/^#post-(.+)$/);
      expect(match).toBeNull();
    }
  });
});

describe('threadPermalink and postPermalink (window.location.origin stubbed)', () => {
  const ORIGIN = 'https://gtfsx.com';

  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('threadPermalink returns absolute URL', async () => {
    const { threadPermalink } = await import('../permalinks');
    // Need a full ForumThread shape for TS; we cast to avoid importing all fields.
    const t = THREAD as Parameters<typeof threadPermalink>[0];
    expect(threadPermalink(t)).toBe(
      `${ORIGIN}/community/general/01HN8Q7GP0X3VY2JBKWZ3MHJT-my-first-post`,
    );
  });

  it('postPermalink appends hash to the thread URL', async () => {
    const { postPermalink } = await import('../permalinks');
    const t = THREAD as Parameters<typeof postPermalink>[0];
    const postId = '01HN8Q7GP0X3VY2JBKWZ3ABCD';
    expect(postPermalink(t, postId)).toBe(
      `${ORIGIN}/community/general/01HN8Q7GP0X3VY2JBKWZ3MHJT-my-first-post#post-${postId}`,
    );
  });

  it('postPermalink hash matches the anchor parsed by ThreadView', async () => {
    const { postPermalink } = await import('../permalinks');
    const t = THREAD as Parameters<typeof postPermalink>[0];
    const postId = '01HN8Q7GP0X3VY2JBKWZ3ABCD';
    const url = postPermalink(t, postId);
    const hash = url.split('#')[1] ? `#${url.split('#')[1]}` : '';
    const match = hash.match(/^#post-(.+)$/);
    expect(match![1]).toBe(postId);
  });
});
