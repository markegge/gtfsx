import { test, expect } from '@playwright/test';
import { openSection } from './helpers';

/**
 * Clicking a validation warning navigates to the offending entity's panel
 * (ValidationPanel's handleClick -> setSidebarSection(+selectRoute/etc)).
 * Deterministic scenario: a route with a short name but no trips always
 * produces a "has no trips" warning (services/validation.ts) tagged
 * entity_type: 'route' — no need to depend on the demo feed's incidental
 * warning set.
 */
test('clicking a validation warning opens the offending route', async ({ page }) => {
  await page.goto('/');

  await openSection(page, /routes/i);
  await page.getByRole('button', { name: /create route|add route/i }).first().click();
  await page.getByTestId('field-short-name').fill('10');

  // Exit route-detail so the right rail is showing the plain Routes list (and
  // its "Routes" heading) rather than this route's own detail header —
  // otherwise both "before" and "after" states would look the same. The
  // header's close button's accessible name is its "✕" glyph (its `title` is
  // only a tooltip/description, not the a11y name), so use the breadcrumb
  // "Routes" back-link instead — scoped to <aside> since the left nav has an
  // identically-named "Routes" item mounted at the same time.
  await page.locator('aside').getByRole('button', { name: /^routes$/i }).click();

  await page.getByRole('button', { name: /validation/i }).click();
  const warning = page.getByText(/has no trips/i);
  await expect(warning).toBeVisible();
  await warning.click();

  await expect(page.getByRole('heading', { name: /^routes$/i })).toBeVisible();
});
