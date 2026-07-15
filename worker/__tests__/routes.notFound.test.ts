// Soft-404 prevention. Unknown URLs must return a real HTTP 404 (the static
// 404.html), NOT the SPA shell with a 200 — otherwise Googlebot indexes dead
// URLs as soft-404s. Known client-side routes must still be served (200) so
// React Router can render them, and private/functional ones carry
// X-Robots-Tag: noindex. See worker/index.ts (isSpaShellRoute /
// isNoindexShellRoute + the catch-all) and wrangler.jsonc
// (assets.not_found_handling: "404-page").
//
// These assert on STATUS + HEADERS — the worker's actual routing decision —
// not on shell body content: CI runs the worker tests against an empty dist/
// (no real index.html), and the genuine shell body (#root + JS bundle) is
// verified against the live site at deploy time instead.

import { describe, it, expect } from 'vitest';
import { makeClient } from './_client';

const client = makeClient();

describe('genuine misses return a real 404 (no soft-404 shell)', () => {
  const deadUrls = [
    '/this-page-does-not-exist-xyz/',
    '/docs/totally-made-up/',
    '/compare/nonexistent-competitor/',
    '/learn/not-a-real-guide/',
    '/some/deep/bogus/path',
  ];

  for (const url of deadUrls) {
    it(`404s ${url}`, async () => {
      const res = await client.get(url, { redirect: 'manual' });
      expect(res.status).toBe(404);
      // A 404 must never be the 200 SPA shell (that's the soft-404 bug).
      expect((await res.text()).includes('id="root"')).toBe(false);
    });
  }
});

describe('known client-side routes are served (200), not 404ed', () => {
  // Routes with no pre-rendered HTML file that fall back to the SPA shell.
  // A 200 here (vs the 404 a genuine miss gets) proves the shell-vs-404
  // decision. /community/* is excluded (it hits the forum SSR + D1).
  const spaRoutes = ['/login', '/signup', '/feeds', '/account', '/import', '/help'];

  for (const route of spaRoutes) {
    it(`serves ${route} with 200`, async () => {
      const res = await client.get(route, { redirect: 'manual' });
      expect(res.status).toBe(200);
    });
  }

  it('serves the homepage / with 200', async () => {
    const res = await client.get('/', { redirect: 'manual' });
    expect(res.status).toBe(200);
  });

  it('serves a pre-rendered static page at /about/ with 200', async () => {
    const res = await client.get('/about/', { redirect: 'manual' });
    expect(res.status).toBe(200);
  });
});

describe('private/functional shell routes are noindex; content pages are not', () => {
  // /import was the URL flagged as a Soft 404 in Search Console.
  const noindexRoutes = ['/import', '/login', '/signup', '/account', '/feeds'];
  for (const route of noindexRoutes) {
    it(`sends X-Robots-Tag: noindex for ${route}`, async () => {
      const res = await client.get(route, { redirect: 'manual' });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Robots-Tag')).toContain('noindex');
    });
  }

  // Content pages served via the shell must stay indexable.
  it('does NOT noindex /help (a real content page in the sitemap)', async () => {
    const res = await client.get('/help', { redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Robots-Tag') ?? '').not.toContain('noindex');
  });

  it('does NOT noindex the homepage /', async () => {
    const res = await client.get('/', { redirect: 'manual' });
    expect(res.headers.get('X-Robots-Tag') ?? '').not.toContain('noindex');
  });
});

describe('legacy tier-picker aliases 301 to /pricing', () => {
  // /upgrade and /welcome/plan were merged into /pricing. They must 301
  // (permanent) and preserve the query so checkout context carries over.
  for (const alias of ['/upgrade', '/welcome/plan']) {
    it(`301s ${alias} → /pricing`, async () => {
      const res = await client.get(alias, { redirect: 'manual' });
      expect(res.status).toBe(301);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/pricing');
    });

    it(`preserves the query string on ${alias}`, async () => {
      const res = await client.get(`${alias}?plan=agency&interval=year&source=welcome`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(301);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.pathname).toBe('/pricing');
      expect(loc.searchParams.get('plan')).toBe('agency');
      expect(loc.searchParams.get('interval')).toBe('year');
      expect(loc.searchParams.get('source')).toBe('welcome');
    });
  }
});
