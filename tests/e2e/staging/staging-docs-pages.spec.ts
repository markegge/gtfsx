import { test, expect } from '@playwright/test';

/**
 * Only runs when E2E_STAGING=1 (see playwright.config.ts) against
 * https://staging.gtfsx.com. /docs/ and /docs/quick-start/ are static pages
 * served from public/docs/ — in local dev these paths 404 (they're not part
 * of the Vite dev server's module graph, only copied into the built dist/),
 * which is expected and NOT what this test is checking. What matters here is
 * Worker route precedence on staging: these paths must resolve to the real
 * static docs content, not the SPA's index.html/404 shell.
 */
test('/docs/ renders real static content, not the SPA shell', async ({ page }) => {
  const res = await page.goto('/docs/');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/documentation/i);
});

test('/docs/quick-start/ renders real static content, not the SPA shell', async ({ page }) => {
  const res = await page.goto('/docs/quick-start/');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/quick start/i);
});
