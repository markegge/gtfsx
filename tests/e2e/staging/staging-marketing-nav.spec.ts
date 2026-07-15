import { test, expect } from '@playwright/test';

/**
 * Only runs when E2E_STAGING=1. /pricing and /signup must render, full stop.
 * Whether they carry the FULL marketing nav (vs. the minimal app shell they
 * use today) is an open product-owner decision, not a regression this suite
 * should fail on either way — so that part is recorded as a soft
 * assertion/annotation rather than a hard failure.
 */
test('/pricing renders', async ({ page }) => {
  const res = await page.goto('/pricing');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading').first()).toBeVisible();

  const nav = page.locator('nav');
  const hasFullNav = (await nav.count()) > 0 && (await nav.first().isVisible().catch(() => false));
  test.info().annotations.push({
    type: 'marketing-nav-presence',
    description: hasFullNav
      ? 'Full marketing <nav> is present on /pricing'
      : 'No <nav> found on /pricing — still using the minimal app shell (expected as of writing; product owner is deciding whether this changes)',
  });
});

test('/signup renders', async ({ page }) => {
  const res = await page.goto('/signup');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('input[type="email"]')).toBeVisible();

  const nav = page.locator('nav');
  const hasFullNav = (await nav.count()) > 0 && (await nav.first().isVisible().catch(() => false));
  test.info().annotations.push({
    type: 'marketing-nav-presence',
    description: hasFullNav
      ? 'Full marketing <nav> is present on /signup'
      : 'No <nav> found on /signup — still using the minimal app shell (expected as of writing; product owner is deciding whether this changes)',
  });
});
