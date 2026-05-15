// /sitemap.xml — merges the static marketing-page sitemap (in `public/`) with
// every public forum thread URL so newly-posted threads are discoverable.
// Static entries stay authoritative for canonical / priority; forum entries
// are appended with lastmod = forum_thread.last_post_at.
//
// Cached at the edge for 30 minutes so we don't run a D1 scan on every
// crawler hit; static + ~50 thread additions per day stays comfortably
// within the 50,000-URL / 50MB sitemap limits.

import type { Env } from '../env';
import { slugify } from './util';
import { escapeHtml } from './markdown';

const SITEMAP_CACHE_HEADER = 'public, max-age=600, s-maxage=1800';
const MAX_THREADS = 10000;

export async function serveSitemap(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  // Only serve from the canonical hostname — staging gets its own; the legacy
  // gtfsbuilder.net hosts get 301'd to the canonical equivalent upstream.
  const origin = env.APP_ORIGIN || `${url.protocol}//${url.hostname}`;

  // 1) Fetch the static sitemap so it remains the source of truth for
  //    marketing pages.
  const staticReq = new Request(`${origin}/sitemap.xml`, { method: 'GET' });
  // Bypass the worker by hitting ASSETS directly (avoids recursion).
  const staticRes = await env.ASSETS.fetch(staticReq);
  let staticXml = await staticRes.text().catch(() => '');
  if (!staticXml.includes('<urlset')) {
    // Static file missing — emit a minimal urlset rather than 500.
    staticXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>`;
  }

  // 2) Build forum URL entries — categories + threads.
  const cats = await env.DB.prepare(
    `SELECT id FROM forum_category ORDER BY sort_order ASC`,
  ).all<{ id: string }>();
  const threads = await env.DB.prepare(
    `SELECT id, slug, title, category_id, last_post_at
       FROM forum_thread WHERE deleted_at IS NULL
       ORDER BY last_post_at DESC LIMIT ?`,
  ).bind(MAX_THREADS).all<{ id: string; slug: string; title: string; category_id: string; last_post_at: number }>();

  const additions: string[] = [];

  additions.push(urlEntry(`${origin}/community`, null, 'daily', '0.7'));
  for (const c of cats.results ?? []) {
    additions.push(urlEntry(`${origin}/community/${encodeURIComponent(c.id)}`, null, 'daily', '0.6'));
  }
  for (const t of threads.results ?? []) {
    const slug = t.slug || slugify(t.title);
    const loc = `${origin}/community/${encodeURIComponent(t.category_id)}/${encodeURIComponent(`${t.id}-${slug}`)}`;
    additions.push(urlEntry(loc, new Date(t.last_post_at).toISOString(), 'weekly', '0.5'));
  }

  // 3) Splice the additions in before the closing </urlset>.
  const merged = staticXml.replace(/<\/urlset>\s*$/, `${additions.join('\n')}\n</urlset>`);

  return new Response(merged, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': SITEMAP_CACHE_HEADER,
    },
  });
}

function urlEntry(loc: string, lastmod: string | null, changefreq: string, priority: string): string {
  return `  <url>
    <loc>${escapeHtml(loc)}</loc>${lastmod ? `\n    <lastmod>${escapeHtml(lastmod)}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}
