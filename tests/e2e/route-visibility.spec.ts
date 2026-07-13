import { test, expect } from '@playwright/test';
import { openSection } from './helpers';

/**
 * Routes panel's Show all / Hide all and per-route visibility toggles flip
 * the route swatch button's title (its map-visibility state), rather than
 * inspecting map pixels. Uses the demo feed so there are several real routes
 * to toggle.
 */
test('Show all / Hide all and per-route toggles change map visibility state', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('button', { name: /routes/i }).first()).toContainText(/\d+/, { timeout: 20_000 });

  await openSection(page, /routes/i);

  // Route color swatches carry the visibility toggle; title flips between
  // "Hide from map" (visible) and "Show on map" (hidden).
  const firstSwatch = page.locator('button[title="Hide from map"], button[title="Show on map"]').first();
  await expect(firstSwatch).toBeVisible();

  await page.getByRole('button', { name: /hide all/i }).click();
  await expect(page.locator('button[title="Hide from map"]')).toHaveCount(0);
  await expect(page.locator('button[title="Show on map"]').first()).toBeVisible();

  await page.getByRole('button', { name: /show all/i }).click();
  await expect(page.locator('button[title="Show on map"]')).toHaveCount(0);
  await expect(page.locator('button[title="Hide from map"]').first()).toBeVisible();

  // Per-route toggle: hide just the first route, leave the rest visible.
  await firstSwatch.click();
  await expect(firstSwatch).toHaveAttribute('title', 'Show on map');
  await firstSwatch.click();
  await expect(firstSwatch).toHaveAttribute('title', 'Hide from map');
});
