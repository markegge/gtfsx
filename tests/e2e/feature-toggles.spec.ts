import { test, expect } from '@playwright/test';
import { openSection } from './helpers';

/**
 * Settings panel toggles gate left-rail nav items / tabs. Two representative
 * toggles: `demandResponse` (on by default) hides "Flex Zones" from the nav
 * when turned off; `transfers` (off by default) reveals a Transfers tab under
 * Fares when turned on.
 */
test('feature toggles show/hide the nav items and tabs they gate', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: /flex zones/i })).toBeVisible();

  await openSection(page, /settings/i);
  await page
    .getByRole('switch', { name: /demand response/i })
    .click();
  await expect(page.getByRole('button', { name: /flex zones/i })).toHaveCount(0);

  const transfersSwitch = page.getByRole('switch', { name: /^transfers$/i });
  await expect(transfersSwitch).toHaveAttribute('aria-checked', 'false');
  await transfersSwitch.click();
  await expect(transfersSwitch).toHaveAttribute('aria-checked', 'true');

  await openSection(page, /fares/i);
  await expect(page.getByRole('button', { name: /^transfers$/i })).toBeVisible();
});
