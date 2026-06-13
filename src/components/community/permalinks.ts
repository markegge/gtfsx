/**
 * Forum permalink utilities.
 *
 * Thread IDs are ULIDs (26-char base32, no hyphens) so the `<id>-<slug>`
 * separator is unambiguous. The helpers here mirror the link format used in
 * ThreadList/ThreadRow and the :catId/:threadKey route in App.tsx.
 *
 * Non-component exports live in this .ts module (not a .tsx file) so the
 * react-refresh/only-export-components rule stays satisfied.
 */

import type { ForumThread } from '../../services/forumApi';

/**
 * Returns the SPA-internal path for a thread.
 * Example: /community/general/01HN8Q7GP0X3VY2JBKWZ3MHJT-my-post-title
 */
export function threadPath(thread: Pick<ForumThread, 'categoryId' | 'id' | 'slug'>): string {
  return `/community/${encodeURIComponent(thread.categoryId)}/${encodeURIComponent(thread.id)}-${thread.slug}`;
}

/**
 * Returns the absolute permalink for a thread.
 * Uses window.location.origin so it resolves correctly on prod and staging.
 */
export function threadPermalink(thread: ForumThread): string {
  return `${window.location.origin}${threadPath(thread)}`;
}

/**
 * Returns the absolute permalink for a specific post within a thread.
 * The hash "#post-<postId>" matches the `id` attribute set by PostCard on its
 * article element, so the browser scrolls directly to that post.
 */
export function postPermalink(thread: ForumThread, postId: string): string {
  return `${threadPermalink(thread)}#post-${postId}`;
}
