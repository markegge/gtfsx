// SSR entry point. worker/index.ts calls maybeRenderForumPage() for every
// non-API request; if the URL matches a forum route we return an HTML response
// derived from the SPA shell with SEO content injected. Otherwise we return
// null and the caller falls through to env.ASSETS.fetch().

import type { Env } from '../env';
import {
  renderCategorySeo,
  renderCommunityIndexSeo,
  renderProfileSeo,
  renderThreadSeo,
  type ForumSeo,
} from './seo';

const FORUM_CACHE_HEADER = 'public, max-age=60, s-maxage=300';

// Path patterns we own. Order matters — most specific first.
//
//   /community                                  → index (categories)
//   /community/new                              → SPA only (auth-gated)
//   /community/profile                          → SPA only (self profile editor)
//   /community/u/<userId>                       → user profile
//   /community/<catId>                          → category thread list
//   /community/<catId>/<threadKey>              → thread detail
const SPA_ONLY_SUBPATHS = new Set(['new', 'profile']);

export async function maybeRenderForumPage(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/community')) return null;

  // Strip trailing slashes from the segment list for clean matching.
  const segs = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  // segs[0] === 'community'
  if (segs.length === 1) {
    // /community
    const seo = await renderCommunityIndexSeo(env);
    return buildResponse(env, seo);
  }

  const second = segs[1];
  if (SPA_ONLY_SUBPATHS.has(second)) return null;

  if (second === 'u' && segs.length === 3) {
    const seo = await renderProfileSeo(env, decodeURIComponent(segs[2]));
    if (!seo) return null;
    return buildResponse(env, seo);
  }

  if (segs.length === 2) {
    // /community/:catId
    const seo = await renderCategorySeo(env, decodeURIComponent(second));
    if (!seo) return null;
    return buildResponse(env, seo);
  }

  if (segs.length === 3) {
    // /community/:catId/:threadKey  — threadKey is "<ulid>-<slug>"
    const threadKey = decodeURIComponent(segs[2]);
    // ULIDs are 26 chars [0-9A-HJKMNP-TV-Z]. The slug is appended after a `-`.
    // Extract everything up to the first `-` as the candidate id.
    const id = threadKey.split('-')[0];
    if (!id || id.length !== 26) return null;
    const seo = await renderThreadSeo(env, id);
    if (!seo) return null;
    return buildResponse(env, seo);
  }

  return null;
}

async function buildResponse(env: Env, seo: ForumSeo): Promise<Response> {
  // Pull the SPA shell from the static assets binding. The same response is
  // mutated to inject the SEO head + visible content.
  const shellReq = new Request(`${env.APP_ORIGIN || 'https://www.gtfsx.com'}/index.html`);
  const shell = await env.ASSETS.fetch(shellReq);
  if (!shell.ok) {
    // Should not happen — fall back to a minimal HTML response so the
    // crawler still gets *something*.
    return new Response(minimalHtml(seo), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const robotsContent = seo.noindex ? 'noindex, follow' : 'index, follow';

  // HTMLRewriter is the workerd-native, streaming, allocation-light HTML
  // mutator. We:
  //   • Replace <title> content
  //   • Replace the meta description content
  //   • Update the og:url and canonical link
  //   • Append page-specific OG + structured data + a visible SEO block
  //     inside <body> (before #root) so crawlers see semantic content
  //     immediately. The SPA's main.tsx mounts into #root; we tag the SEO
  //     block with an id the SPA removes on mount to avoid duplicate
  //     content during hydration.
  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(seo.title);
      },
    })
    .on('meta[name="description"]', {
      element(el) {
        el.setAttribute('content', seo.description);
      },
    })
    .on('meta[property="og:title"]', {
      element(el) {
        el.setAttribute('content', seo.title);
      },
    })
    .on('meta[property="og:description"]', {
      element(el) {
        el.setAttribute('content', seo.description);
      },
    })
    .on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute('content', seo.canonicalUrl);
      },
    })
    .on('link[rel="canonical"]', {
      element(el) {
        el.setAttribute('href', seo.canonicalUrl);
      },
    })
    .on('h1[data-home-only]', {
      // Drop the homepage's visually-hidden SEO H1 — forum pages have
      // their own page-topic H1 in the injected body and should be the
      // sole H1 the crawler sees.
      element(el) {
        el.remove();
      },
    })
    .on('head', {
      element(el) {
        el.append(`<meta name="robots" content="${robotsContent}"/>`, { html: true });
        if (seo.jsonLd) {
          el.append(
            `<script type="application/ld+json">${seo.jsonLd.replace(/</g, '\\u003c')}</script>`,
            { html: true },
          );
        }
      },
    })
    .on('body', {
      element(el) {
        // Visible to crawlers and during the SPA's loading flash; main.tsx
        // removes the node right before React mounts so users never see it
        // double up with the live UI.
        el.prepend(
          `<div id="forum-ssr" data-prerendered><style>#forum-ssr{max-width:760px;margin:24px auto;padding:0 20px;font-family:system-ui,-apple-system,sans-serif;color:#2A1F18;line-height:1.6}#forum-ssr h1{font-size:1.6rem;margin-bottom:0.25rem}#forum-ssr h2{font-size:1.2rem;margin-top:1.5rem}#forum-ssr .meta{color:#6B5A4D;font-size:0.85rem}#forum-ssr ul.forum-categories,#forum-ssr ul.forum-threads{list-style:none;padding:0;margin:1rem 0}#forum-ssr ul.forum-categories>li,#forum-ssr ul.forum-threads>li{padding:1rem 0;border-bottom:1px solid #EDE3D4}#forum-ssr .post{margin:1rem 0;padding:1rem;border:1px solid #EDE3D4;border-radius:8px}#forum-ssr .post.answer{border-color:#2A8074}#forum-ssr blockquote{border-left:3px solid #EDE3D4;margin:0.5rem 0;padding-left:1rem;color:#6B5A4D}#forum-ssr pre{background:#FBF6EE;padding:0.75rem;border-radius:6px;overflow-x:auto}#forum-ssr a{color:#E07853}#forum-ssr img{max-width:100%;height:auto;border-radius:6px}#forum-ssr nav.breadcrumb{font-size:0.85rem;color:#6B5A4D;margin-bottom:0.5rem}</style>${seo.body}</div>`,
          { html: true },
        );
      },
    });

  const transformed = rewriter.transform(shell);
  return new Response(transformed.body, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': FORUM_CACHE_HEADER,
      'x-robots-tag': robotsContent,
    },
  });
}

function minimalHtml(seo: ForumSeo): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>${escape(seo.title)}</title>
<meta name="description" content="${escape(seo.description)}"/>
<link rel="canonical" href="${escape(seo.canonicalUrl)}"/>
<meta name="robots" content="${seo.noindex ? 'noindex, follow' : 'index, follow'}"/>
${seo.jsonLd ? `<script type="application/ld+json">${seo.jsonLd.replace(/</g, '\\u003c')}</script>` : ''}
</head><body>${seo.body}</body></html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
