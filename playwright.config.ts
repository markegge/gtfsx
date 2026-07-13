// Playwright config for GTFS·X e2e tests.
//
// Two independent test populations:
//  - "chromium" (default): runs against a `vite dev` server this config spawns
//    itself on a dedicated port (5188 — chosen to avoid colliding with other
//    agents/dev servers that may be running on the usual 5173/4173). Covers
//    anonymous local workflows: the editor, export, analysis gating, etc.
//  - "staging" (opt-in via E2E_STAGING=1): points baseURL at the real
//    staging.gtfsx.com deployment. No webServer — it's a live remote target.
//    Only included in the `projects` array when E2E_STAGING=1, so a plain
//    `npm run test:e2e` never makes network calls to staging.
import { defineConfig, devices } from '@playwright/test';

const STAGING = process.env.E2E_STAGING === '1';
const LOCAL_PORT = 5188;
const LOCAL_BASE_URL = `http://127.0.0.1:${LOCAL_PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  // A few specs draw on the map or wait out a real (possibly network-less)
  // snap-to-road round trip, plus the demo feed test fetches a real zip over
  // the network — the default 30s per-test budget is tight for those.
  timeout: 60_000,
  webServer: {
    // Plain `vite dev` (not build+preview) — faster start, and behavior for
    // these tests (form flows, map draw, export) doesn't depend on a prod
    // bundle. --strictPort so a port collision fails loudly instead of
    // silently reusing someone else's server.
    command: `npx vite --port ${LOCAL_PORT} --strictPort --host 127.0.0.1`,
    url: LOCAL_BASE_URL,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: LOCAL_BASE_URL,
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testDir: './tests/e2e',
      testIgnore: '**/staging/**',
      use: { ...devices['Desktop Chrome'] },
    },
    ...(STAGING
      ? [
          {
            name: 'staging',
            testDir: './tests/e2e/staging',
            use: {
              ...devices['Desktop Chrome'],
              baseURL: 'https://staging.gtfsx.com',
            },
          },
        ]
      : []),
  ],
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
