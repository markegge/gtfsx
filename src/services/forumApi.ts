import { ApiError, type ApiErrorCode } from './authApi';

const BASE_HEADERS = { 'X-GB-Client': 'web' };

async function parseErrorResponse(res: Response): Promise<ApiError> {
  let code: ApiErrorCode = 'unknown';
  let message = res.statusText || 'Request failed';
  let extra: Record<string, unknown> = {};
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      const data = await res.json();
      if (data && typeof data === 'object') {
        if (typeof data.error === 'string') code = data.error as ApiErrorCode;
        if (typeof data.message === 'string') message = data.message;
        extra = data as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return new ApiError(code, message, res.status, extra);
}

async function requestJson<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'GET', body } = init;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  }
  if (!res.ok) throw await parseErrorResponse(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return undefined as T;
}

// ─── Types (mirror worker/forum/types.ts but in client form) ────────────────

export interface ForumAuthor {
  id: string;
  displayName: string;
  gravatarHash: string | null;
}

export interface ForumCategory {
  id: string;
  title: string;
  description: string;
  sortOrder: number;
  locked: boolean;
  threadCount?: number;
  latestActivityAt?: number | null;
}

export interface ForumThread {
  id: string;
  categoryId: string;
  slug: string;
  title: string;
  author: ForumAuthor;
  createdAt: number;
  lastPostAt: number;
  postCount: number;
  viewCount: number;
  pinned: boolean;
  locked: boolean;
  solvedPostId: string | null;
  /** Plaintext preview of the OP body. Set by the threads-list endpoint;
   *  empty/undefined elsewhere. */
  opExcerpt?: string;
}

export interface ForumPost {
  id: string;
  threadId: string;
  author: ForumAuthor;
  bodyMd: string;
  upvoteCount: number;
  upvotedByMe: boolean;
  isSolved: boolean;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

export interface ForumProfile {
  userId: string;
  displayName: string | null;
  gravatarHash: string | null;
  gravatarOptOut: boolean;
  emailPrefs: {
    replies: boolean;
    subscribed: boolean;
    markSolved: boolean;
    adminAlerts: boolean;
    allOff: boolean;
  };
  isStaff: boolean;
  needsDisplayName: boolean;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

export function listCategories(): Promise<{ categories: ForumCategory[] }> {
  return requestJson(`/api/forum/categories`);
}

export function listThreads(opts: {
  category?: string;
  sort?: 'active' | 'new' | 'unanswered';
  limit?: number;
  cursor?: string;
}): Promise<{ threads: ForumThread[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.category) params.set('category', opts.category);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  const q = params.toString();
  return requestJson(`/api/forum/threads${q ? `?${q}` : ''}`);
}

export function getThread(id: string): Promise<{ thread: ForumThread; posts: ForumPost[] }> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(id)}`);
}

export function createThread(input: {
  categoryId: string;
  title: string;
  bodyMd: string;
}): Promise<{ thread: ForumThread }> {
  return requestJson(`/api/forum/threads`, { method: 'POST', body: input });
}

export function patchThread(
  id: string,
  input: { pinned?: boolean; locked?: boolean; solvedPostId?: string | null; categoryId?: string },
): Promise<{ thread: ForumThread }> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
}

export function deleteThread(id: string): Promise<void> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function replyToThread(threadId: string, bodyMd: string): Promise<{ post: ForumPost }> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(threadId)}/posts`, {
    method: 'POST',
    body: { bodyMd },
  });
}

export function editPost(postId: string, bodyMd: string): Promise<{ post: ForumPost }> {
  return requestJson(`/api/forum/posts/${encodeURIComponent(postId)}`, { method: 'PATCH', body: { bodyMd } });
}

export function deletePost(postId: string): Promise<void> {
  return requestJson(`/api/forum/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' });
}

export function toggleUpvote(postId: string): Promise<{ upvotedByMe: boolean; upvoteCount: number }> {
  return requestJson(`/api/forum/posts/${encodeURIComponent(postId)}/upvote`, { method: 'POST' });
}

export function getMyForumProfile(): Promise<{ profile: ForumProfile }> {
  return requestJson(`/api/forum/profile/me`);
}

export function patchMyForumProfile(input: {
  displayName?: string;
  gravatarOptOut?: boolean;
  emailPrefs?: {
    replies?: boolean;
    subscribed?: boolean;
    markSolved?: boolean;
    adminAlerts?: boolean;
    allOff?: boolean;
  };
}): Promise<{ profile: ForumProfile }> {
  return requestJson(`/api/forum/profile/me`, { method: 'PATCH', body: input });
}

export interface PublicProfile {
  user: ForumAuthor;
  // Present only for staff viewers: the target's forum-ban expiry (ms epoch),
  // null if not banned. Undefined for non-staff.
  bannedUntil?: number | null;
  totalUpvotes: number;
  threads: ForumThread[];
  posts: Array<{
    id: string;
    threadId: string;
    threadTitle: string;
    threadSlug: string;
    categoryId: string;
    bodyMd: string;
    upvoteCount: number;
    createdAt: number;
  }>;
}

export function getPublicProfile(userId: string): Promise<PublicProfile> {
  return requestJson(`/api/forum/profile/${encodeURIComponent(userId)}`);
}

// Staff-only forum moderation: ban (indefinite by default, or `days` for a
// timed ban) and lift a ban. Returns the new bannedUntil (ms epoch, or null).
export function banForumUser(userId: string, days?: number): Promise<{ bannedUntil: number | null }> {
  return requestJson(`/api/forum/profile/${encodeURIComponent(userId)}/ban`, {
    method: 'POST',
    body: days ? { days } : {},
  });
}

export function unbanForumUser(userId: string): Promise<{ bannedUntil: number | null }> {
  return requestJson(`/api/forum/profile/${encodeURIComponent(userId)}/ban`, { method: 'DELETE' });
}

export function subscribeToThread(threadId: string): Promise<{ subscribed: boolean }> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(threadId)}/subscribe`, { method: 'POST' });
}

export function unsubscribeFromThread(threadId: string): Promise<{ subscribed: boolean }> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(threadId)}/subscribe`, { method: 'DELETE' });
}

export function getMySubscription(threadId: string): Promise<{ subscribed: boolean }> {
  return requestJson(`/api/forum/threads/${encodeURIComponent(threadId)}/subscription`);
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface ForumSearchHit {
  thread: ForumThread;
  // FTS5 snippet — already contains <mark>…</mark> around matched terms,
  // safe to render with dangerouslySetInnerHTML since the worker generates
  // it via SQLite's snippet() (no user-controlled HTML survives).
  snippet: string;
}

export function searchForum(q: string, cursor?: string): Promise<{
  results: ForumSearchHit[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams({ q });
  if (cursor) params.set('cursor', cursor);
  return requestJson(`/api/forum/search?${params.toString()}`);
}

// ─── Image upload ───────────────────────────────────────────────────────────

export interface UploadedImage {
  id: string;
  url: string;
  contentType: string;
  width?: number;
  height?: number;
  deduped?: boolean;
}

export async function uploadForumImage(file: File): Promise<UploadedImage> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/forum/uploads/image', {
    method: 'POST',
    headers: { ...BASE_HEADERS },
    credentials: 'include',
    body: form,
  }).catch((e) => {
    throw new ApiError('network_error', (e as Error)?.message ?? 'Network error', 0);
  });
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as UploadedImage;
}
