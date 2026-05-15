import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulidx';
import type { AppContext } from '../env';
import { requireAuth } from '../auth/middleware';
import { forbidden, notFound, rateLimited, validationFailed, ApiError } from '../util/errors';
import { logAudit } from '../util/audit';
import { clientIp } from '../util/rateLimit';
import {
  canWriteToForum,
  loadForumProfile,
  slugify,
  userAuthorDto,
} from './util';
import {
  notifyAdminsNewThread,
  notifyAuthorMarkedSolved,
  notifySubscribersOfReply,
  notifyThreadAuthorOfReply,
} from './notify';
import { uploadsRouter } from './uploads';
import type {
  AuthorDto,
  CategoryDto,
  CategoryRow,
  PostDto,
  PostRow,
  ThreadDto,
  ThreadRow,
} from './types';

export const forumRouter = new Hono<AppContext>();

// Image uploads (multipart) mounted under /api/forum/uploads/*.
forumRouter.route('/uploads', uploadsRouter);

// ─── Schemas ────────────────────────────────────────────────────────────────

const displayNameSchema = z.string().trim().min(2).max(40);
const titleSchema = z.string().trim().min(8).max(200);
const bodySchema = z.string().trim().min(2).max(64000);
const categoryIdSchema = z.string().regex(/^[a-z0-9-]+$/).min(1).max(60);

const createThreadSchema = z.object({
  categoryId: categoryIdSchema,
  title: titleSchema,
  bodyMd: bodySchema,
});

const replyToThreadSchema = z.object({
  bodyMd: bodySchema,
});

const editPostSchema = z.object({
  bodyMd: bodySchema,
});

const patchThreadSchema = z.object({
  pinned: z.boolean().optional(),     // admin only
  locked: z.boolean().optional(),     // admin only
  solvedPostId: z.string().nullable().optional(), // author or admin
  categoryId: categoryIdSchema.optional(), // admin only (move)
});

const patchProfileSchema = z.object({
  displayName: displayNameSchema.optional(),
  gravatarOptOut: z.boolean().optional(),
  emailPrefs: z.object({
    replies: z.boolean().optional(),
    subscribed: z.boolean().optional(),
    markSolved: z.boolean().optional(),
    adminAlerts: z.boolean().optional(),
    allOff: z.boolean().optional(),
  }).optional(),
});

async function parseJson<T extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: T): Promise<z.infer<T>> {
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function threadDto(row: ThreadRow, author: AuthorDto): ThreadDto {
  return {
    id: row.id,
    categoryId: row.category_id,
    slug: row.slug,
    title: row.title,
    author,
    createdAt: row.created_at,
    lastPostAt: row.last_post_at,
    postCount: row.post_count,
    viewCount: row.view_count,
    pinned: row.pinned === 1,
    locked: row.locked === 1,
    solvedPostId: row.solved_post_id,
  };
}

function postDto(
  row: PostRow,
  author: AuthorDto,
  upvotedByMe: boolean,
  isSolved: boolean,
): PostDto {
  return {
    id: row.id,
    threadId: row.thread_id,
    author,
    bodyMd: row.deleted_at ? '' : row.body_md,
    upvoteCount: row.upvote_count,
    upvotedByMe,
    isSolved,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}

function categoryDto(row: CategoryRow): CategoryDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    sortOrder: row.sort_order,
    locked: row.locked === 1,
  };
}

async function getThreadOr404(env: AppContext['Bindings'], id: string): Promise<ThreadRow> {
  const row = await env.DB.prepare(
    `SELECT * FROM forum_thread WHERE id = ? AND deleted_at IS NULL`,
  ).bind(id).first<ThreadRow>();
  if (!row) throw notFound('Thread not found');
  return row;
}

async function getPostOr404(env: AppContext['Bindings'], id: string): Promise<PostRow> {
  const row = await env.DB.prepare(
    `SELECT * FROM forum_post WHERE id = ?`,
  ).bind(id).first<PostRow>();
  if (!row || row.deleted_at) throw notFound('Post not found');
  return row;
}

