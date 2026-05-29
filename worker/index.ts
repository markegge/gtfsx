import { Hono } from 'hono';
import type { Env, AppContext } from './env';
import { TILE_RE, serveTile } from './legacy/tiles';
import { handleSearch, handleProxy } from './legacy/imports';
import { sessionMiddleware, requireClientHeader } from './auth/middleware';
import { authRouter } from './auth/routes';
import { apiRouter } from './api';
import { feedsHandler } from './publication/feeds';
import { maybeRenderForumPage } from './forum/dispatcher';
import { maybeRenderMarketingPage } from './marketing/ssr';
import { serveSitemap } from './forum/sitemap';

// Legacy aliases that were advertised from the old /about nav and may still
// have inbound links. Their real content lives elsewhere, so 301 (permanent)
// to the canonical URL and let inbound link equity follow. Query strings are
// preserved.
const LEGACY_ALIAS_REDIRECTS: Record<string, string> = {
  '/quickstart': '/docs/quick-start/',
  '/gtfs-flex': '/learn/gtfs-flex/',
  '/what-is-gtfs': '/learn/gtfs/',
};

// Client-side (React Router) routes that have NO pre-rendered HTML file and
// must still receive the SPA shell (index.html, HTTP 200) so the app can
// render them. The static-assets binding is configured with
// `not_found_handling: "404-page"`, so an asset miss returns dist/404.html
// with a real 404 — which is what we want for genuinely dead URLs (no more
// soft-404s), but NOT for these legitimate app routes. Keep this in sync with
// the <Routes> in src/App.tsx. (/pricing and /demo are normally served by the
// marketing SSR above; they're listed here only as a fallback in case that
// render throws and falls through.)
const SPA_SHELL_EXACT = new Set([
  '/',
  '/import',
  '/login',
  '/signup',
  '/help',
  '/pricing',
  '/demo',
  '/upgrade',
  '/verify-email',
  '/magic-link',
  '/reset-password',
  '/change-email',
]);
const SPA_SHELL_PREFIXES = ['/account', '/admin', '/community', '/feeds', '/orgs', '/welcome'];

function isSpaShellRoute(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (SPA_SHELL_EXACT.has(p)) return true;
  return SPA_SHELL_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

const app = new Hono<AppContext>();

// Request ID + basic headers on every response
app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  await next();
});

// Populate c.var.user / c.var.session from the cookie if present. Runs on
// every request; handlers opt into strict auth via requireAuth.
app.use('/api/*', sessionMiddleware);
app.use('/auth/*', sessionMiddleware);

// CSRF header requirement on all state-changing requests. Combined with
// SameSite=Lax cookies this blocks cross-site request forgery.
app.use('/api/*', requireClientHeader);
app.use('/auth/*', requireClientHeader);

// ─── Legacy routes (tiles, Mobility DB search, ZIP proxy) ───────────────────

app.get('/_import/search', async (c) => handleSearch(c.req.raw, c.env));
app.get('/_import/proxy', async (c) => handleProxy(c.req.raw, c.executionCtx));

// ─── Auth + API ─────────────────────────────────────────────────────────────

app.route('/auth', authRouter);
app.route('/api', apiRouter);

// ─── Error handler (return JSON for known API errors, text otherwise) ───────

app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  const isApi = path.startsWith('/api') || path.startsWith('/auth');
  if (err instanceof Error && 'getResponse' in err && typeof err.getResponse === 'function') {
    return (err as unknown as { getResponse: () => Response }).getResponse();
  }
  console.error(`[${c.var.requestId}] unhandled error on ${path}:`, err);
  if (isApi) {
    return c.json({ error: 'internal', message: 'Something went wrong — please try again' }, 500);
  }
  return c.text('Internal error', 500);
});

