import { test, expect } from '@playwright/test';
import { expectDownload } from './helpers';

/**
 * Export > "Export routes & stops as GeoJSON" (free on every plan) produces a
 * FeatureCollection with route LineStrings and stop Points. Uses the demo
 * feed so there's real shape + stop geometry without hand-building one.
 */
test('GeoJSON export produces a FeatureCollection with LineStrings and Points', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('button', { name: /routes/i }).first()).toContainText(/\d+/, { timeout: 20_000 });

  await page.getByRole('button', { name: /^export gtfs$/i }).click();
  const geoLink = page.getByRole('button', { name: /export routes.*stops as geojson/i });
  await expect(geoLink).toBeEnabled();

  const download = await expectDownload(page, async () => {
    await geoLink.click();
  });
  const path = await download.path();
  expect(path).toBeTruthy();

  const fs = await import('node:fs/promises');
  const json = JSON.parse(await fs.readFile(path!, 'utf8'));

  expect(json.type).toBe('FeatureCollection');
  const geomTypes = new Set(json.features.map((f: { geometry: { type: string } }) => f.geometry.type));
  expect(geomTypes.has('LineString')).toBe(true);
  expect(geomTypes.has('Point')).toBe(true);
});