async function checkWriteGate(env: AppContext['Bindings'], userId: string): Promise<void> {
  const gate = await canWriteToForum(env, userId);
  if (!gate.ok) {
    throw new ApiError(422, 'validation_failed', gate.reason === 'banned' ? 'Your forum access is suspended' : 'Set a display name before posting', {
      reason: gate.reason,
    });
  }
}

// Naive per-user rate limit via KV counters. Two windows: 10-min and 24-hour.
async function checkPostRateLimit(env: AppContext['Bindings'], userId: string, kind: 'thread' | 'post'): Promise<void> {
  const now = Date.now();
  const shortKey = `forum:rate:${kind}:short:${userId}`;
  const dayKey = `forum:rate:${kind}:day:${userId}`;
  const shortLimit = kind === 'thread' ? 3 : 5;     // 10 min
  const dayLimit = kind === 'thread' ? 20 : 50;     // 24 h

  const short = parseInt((await env.KV.get(shortKey)) ?? '0', 10);
  const day = parseInt((await env.KV.get(dayKey)) ?? '0', 10);
  if (short >= shortLimit || day >= dayLimit) {
    throw rateLimited(`You're posting too quickly — try again in a few minutes.`);
  }
  await env.KV.put(shortKey, String(short + 1), { expirationTtl: 600 });
  await env.KV.put(dayKey, String(day + 1), { expirationTtl: 86400 });
  void now; // silence "unused"
}

// ─── Categories ─────────────────────────────────────────────────────────────

forumRouter.get('/categories', async (c) => {
  const cats = await c.env.DB.prepare(
    `SELECT * FROM forum_category ORDER BY sort_order ASC, title ASC`,
  ).all<CategoryRow>();

  // Augment with thread count + most recent activity, in one extra query.
  const counts = await c.env.DB.prepare(
    `SELECT category_id, COUNT(*) as n, MAX(last_post_at) as latest
       FROM forum_thread WHERE deleted_at IS NULL GROUP BY category_id`,
  ).all<{ category_id: string; n: number; latest: number }>();
  const countMap = new Map<string, { n: number; latest: number }>();
  for (const r of counts.results ?? []) countMap.set(r.category_id, { n: r.n, latest: r.latest });

  return c.json({
    categories: (cats.results ?? []).map((row) => {
      const dto = categoryDto(row);
      const stat = countMap.get(row.id);
      return { ...dto, threadCount: stat?.n ?? 0, latestActivityAt: stat?.latest ?? null };
    }),
  });
});

// ─── Threads ────────────────────────────────────────────────────────────────

// GET /threads — list. ?category=<id>&sort=<active|new|unanswered>&limit=&cursor=<ulid>
forumRouter.get('/threads', async (c) => {
  const category = c.req.query('category');
  const sort = c.req.query('sort') ?? 'active';
  const limit = Math.min(parseInt(c.req.query('limit') ?? '30', 10) || 30, 100);
  const cursor = c.req.query('cursor');

  const where: string[] = ['t.deleted_at IS NULL'];
  const binds: unknown[] = [];

  if (category) {
    where.push('t.category_id = ?');
    binds.push(category);
  }
  if (sort === 'unanswered') {
    where.push('t.post_count <= 1 AND t.solved_post_id IS NULL');
  }
  if (cursor) {
    // Cursor is opaque: "<ts>_<id>" matching the sort key
    where.push('(t.last_post_at < ? OR (t.last_post_at = ? AND t.id < ?))');
    const [tsStr, idStr] = cursor.split('_');
    const ts = parseInt(tsStr ?? '0', 10) || 0;
    binds.push(ts, ts, idStr ?? '');
  }

  const orderBy = sort === 'new'
    ? 't.pinned DESC, t.created_at DESC, t.id DESC'
    : 't.pinned DESC, t.last_post_at DESC, t.id DESC';

  const stmt = `SELECT t.* FROM forum_thread t WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`;
  binds.push(limit + 1);

  const res = await c.env.DB.prepare(stmt).bind(...binds).all<ThreadRow>();
  const rows = res.results ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const authors = await Promise.all(page.map((r) => userAuthorDto(c.env, r.author_user_id)));
  const threads = page.map((r, i) => threadDto(r, authors[i]));
  const nextCursor = hasMore && page.length > 0
    ? `${page[page.length - 1].last_post_at}_${page[page.length - 1].id}`
    : null;
  return c.json({ threads, nextCursor });
});