// ─── Entry ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Legacy-domain 301 redirect (post-rebrand 2026-05-18 — GTFS·X). Three
    // prior brand domains stay bound to the Worker and 301 to the matching
    // gtfsx.com host in a single hop, so already-shared links (especially
    // feed URLs polled by downstream catalogs) keep working:
    //
    //   <sub>.gtfsstudio.net   → <sub>.gtfsx.com   (bare → www.gtfsx.com)
    //   <sub>.gtfsstudio.com   → <sub>.gtfsx.com
    //   <sub>.gtfsbuilder.net  → <sub>.gtfsx.com
    //
    // We collapse the two-hop chain (gtfsbuilder.net → gtfsstudio.net →
    // gtfsx.com) into one redirect on purpose — each extra hop costs latency
    // and a chance for an external poller to give up.
    const LEGACY_SUFFIXES = ['gtfsstudio.net', 'gtfsstudio.com', 'gtfsbuilder.net'];
    for (const suffix of LEGACY_SUFFIXES) {
      if (url.hostname === suffix || url.hostname.endsWith(`.${suffix}`)) {
        const sub = url.hostname === suffix
          ? 'www'
          : url.hostname.slice(0, -(suffix.length + 1));
        const newHost = `${sub}.gtfsx.com`;
        return Response.redirect(
          `https://${newHost}${url.pathname}${url.search}`,
          301,
        );
      }
    }

    // Public feed distribution lives on a separate hostname (FEEDS_ORIGIN):
    //   prod:    feeds.gtfsx.com
    //   staging: staging-feeds.gtfsx.com
    //   dev:     anything starting with `feeds.` (localhost etc.)
    // Never auth-aware; no cookies. Handled by a dedicated module.
    let feedsHost: string | null = null;
    try {
      feedsHost = env.FEEDS_ORIGIN ? new URL(env.FEEDS_ORIGIN).hostname : null;
    } catch {
      feedsHost = null;
    }
    if (
      (feedsHost && url.hostname === feedsHost) ||
      url.hostname.startsWith('feeds.')
    ) {
      try {
        return await feedsHandler(request, env, ctx);
      } catch (err) {
        console.error('[feeds] unhandled error', err);
        return new Response('Internal error', { status: 500 });
      }
    }

    // Tile serving sits outside Hono because it's perf-sensitive and uses a
    // regex path match. Handle it before entering the router.
    const tileMatch = url.pathname.match(TILE_RE);
    if (tileMatch) {
      const [, archive, zStr, xStr, yStr] = tileMatch;
      try {
        return await serveTile(request, ctx, env, archive, Number(zStr), Number(xStr), Number(yStr));
      } catch (err) {
        return new Response(`Tile error: ${(err as Error).message}`, { status: 500 });
      }
    }

    // If Hono's app handles it (any /auth, /api, /_import route), use that.
    if (
      url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/_import')
    ) {
      return app.fetch(request, env, ctx);
    }

    // Legacy-alias 301 redirects (/quickstart, /gtfs-flex, /what-is-gtfs).
    // Match with or without a trailing slash; preserve the query string.
    {
      const aliasKey = url.pathname.replace(/\/+$/, '') || '/';
      const target = LEGACY_ALIAS_REDIRECTS[aliasKey];
      if (target) {
        return Response.redirect(`${url.origin}${target}${url.search}`, 301);
      }
    }

    // Marketing routes that are otherwise live React pages (/pricing, /demo)
    // get route-specific SEO head + an indexable body skeleton injected into
    // the SPA shell, then hydrate normally. Returns null for other paths.
    try {
      const marketing = await maybeRenderMarketingPage(request, env);
      if (marketing) return marketing;
    } catch (err) {
      console.error('[marketing-ssr] render error, falling back to SPA shell:', err);
    }

    // Forum pages get server-rendered SEO content injected into the SPA shell
    // before the React bundle takes over. The dispatcher returns null for
    // SPA-only paths (/community/new, /community/profile) so they fall
    // through to the static-assets binding unchanged.
    if (env.BACKEND_ENABLED === 'true') {
      try {
        const ssr = await maybeRenderForumPage(request, env);
        if (ssr) return ssr;
      } catch (err) {
        // Never let SSR break the SPA shell — log and fall back.
        console.error('[forum-ssr] render error, falling back to SPA shell:', err);
      }
    }

    // Dynamic sitemap that augments the static one in `public/` with every
    // public forum thread URL.
    if (url.pathname === '/sitemap.xml' && env.BACKEND_ENABLED === 'true') {
      try {
        return await serveSitemap(request, env);
      } catch (err) {
        console.error('[forum-sitemap] error, falling back to static sitemap:', err);
      }
    }

    // Everything else: static assets, with a real 404 for genuine misses.
    //
    // The assets binding uses `not_found_handling: "404-page"`, so a path with
    // no matching file resolves to dist/404.html with an HTTP 404 status. For
    // known client-side routes we instead serve the SPA shell (index.html,
    // 200) so React Router can take over; everything else keeps the real 404.
    // This stops Googlebot from indexing soft-404s — dead URLs used to return
    // index.html with a 200 status. Trailing-slash and other redirects from
    // the binding (status !== 404) are passed through unchanged.
    const assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status !== 404 || !isSpaShellRoute(url.pathname)) {
      return assetRes;
    }
    const shell = await env.ASSETS.fetch(new URL('/index.html', url.origin).toString());
    return new Response(shell.body, {
      status: 200,
      headers: shell.headers,
    });
  },

  // Scheduled worker invocations (Cron Triggers). See worker/cron/index.ts.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { runScheduled } = await import('./cron');
    await runScheduled(event, env, ctx);
  },
};
