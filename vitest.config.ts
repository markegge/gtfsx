import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Integration-test harness for the GTFS Builder Worker (D1 + KV + R2 + Hono).
// Each test file gets its own workerd instance and therefore its own isolated
// storage. Within a test file we manually clean state between tests.
//
// Migrations are read at config-load time and exposed to tests via a
// test-only `TEST_MIGRATIONS` binding, then applied by `_setup.ts`.
export default defineConfig(async () => {
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
            FEEDS_ORIGIN: 'http://127.0.0.1',
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