// GET /threads/:id — full thread + posts. Bumps view_count best-effort.
forumRouter.get('/threads/:id', async (c) => {
  const id = c.req.param('id');
  const thread = await getThreadOr404(c.env, id);

  // Posts (in chronological order).
  const postsRes = await c.env.DB.prepare(
    `SELECT * FROM forum_post WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
  ).bind(id).all<PostRow>();
  const posts = postsRes.results ?? [];

  // Upvote map — which post_ids the current user has upvoted.
  const me = c.var.user;
  let upvotedSet = new Set<string>();
  if (me && posts.length > 0) {
    const inClause = posts.map(() => '?').join(',');
    const ups = await c.env.DB.prepare(
      `SELECT post_id FROM forum_post_upvote WHERE user_id = ? AND post_id IN (${inClause})`,
    ).bind(me.id, ...posts.map((p) => p.id)).all<{ post_id: string }>();
    upvotedSet = new Set((ups.results ?? []).map((r) => r.post_id));
  }

  const authorIds = Array.from(new Set([thread.author_user_id, ...posts.map((p) => p.author_user_id)]));
  const authorMap = new Map<string, AuthorDto>();
  await Promise.all(authorIds.map(async (uid) => {
    authorMap.set(uid, await userAuthorDto(c.env, uid));
  }));

  // Fire-and-forget view increment. Don't count the author's own views.
  if (!me || me.id !== thread.author_user_id) {
    c.executionCtx.waitUntil(
      c.env.DB.prepare(`UPDATE forum_thread SET view_count = view_count + 1 WHERE id = ?`).bind(id).run(),
    );
  }

  return c.json({
    thread: threadDto(thread, authorMap.get(thread.author_user_id)!),
    posts: posts.map((p) =>
      postDto(p, authorMap.get(p.author_user_id)!, upvotedSet.has(p.id), p.id === thread.solved_post_id),
    ),
  });
});

// POST /threads — create.
forumRouter.post('/threads', requireAuth, async (c) => {
  const user = c.var.user!;
  await checkWriteGate(c.env, user.id);

  const body = await parseJson(c, createThreadSchema);

  // Verify category exists + is not locked for non-admins.
  const cat = await c.env.DB.prepare(`SELECT * FROM forum_category WHERE id = ?`).bind(body.categoryId).first<CategoryRow>();
  if (!cat) throw notFound('Category not found');
  if (cat.locked === 1 && !user.staff) {
    throw forbidden('Only admins can post in this category');
  }

  await checkPostRateLimit(c.env, user.id, 'thread');

  const now = Date.now();
  const threadId = ulid();
  const opPostId = ulid();
  const slug = slugify(body.title);

  // Two inserts + author subscription, all in one batch (D1 supports batch).
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO forum_thread (id, category_id, slug, title, author_user_id, created_at, last_post_at, post_count, view_count, pinned, locked, solved_post_id, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, NULL, NULL)`,
    ).bind(threadId, body.categoryId, slug, body.title, user.id, now, now),
    c.env.DB.prepare(
      `INSERT INTO forum_post (id, thread_id, author_user_id, body_md, upvote_count, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, NULL)`,
    ).bind(opPostId, threadId, user.id, body.bodyMd, now),
    c.env.DB.prepare(
      `INSERT INTO forum_subscription (user_id, thread_id, source, created_at) VALUES (?, ?, 'author', ?)
       ON CONFLICT(user_id, thread_id) DO NOTHING`,
    ).bind(user.id, threadId, now),
  ]);

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_thread',
    subjectId: threadId,
    action: 'forum.thread.create',
    metadata: { categoryId: body.categoryId, title: body.title },
    ip: clientIp(c.req.raw),
  });

  // Build a row shape for the notifier (saves another SELECT).
  const threadRow: ThreadRow = {
    id: threadId,
    category_id: body.categoryId,
    slug,
    title: body.title,
    author_user_id: user.id,
    created_at: now,
    last_post_at: now,
    post_count: 1,
    view_count: 0,
    pinned: 0,
    locked: 0,
    solved_post_id: null,
    deleted_at: null,
  };

  const author = await userAuthorDto(c.env, user.id);
  // Fire-and-forget admin notification.
  c.executionCtx.waitUntil(notifyAdminsNewThread(c.env, threadRow, author.displayName, body.bodyMd));

  return c.json({ thread: threadDto(threadRow, author) }, 201);
});

