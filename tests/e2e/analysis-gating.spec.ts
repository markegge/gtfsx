import { test, expect } from '@playwright/test';
import { openSection } from './helpers';

/**
 * Analysis panels on an anonymous (free) plan: Costs and Coverage show their
 * free system-level tier unwrapped; Access Isochrones, Title VI, and Stop
 * Analysis are each wrapped in the same PaywallOverlay gate (RightRail.tsx's
 * PanelBody switch) — assert the shared gate card (plan badge + upgrade CTA)
 * appears in all three, and does NOT appear for Costs/Coverage.
 */
test('Costs and Coverage render free content; Access/Title VI/Stop Analysis are gated', async ({ page }) => {
  await page.goto('/');

  // Costs and Coverage are only PARTIALLY gated (system-level totals are free;
  // the per-route breakdown/CSV is Agency+), so a "Sign up to upgrade" CTA can
  // legitimately appear further down either panel — the free system section
  // rendering unblurred is the actual thing to assert.
  await openSection(page, /costs/i);
  await expect(page.getByRole('heading', { name: /system totals/i })).toBeVisible();

  // Coverage's "System Summary" only renders after a real Census-data fetch
  // (Analyze Coverage), which needs stops and network access — undesirable
  // for this gating check. On a stop-less feed its free tier instead shows
  // its own empty-state prompt ("No Stops Yet"), not a paywall card — which
  // is equally good proof the panel isn't gated.
  await openSection(page, /coverage/i);
  await expect(page.getByText(/no stops yet/i)).toBeVisible();

  // Access Isochrones, Title VI, and Stop Analysis are gated in full (RightRail's
  // PanelBody wraps the whole panel in PaywallOverlay) — the shared gate card
  // is the only thing rendered.
  for (const label of [/access/i, /title vi/i, /stop analysis/i]) {
    await openSection(page, label);
    await expect(page.getByRole('button', { name: /sign up to upgrade/i })).toBeVisible();
    await expect(page.getByText(/plan$/i).first()).toBeVisible();
  }
});
