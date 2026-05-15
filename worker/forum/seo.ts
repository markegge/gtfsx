// Server-side rendering of the forum pages for search engines + no-JS readers.
//
// What this does and why:
//   The forum lives inside the React SPA at /community/*. Google's crawler does
//   not reliably execute JS for newly-discovered content, so without help it
//   would see only the empty <div id="root"></div> shell and never index a
//   thread. This module renders a static, semantic HTML snapshot of each
//   forum page (categories, thread list, thread detail, profile) into the
//   index.html shell before the SPA mounts. The crawler indexes the snapshot;
//   real users get the snapshot first, then React hydrates over it (the SPA
//   replaces #root's contents — no React hydration mismatch because the snapshot
//   lives in a sibling element that the SPA removes on mount).
//
// Architecture:
//   worker/index.ts intercepts /community/* paths on the canonical/staging
//   host and routes through `renderForumPage()`. It fetches `dist/index.html`
//   from ASSETS, rewrites the head (title, description, canonical, OG, JSON-LD)
//   to match the page, and injects the rendered semantic HTML.
//
// Caching:
//   Each rendered page is keyed by URL + content state (D1 read). We set
//   Cache-Control: public, max-age=60, s-maxage=300 so Cloudflare's edge can
//   serve repeats without hitting D1 every time. A future webhook (or D1
//   change) could explicitly purge by tag if cache staleness becomes a problem.

import type { Env } from '../env';
import { renderMarkdownToHtml, markdownToPlainText, escapeHtml } from './markdown';
import { userAuthorDto, slugify } from './util';
import type {
  AuthorDto,
  CategoryRow,
  PostRow,
  ThreadRow,
} from './types';

const APP_NAME = 'GTFS Studio Community';

export interface ForumSeo {
  title: string;
  description: string;
  canonicalUrl: string;
  body: string;       // HTML to inject into the page body (visible)
  jsonLd: string | null;  // JSON-LD script content (null for index/category)
  noindex: boolean;   // true for paginated / private-ish pages
}

function imageOriginHost(env: Env): string | null {
  try {
    return env.FEEDS_ORIGIN ? new URL(env.FEEDS_ORIGIN).hostname : null;
  } catch {
    return null;
  }
}

function appOrigin(env: Env): string {
  return env.APP_ORIGIN || 'https://www.gtfsstudio.net';
}

// ─── /community ─────────────────────────────────────────────────────────────

export async function renderCommunityIndexSeo(env: Env): Promise<ForumSeo> {
  const cats = await env.DB.prepare(
    `SELECT * FROM forum_category ORDER BY sort_order ASC, title ASC`,
  ).all<CategoryRow>();
  const counts = await env.DB.prepare(
    `SELECT category_id, COUNT(*) as n, MAX(last_post_at) as latest
       FROM forum_thread WHERE deleted_at IS NULL GROUP BY category_id`,
  ).all<{ category_id: string; n: number; latest: number }>();
  const countMap = new Map<string, { n: number; latest: number }>();
  for (const r of counts.results ?? []) countMap.set(r.category_id, { n: r.n, latest: r.latest });

  const items = (cats.results ?? []).map((c) => {
    const stat = countMap.get(c.id);
    return `
      <li>
        <h2><a href="/community/${encodeURIComponent(c.id)}">${escapeHtml(c.title)}</a></h2>
        <p>${escapeHtml(c.description)}</p>
        <p class="meta">${stat?.n ?? 0} thread${stat?.n === 1 ? '' : 's'}${stat?.latest ? ` · last activity ${formatDate(stat.latest)}` : ''}</p>
      </li>`;
  }).join('');

  const body = `
    <h1>GTFS Studio Community</h1>
    <p>Ask questions, share feeds, request features, and trade notes with other GTFS authors.</p>
    <ul class="forum-categories">${items}</ul>`;

  return {
    title: `${APP_NAME} — discussion forum`,
    description: 'Q&A and discussion for transit agencies, consultants, and GTFS authors using GTFS Studio. Get help with the editor, share feeds, request features.',
    canonicalUrl: `${appOrigin(env)}/community`,
    body,
    jsonLd: null,
    noindex: false,
  };
}

// ─── /community/:catId ──────────────────────────────────────────────────────