// PATCH /threads/:id — pin/lock/move (admin) or mark-solved/unmark (author or admin) or soft-delete.
forumRouter.patch('/threads/:id', requireAuth, async (c) => {
  const user = c.var.user!;
  const thread = await getThreadOr404(c.env, c.req.param('id'));
  const body = await parseJson(c, patchThreadSchema);

  const isAdmin = user.staff;
  const isAuthor = user.id === thread.author_user_id;

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.pinned !== undefined) {
    if (!isAdmin) throw forbidden('Only admins can pin threads');
    updates.push('pinned = ?'); binds.push(body.pinned ? 1 : 0);
  }
  if (body.locked !== undefined) {
    if (!isAdmin) throw forbidden('Only admins can lock threads');
    updates.push('locked = ?'); binds.push(body.locked ? 1 : 0);
  }
  if (body.categoryId !== undefined) {
    if (!isAdmin) throw forbidden('Only admins can move threads');
    const cat = await c.env.DB.prepare(`SELECT id FROM forum_category WHERE id = ?`).bind(body.categoryId).first();
    if (!cat) throw notFound('Category not found');
    updates.push('category_id = ?'); binds.push(body.categoryId);
  }
  if (body.solvedPostId !== undefined) {
    if (!isAdmin && !isAuthor) throw forbidden('Only the thread author or an admin can mark answers');
    if (body.solvedPostId !== null) {
      const post = await c.env.DB.prepare(`SELECT id, thread_id, author_user_id, body_md FROM forum_post WHERE id = ? AND deleted_at IS NULL`).bind(body.solvedPostId).first<{ id: string; thread_id: string; author_user_id: string; body_md: string }>();
      if (!post || post.thread_id !== thread.id) throw notFound('Post not found in this thread');
      updates.push('solved_post_id = ?'); binds.push(body.solvedPostId);
      // Notify the answer's author (best-effort).
      c.executionCtx.waitUntil(notifyAuthorMarkedSolved(c.env, thread, { id: post.id, thread_id: post.thread_id, author_user_id: post.author_user_id, body_md: post.body_md, upvote_count: 0, created_at: 0, edited_at: null, deleted_at: null }));
    } else {
      updates.push('solved_post_id = NULL');
    }
  }

  if (updates.length === 0) return c.json({ thread: threadDto(thread, await userAuthorDto(c.env, thread.author_user_id)) });

  binds.push(thread.id);
  await c.env.DB.prepare(`UPDATE forum_thread SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_thread',
    subjectId: thread.id,
    action: 'forum.thread.patch',
    metadata: body,
    ip: clientIp(c.req.raw),
  });

  const fresh = await getThreadOr404(c.env, thread.id);
  return c.json({ thread: threadDto(fresh, await userAuthorDto(c.env, fresh.author_user_id)) });
});

forumRouter.delete('/threads/:id', requireAuth, async (c) => {
  const user = c.var.user!;
  const thread = await getThreadOr404(c.env, c.req.param('id'));
  if (!user.staff && user.id !== thread.author_user_id) {
    throw forbidden('Only the author or an admin can delete this thread');
  }
  await c.env.DB.prepare(`UPDATE forum_thread SET deleted_at = ? WHERE id = ?`).bind(Date.now(), thread.id).run();
  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_thread',
    subjectId: thread.id,
    action: 'forum.thread.delete',
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// ─── Posts ──────────────────────────────────────────────────────────────────

// POST /threads/:id/posts — reply.
forumRouter.post('/threads/:id/posts', requireAuth, async (c) => {
  const user = c.var.user!;
  await checkWriteGate(c.env, user.id);

  const thread = await getThreadOr404(c.env, c.req.param('id'));
  if (thread.locked === 1 && !user.staff) {
    throw forbidden('This thread is locked');
  }

  const body = await parseJson(c, replyToThreadSchema);
  await checkPostRateLimit(c.env, user.id, 'post');

  const now = Date.now();
  const postId = ulid();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO forum_post (id, thread_id, author_user_id, body_md, upvote_count, created_at, edited_at, deleted_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, NULL)`,
    ).bind(postId, thread.id, user.id, body.bodyMd, now),
    c.env.DB.prepare(
      `UPDATE forum_thread SET post_count = post_count + 1, last_post_at = ? WHERE id = ?`,
    ).bind(now, thread.id),
    c.env.DB.prepare(
      `INSERT INTO forum_subscription (user_id, thread_id, source, created_at) VALUES (?, ?, 'reply', ?)
       ON CONFLICT(user_id, thread_id) DO NOTHING`,
    ).bind(user.id, thread.id, now),
  ]);

  const postRow: PostRow = {
    id: postId,
    thread_id: thread.id,
    author_user_id: user.id,
    body_md: body.bodyMd,
    upvote_count: 0,
    created_at: now,
    edited_at: null,
    deleted_at: null,
  };

  const author = await userAuthorDto(c.env, user.id);
  // Notifications (fire-and-forget).
  c.executionCtx.waitUntil(notifyThreadAuthorOfReply(c.env, thread, postRow, author.displayName));
  c.executionCtx.waitUntil(notifySubscribersOfReply(c.env, thread, postRow, author.displayName));

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_post',
    subjectId: postId,
    action: 'forum.post.create',
    metadata: { threadId: thread.id },
    ip: clientIp(c.req.raw),
  });

  return c.json({
    post: postDto(postRow, author, false, false),
  }, 201);
});

