// Playwright config for GTFS·X UI smoke tests.
//
// Scope: bootstrap-level checks (SPA loads, no JS errors on mount, main
// routes render). Deeper flow tests are deferred — most components don't
// yet have stable test selectors and adding them is a separate change.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Single worker; smoke is small and avoids any local state contention.
  workers: 1,
  // Build + preview the SPA. Preview port matches Vite's default.
  // --host 127.0.0.1 is required so Playwright's URL probe and tests can
  // connect (vite preview defaults to `localhost` resolution which fails
  // intermittently under IPv6 in CI runners).
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    // Capture trace/screenshot on first retry only — keeps CI artifacts small.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