export async function renderCategorySeo(env: Env, catId: string): Promise<ForumSeo | null> {
  const cat = await env.DB.prepare(`SELECT * FROM forum_category WHERE id = ?`).bind(catId).first<CategoryRow>();
  if (!cat) return null;

  // Most-recent 50 threads (no cursor — crawler-friendly, full first page).
  const threadsRes = await env.DB.prepare(
    `SELECT * FROM forum_thread
       WHERE category_id = ? AND deleted_at IS NULL
       ORDER BY pinned DESC, last_post_at DESC, id DESC
       LIMIT 50`,
  ).bind(catId).all<ThreadRow>();
  const threads = threadsRes.results ?? [];

  const authorIds = Array.from(new Set(threads.map((t) => t.author_user_id)));
  const authorMap = new Map<string, AuthorDto>();
  await Promise.all(authorIds.map(async (uid) => {
    authorMap.set(uid, await userAuthorDto(env, uid));
  }));

  const items = threads.map((t) => {
    const author = authorMap.get(t.author_user_id)!;
    const href = `/community/${encodeURIComponent(catId)}/${encodeURIComponent(`${t.id}-${t.slug || slugify(t.title)}`)}`;
    return `
      <li>
        <h2><a href="${href}">${escapeHtml(t.title)}</a></h2>
        <p class="meta">by ${escapeHtml(author.displayName)} · ${t.post_count} repl${t.post_count === 1 ? 'y' : 'ies'} · last activity ${formatDate(t.last_post_at)}${t.solved_post_id ? ' · solved' : ''}</p>
      </li>`;
  }).join('');

  const body = `
    <nav class="breadcrumb"><a href="/community">Community</a> / ${escapeHtml(cat.title)}</nav>
    <h1>${escapeHtml(cat.title)}</h1>
    <p>${escapeHtml(cat.description)}</p>
    ${items ? `<ul class="forum-threads">${items}</ul>` : '<p><em>No threads yet — be the first to post.</em></p>'}`;

  return {
    title: `${cat.title} — ${APP_NAME}`,
    description: cat.description || `Discussion in ${cat.title} on the GTFS Studio community forum.`,
    canonicalUrl: `${appOrigin(env)}/community/${encodeURIComponent(catId)}`,
    body,
    jsonLd: null,
    noindex: false,
  };
}

// ─── /community/:catId/:threadKey ───────────────────────────────────────────