// PATCH /posts/:id — edit body.
forumRouter.patch('/posts/:id', requireAuth, async (c) => {
  const user = c.var.user!;
  const post = await getPostOr404(c.env, c.req.param('id'));

  const isAuthor = post.author_user_id === user.id;
  const isAdmin = user.staff;
  if (!isAuthor && !isAdmin) throw forbidden('Only the author or an admin can edit this post');

  // Non-admin authors can only edit within 30 min of creation.
  if (isAuthor && !isAdmin && Date.now() - post.created_at > 30 * 60 * 1000) {
    throw forbidden('Edits are closed for this post (30-minute window passed)');
  }

  const body = await parseJson(c, editPostSchema);
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE forum_post SET body_md = ?, edited_at = ? WHERE id = ?`,
  ).bind(body.bodyMd, now, post.id).run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_post',
    subjectId: post.id,
    action: 'forum.post.edit',
    metadata: { byAdmin: isAdmin && !isAuthor },
    ip: clientIp(c.req.raw),
  });

  const fresh = await getPostOr404(c.env, post.id);
  const upvoted = await c.env.DB.prepare(`SELECT 1 FROM forum_post_upvote WHERE post_id = ? AND user_id = ?`).bind(post.id, user.id).first();
  const thread = await c.env.DB.prepare(`SELECT solved_post_id FROM forum_thread WHERE id = ?`).bind(post.thread_id).first<{ solved_post_id: string | null }>();
  return c.json({ post: postDto(fresh, await userAuthorDto(c.env, fresh.author_user_id), !!upvoted, thread?.solved_post_id === post.id) });
});

forumRouter.delete('/posts/:id', requireAuth, async (c) => {
  const user = c.var.user!;
  const post = await getPostOr404(c.env, c.req.param('id'));
  if (!user.staff && user.id !== post.author_user_id) {
    throw forbidden('Only the author or an admin can delete this post');
  }
  // Don't allow the OP post to be deleted directly — author should delete the
  // thread instead. (Identify the OP as the earliest post in the thread.)
  const firstPost = await c.env.DB.prepare(
    `SELECT id FROM forum_post WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`,
  ).bind(post.thread_id).first<{ id: string }>();
  if (firstPost?.id === post.id) {
    throw validationFailed('Delete the thread instead of the original post');
  }

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE forum_post SET deleted_at = ? WHERE id = ?`).bind(now, post.id).run();
  // If this was the accepted answer, clear it.
  await c.env.DB.prepare(
    `UPDATE forum_thread SET solved_post_id = NULL WHERE id = ? AND solved_post_id = ?`,
  ).bind(post.thread_id, post.id).run();

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'forum_post',
    subjectId: post.id,
    action: 'forum.post.delete',
    ip: clientIp(c.req.raw),
  });
  return c.body(null, 204);
});

