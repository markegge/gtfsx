import { Hono } from 'hono';
import type { Env, AppContext } from './env';
import { TILE_RE, serveTile } from './legacy/tiles';
import { handleSearch, handleProxy } from './legacy/imports';
import { sessionMiddleware, requireClientHeader } from './auth/middleware';
import { authRouter } from './auth/routes';
import { apiRouter } from './api';
import { feedsHandler } from './publication/feeds';

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

    // Legacy-domain 301 redirect (post-rebrand 2026-05-14). gtfsbuilder.net
    // and every subdomain were bound to this Worker before the rename; we
    // keep them bound and 301 to the matching gtfsstudio.net host so that
    // already-shared links — especially feed URLs polled by downstream
    // catalogs (Mobility DB, transit.land) — keep working.
    if (
      url.hostname === 'gtfsbuilder.net' ||
      url.hostname.endsWith('.gtfsbuilder.net')
    ) {
      const newHost = url.hostname.replace(/gtfsbuilder\.net$/, 'gtfsstudio.net');
      return Response.redirect(
        `https://${newHost}${url.pathname}${url.search}`,
        301,
      );
    }

    // Vanity TLD redirect. gtfsstudio.com is owned so the brand isn't squatted;
    // every request 301s to the canonical .net counterpart.
    //   gtfsstudio.com        → www.gtfsstudio.net (bare → canonical landing)
    //   www.gtfsstudio.com    → www.gtfsstudio.net
    //   staging.gtfsstudio.com → staging.gtfsstudio.net (etc — any subdomain)
    if (
      url.hostname === 'gtfsstudio.com' ||
      url.hostname.endsWith('.gtfsstudio.com')
    ) {
      const newHost = url.hostname === 'gtfsstudio.com'
        ? 'www.gtfsstudio.net'
        : url.hostname.replace(/\.gtfsstudio\.com$/, '.gtfsstudio.net');
      return Response.redirect(
        `https://${newHost}${url.pathname}${url.search}`,
        301,
      );
    }

    // Public feed distribution lives on a separate hostname (FEEDS_ORIGIN):
    //   prod:    feeds.gtfsstudio.net
    //   staging: staging-feeds.gtfsstudio.net
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

    // Everything else: static assets (SPA fallback handled by the binding).
    return env.ASSETS.fetch(request);
  },

  // Scheduled worker invocations (Cron Triggers). See worker/cron/index.ts.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { runScheduled } = await import('./cron');
    await runScheduled(event, env, ctx);
  },
};
