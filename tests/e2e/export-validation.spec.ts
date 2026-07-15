import { test, expect } from '@playwright/test';
import { openSection } from './helpers';

/**
 * Export dialog's warnings section renders and expands. A route with a short
 * name but no trips (same deterministic setup as validation-navigation.spec)
 * always produces a non-blocking "has no trips" warning, so the dialog's
 * collapsible warnings summary is guaranteed to appear.
 */
test('export dialog warnings section renders and expands', async ({ page }) => {
  await page.goto('/');

  await openSection(page, /routes/i);
  await page.getByRole('button', { name: /create route|add route/i }).first().click();
  await page.getByTestId('field-short-name').fill('10');

  await page.getByRole('button', { name: /^export gtfs$/i }).click();

  const warningsToggle = page.getByRole('button', { name: /warnings? — export will proceed/i });
  await expect(warningsToggle).toBeVisible();
  await expect(warningsToggle).toHaveAttribute('aria-expanded', 'false');
  await warningsToggle.click();
  await expect(warningsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/has no trips/i)).toBeVisible();
});