// POST /posts/:id/upvote — toggle.
forumRouter.post('/posts/:id/upvote', requireAuth, async (c) => {
  const user = c.var.user!;
  await checkWriteGate(c.env, user.id);

  const post = await getPostOr404(c.env, c.req.param('id'));
  if (post.author_user_id === user.id) {
    throw forbidden(`Can't upvote your own post`);
  }

  const existing = await c.env.DB.prepare(
    `SELECT 1 FROM forum_post_upvote WHERE post_id = ? AND user_id = ?`,
  ).bind(post.id, user.id).first();

  if (existing) {
    await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM forum_post_upvote WHERE post_id = ? AND user_id = ?`).bind(post.id, user.id),
      c.env.DB.prepare(`UPDATE forum_post SET upvote_count = MAX(0, upvote_count - 1) WHERE id = ?`).bind(post.id),
    ]);
    return c.json({ upvotedByMe: false, upvoteCount: Math.max(0, post.upvote_count - 1) });
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO forum_post_upvote (post_id, user_id, created_at) VALUES (?, ?, ?)`).bind(post.id, user.id, Date.now()),
      c.env.DB.prepare(`UPDATE forum_post SET upvote_count = upvote_count + 1 WHERE id = ?`).bind(post.id),
    ]);
    return c.json({ upvotedByMe: true, upvoteCount: post.upvote_count + 1 });
  }
});

// ─── Profile ────────────────────────────────────────────────────────────────

forumRouter.get('/profile/me', requireAuth, async (c) => {
  const user = c.var.user!;
  const profile = await loadForumProfile(c.env, user.id, user.staff);
  return c.json({ profile });
});

