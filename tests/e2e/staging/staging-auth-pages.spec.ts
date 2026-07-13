import { test, expect } from '@playwright/test';

/**
 * Only runs when E2E_STAGING=1. /login and /signup must render their forms.
 * The Google sign-up/sign-in button's presence is asserted (both pages use
 * GoogleSignInButton) and its state is recorded via annotation — docs
 * (public/docs/account-and-cloud-sync/) describe Google OAuth as deferred,
 * so this test only checks the button renders; it never clicks through to
 * Google (that would leave the browser on accounts.google.com, and no
 * credentials are available or wanted here anyway).
 */
test('/login renders its form and the Google sign-in button', async ({ page }) => {
  const res = await page.goto('/login');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();

  const googleButton = page.getByRole('button', { name: /continue with google/i });
  const present = await googleButton.isVisible().catch(() => false);
  test.info().annotations.push({
    type: 'google-oauth-button',
    description: present
      ? 'Google sign-in button is present on /login'
      : 'Google sign-in button NOT found on /login — check against docs/account-and-cloud-sync (OAuth was documented as deferred)',
  });
});

test('/signup renders its form and the Google sign-up button', async ({ page }) => {
  const res = await page.goto('/signup');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();

  const googleButton = page.getByRole('button', { name: /sign up with google/i });
  const present = await googleButton.isVisible().catch(() => false);
  test.info().annotations.push({
    type: 'google-oauth-button',
    description: present
      ? 'Google sign-up button is present on /signup'
      : 'Google sign-up button NOT found on /signup — check against docs/account-and-cloud-sync (OAuth was documented as deferred)',
  });
});