export async function renderThreadSeo(env: Env, threadId: string): Promise<ForumSeo | null> {
  const thread = await env.DB.prepare(
    `SELECT * FROM forum_thread WHERE id = ? AND deleted_at IS NULL`,
  ).bind(threadId).first<ThreadRow>();
  if (!thread) return null;

  const cat = await env.DB.prepare(`SELECT * FROM forum_category WHERE id = ?`).bind(thread.category_id).first<CategoryRow>();
  if (!cat) return null;

  const postsRes = await env.DB.prepare(
    `SELECT * FROM forum_post WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
  ).bind(threadId).all<PostRow>();
  const posts = postsRes.results ?? [];

  const authorIds = Array.from(new Set([thread.author_user_id, ...posts.map((p) => p.author_user_id)]));
  const authorMap = new Map<string, AuthorDto>();
  await Promise.all(authorIds.map(async (uid) => {
    authorMap.set(uid, await userAuthorDto(env, uid));
  }));

  const opts = { imageOriginHost: imageOriginHost(env) };

  const opPost = posts[0];
  const opAuthor = opPost ? authorMap.get(opPost.author_user_id) : undefined;
  const replies = posts.slice(1);

  const opHtml = opPost && opAuthor
    ? renderPostBlock(opPost, opAuthor, thread, true, opts)
    : '';
  const replyHtml = replies
    .map((p) => renderPostBlock(p, authorMap.get(p.author_user_id)!, thread, false, opts))
    .join('\n');

  const canonical = `${appOrigin(env)}/community/${encodeURIComponent(cat.id)}/${encodeURIComponent(`${thread.id}-${thread.slug || slugify(thread.title)}`)}`;

  const description = opPost
    ? markdownToPlainText(opPost.body_md, 200)
    : `Discussion: ${thread.title}`;

  const jsonLd = buildThreadJsonLd(thread, cat, posts, authorMap, canonical, appOrigin(env));

  const body = `
    <nav class="breadcrumb">
      <a href="/community">Community</a> /
      <a href="/community/${encodeURIComponent(cat.id)}">${escapeHtml(cat.title)}</a>
    </nav>
    <article>
      <header>
        <h1>${escapeHtml(thread.title)}</h1>
        <p class="meta">
          ${opAuthor ? `by ${escapeHtml(opAuthor.displayName)} · ` : ''}
          started ${formatDate(thread.created_at)} · ${thread.post_count} repl${thread.post_count === 1 ? 'y' : 'ies'}
          ${thread.solved_post_id ? ' · <strong>solved</strong>' : ''}
        </p>
      </header>
      ${opHtml}
      ${replies.length > 0 ? `<section class="replies"><h2>Replies</h2>${replyHtml}</section>` : ''}
    </article>`;

  return {
    title: `${thread.title} — ${cat.title} — ${APP_NAME}`,
    description,
    canonicalUrl: canonical,
    body,
    jsonLd,
    noindex: false,
  };
}

function renderPostBlock(
  post: PostRow,
  author: AuthorDto,
  thread: ThreadRow,
  isOp: boolean,
  opts: { imageOriginHost: string | null },
): string {
  if (post.deleted_at) {
    return `<article class="post deleted"><p><em>[deleted]</em></p></article>`;
  }
  const bodyHtml = renderMarkdownToHtml(post.body_md, opts);
  const isAnswer = thread.solved_post_id === post.id;
  return `
    <article class="post${isOp ? ' op' : ''}${isAnswer ? ' answer' : ''}" id="post-${escapeHtml(post.id)}">
      <header>
        <span class="author">${escapeHtml(author.displayName)}</span>
        <span class="meta"> · ${formatDate(post.created_at)}${post.edited_at ? ' · edited' : ''}${isAnswer ? ' · <strong>accepted answer</strong>' : ''}</span>
      </header>
      <div class="body">${bodyHtml}</div>
    </article>`;
}

function buildThreadJsonLd(
  thread: ThreadRow,
  cat: CategoryRow,
  posts: PostRow[],
  authors: Map<string, AuthorDto>,
  canonicalUrl: string,
  origin: string,
): string {
  const op = posts[0];
  const opAuthor = op ? authors.get(op.author_user_id) : undefined;

  const comments = posts.slice(1).map((p) => {
    const a = authors.get(p.author_user_id);
    return {
      '@type': 'Comment',
      '@id': `${canonicalUrl}#post-${p.id}`,
      text: p.deleted_at ? '[deleted]' : p.body_md,
      datePublished: new Date(p.created_at).toISOString(),
      author: a ? {
        '@type': 'Person',
        name: a.displayName,
        url: `${origin}/community/u/${encodeURIComponent(p.author_user_id)}`,
      } : undefined,
      upvoteCount: p.upvote_count,
    };
  });

  const root = {
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    '@id': canonicalUrl,
    headline: thread.title,
    articleSection: cat.title,
    datePublished: new Date(thread.created_at).toISOString(),
    dateModified: new Date(thread.last_post_at).toISOString(),
    interactionStatistic: [
      {
        '@type': 'InteractionCounter',
        interactionType: 'https://schema.org/CommentAction',
        userInteractionCount: Math.max(0, thread.post_count - 1),
      },
      {
        '@type': 'InteractionCounter',
        interactionType: 'https://schema.org/ViewAction',
        userInteractionCount: thread.view_count,
      },
    ],
    author: opAuthor ? {
      '@type': 'Person',
      name: opAuthor.displayName,
      url: `${origin}/community/u/${encodeURIComponent(thread.author_user_id)}`,
    } : undefined,
    text: op && !op.deleted_at ? op.body_md : undefined,
    comment: comments,
    url: canonicalUrl,
    isPartOf: {
      '@type': 'WebSite',
      name: 'GTFS Studio',
      url: origin,
    },
  };

  return JSON.stringify(root);
}

// ─── /community/u/:userId ────────────────────────────────────────────────────

export async function renderProfileSeo(env: Env, userId: string): Promise<ForumSeo | null> {
  const author = await userAuthorDto(env, userId);
  if (author.displayName === 'Deleted user') return null;

  const threadsRes = await env.DB.prepare(
    `SELECT id, slug, title, category_id, post_count, last_post_at
       FROM forum_thread WHERE author_user_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 20`,
  ).bind(userId).all<{ id: string; slug: string; title: string; category_id: string; post_count: number; last_post_at: number }>();
  const threads = threadsRes.results ?? [];

  const list = threads.map((t) => `
    <li>
      <a href="/community/${encodeURIComponent(t.category_id)}/${encodeURIComponent(`${t.id}-${t.slug || slugify(t.title)}`)}">${escapeHtml(t.title)}</a>
      <span class="meta"> · ${t.post_count} repl${t.post_count === 1 ? 'y' : 'ies'} · ${formatDate(t.last_post_at)}</span>
    </li>`).join('');

  const body = `
    <nav class="breadcrumb"><a href="/community">Community</a> / Profile</nav>
    <h1>${escapeHtml(author.displayName)}</h1>
    <h2>Recent threads</h2>
    ${list ? `<ul>${list}</ul>` : '<p><em>No threads yet.</em></p>'}`;

  return {
    title: `${author.displayName} — ${APP_NAME}`,
    description: `Forum profile and recent threads by ${author.displayName} on GTFS Studio Community.`,
    canonicalUrl: `${appOrigin(env)}/community/u/${encodeURIComponent(userId)}`,
    body,
    jsonLd: null,
    noindex: true, // user profile pages are low-value for search; keep them out
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