forumRouter.patch('/profile/me', requireAuth, async (c) => {
  const user = c.var.user!;
  const body = await parseJson(c, patchProfileSchema);
  const now = Date.now();

  // Ensure a row exists.
  await c.env.DB.prepare(
    `INSERT INTO forum_user_state (user_id, gravatar_opt_out, email_pref_replies, email_pref_subscribed, email_pref_mark_solved, email_pref_admin_alerts, email_pref_all_off, created_at, updated_at)
     VALUES (?, 0, 1, 1, 1, 1, 0, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).bind(user.id, now, now).run();

  const sets: string[] = ['updated_at = ?'];
  const binds: unknown[] = [now];

  if (body.displayName !== undefined) {
    // Soft uniqueness check — disallow exact duplicates so users don't impersonate.
    const collision = await c.env.DB.prepare(
      `SELECT user_id FROM forum_user_state WHERE forum_display_name = ? AND user_id != ?`,
    ).bind(body.displayName, user.id).first();
    if (collision) throw validationFailed('That display name is taken — try another');
    sets.push('forum_display_name = ?'); binds.push(body.displayName);
  }
  if (body.gravatarOptOut !== undefined) {
    sets.push('gravatar_opt_out = ?'); binds.push(body.gravatarOptOut ? 1 : 0);
  }
  if (body.emailPrefs) {
    const p = body.emailPrefs;
    if (p.replies !== undefined) { sets.push('email_pref_replies = ?'); binds.push(p.replies ? 1 : 0); }
    if (p.subscribed !== undefined) { sets.push('email_pref_subscribed = ?'); binds.push(p.subscribed ? 1 : 0); }
    if (p.markSolved !== undefined) { sets.push('email_pref_mark_solved = ?'); binds.push(p.markSolved ? 1 : 0); }
    if (p.adminAlerts !== undefined) { sets.push('email_pref_admin_alerts = ?'); binds.push(p.adminAlerts ? 1 : 0); }
    if (p.allOff !== undefined) { sets.push('email_pref_all_off = ?'); binds.push(p.allOff ? 1 : 0); }
  }

  if (sets.length > 1) {
    binds.push(user.id);
    await c.env.DB.prepare(`UPDATE forum_user_state SET ${sets.join(', ')} WHERE user_id = ?`).bind(...binds).run();
  }

  await logAudit(c.env, {
    actorUserId: user.id,
    subjectType: 'user',
    subjectId: user.id,
    action: 'forum.profile.update',
    metadata: { displayName: body.displayName !== undefined, prefs: !!body.emailPrefs },
    ip: clientIp(c.req.raw),
  });

  const profile = await loadForumProfile(c.env, user.id, user.staff);
  return c.json({ profile });
});

forumRouter.get('/profile/:userId', async (c) => {
  const userId = c.req.param('userId');
  const author = await userAuthorDto(c.env, userId);

  // Recent threads + posts authored.
  const threadsRes = await c.env.DB.prepare(
    `SELECT * FROM forum_thread WHERE author_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`,
  ).bind(userId).all<ThreadRow>();
  const postsRes = await c.env.DB.prepare(
    `SELECT p.*, t.title as thread_title, t.slug as thread_slug, t.category_id as category_id
       FROM forum_post p
       JOIN forum_thread t ON t.id = p.thread_id
      WHERE p.author_user_id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL
      ORDER BY p.created_at DESC LIMIT 20`,
  ).bind(userId).all<PostRow & { thread_title: string; thread_slug: string; category_id: string }>();

  const totalUpvotesRes = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(upvote_count), 0) as total FROM forum_post WHERE author_user_id = ? AND deleted_at IS NULL`,
  ).bind(userId).first<{ total: number }>();

  return c.json({
    user: author,
    totalUpvotes: totalUpvotesRes?.total ?? 0,
    threads: (threadsRes.results ?? []).map((r) => threadDto(r, author)),
    posts: (postsRes.results ?? []).map((r) => ({
      id: r.id,
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      threadSlug: r.thread_slug,
      categoryId: r.category_id,
      bodyMd: r.body_md,
      upvoteCount: r.upvote_count,
      createdAt: r.created_at,
    })),
  });
});

// ─── Subscriptions ──────────────────────────────────────────────────────────

forumRouter.post('/threads/:id/subscribe', requireAuth, async (c) => {
  const user = c.var.user!;
  const thread = await getThreadOr404(c.env, c.req.param('id'));
  await c.env.DB.prepare(
    `INSERT INTO forum_subscription (user_id, thread_id, source, created_at) VALUES (?, ?, 'manual', ?)
     ON CONFLICT(user_id, thread_id) DO NOTHING`,
  ).bind(user.id, thread.id, Date.now()).run();
  return c.json({ subscribed: true });
});

forumRouter.delete('/threads/:id/subscribe', requireAuth, async (c) => {
  const user = c.var.user!;
  await c.env.DB.prepare(
    `DELETE FROM forum_subscription WHERE user_id = ? AND thread_id = ?`,
  ).bind(user.id, c.req.param('id')).run();
  return c.json({ subscribed: false });
});

forumRouter.get('/threads/:id/subscription', requireAuth, async (c) => {
  const user = c.var.user!;
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM forum_subscription WHERE user_id = ? AND thread_id = ?`,
  ).bind(user.id, c.req.param('id')).first();
  return c.json({ subscribed: !!row });
});
