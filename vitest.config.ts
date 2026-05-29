import fs from 'node:fs';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The Worker now serves static assets directly (real 404s + the SPA shell +
// X-Robots-Tag) via the ASSETS binding, which miniflare reads from ./dist at
// startup. CI runs the worker tests against an empty dist/ (the worker-tests
// job skips the frontend build for speed), so seed the handful of fixtures
// routes.notFound.test.ts needs. A real local/prod build already provides the
// genuine files — we only create what's missing, never overwrite.
function seedAssetFixtures(): void {
  const dist = path.join(__dirname, 'dist');
  const seed = (rel: string, html: string) => {
    const p = path.join(dist, rel);
    if (fs.existsSync(p)) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html);
  };
  // NOTE: deliberately do NOT seed index.html. marketing.ssr.ts falls back to
  // its hand-built minimalHtml() when the shell asset is absent, and
  // marketing.ssr.test.ts relies on that fallback in CI's empty-dist run. A
  // stub index.html would instead send the SSR down its HTMLRewriter path
  // against a shell missing the SEO elements it rewrites, breaking that test.
  // routes.notFound.test.ts asserts on status + headers, not shell body, so it
  // doesn't need index.html present.
  //
  // Real 404 page (served with a 404 status by not_found_handling: "404-page").
  seed('404.html', '<!doctype html><html><head><meta name="robots" content="noindex"><title>Page not found</title></head><body>404 — page not found</body></html>');
  // A representative pre-rendered content page (asserted 200 + indexable).
  seed('about/index.html', '<!doctype html><html><head><title>About</title></head><body>About GTFS·X</body></html>');
}

// Integration-test harness for the GTFS·X Worker (D1 + KV + R2 + Hono).
// Each test file gets its own workerd instance and therefore its own isolated
// storage. Within a test file we manually clean state between tests.
//
// Migrations are read at config-load time and exposed to tests via a
// test-only `TEST_MIGRATIONS` binding, then applied by `_setup.ts`.
export default defineConfig(async () => {
  seedAssetFixtures();
  const migrationsPath = path.join(__dirname, 'worker/migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
          // Deterministic env values for tests. These shadow the vars in
          // wrangler.jsonc so the tests don't depend on prod config.
          bindings: {
            APP_ORIGIN: 'http://127.0.0.1',
            // Must differ from APP_ORIGIN's hostname — the Worker routes
            // `feedsHost === url.hostname` requests through feedsHandler,
            // which returns 405 for non-GET. The `_feeds.local` namespace
            // makes it explicit that these are test-only bindings.
            FEEDS_ORIGIN: 'http://feeds.test.local',
            BACKEND_ENABLED: 'true',
            HARD_LIMITS: 'false',
            AUTH_EMAIL_FROM: 'test@example.com',
            RESEND_API_KEY: 'test-resend-key',
            MOBILITY_DATABASE_REFRESH_TOKEN: 'test-md-token',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['worker/__tests__/**/*.test.ts'],
    },
  };
});
