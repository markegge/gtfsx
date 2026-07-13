import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Shared helpers for the anonymous-editor e2e suite. Kept deliberately small
 * and behavior-based (wait on UI state, not timeouts) so specs stay
 * deterministic. Selector strategy throughout: getByRole with case-insensitive
 * name regexes, never exact button/label casing — a parallel branch is
 * standardizing button-label casing (e.g. "+ Add Route" -> "+ Add route")
 * and dialogs are migrating to Radix, so exact-text selectors would flake.
 */

/** Click a left-rail nav section by its label (e.g. /agency/i, /routes/i). */
export async function openSection(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).first().click();
}

/**
 * Click a route-detail sub-tab (Details / Shapes / Stops / Trips / Costs).
 * Two of those labels ("Stops", "Costs") collide with left-rail nav items of
 * the same name, which stay mounted in the DOM while a route is being
 * edited — scope to the <aside> the route-detail rail renders into (the
 * left rail is a plain <div>) so the click is unambiguous.
 */
export async function openRouteTab(page: Page, name: RegExp) {
  await page.locator('aside').getByRole('button', { name }).first().click();
}

export function mapCanvas(page: Page): Locator {
  return page.locator('.mapboxgl-canvas').first();
}

/** Resolve the map canvas's bounding box, retrying briefly — the map mounts
 *  lazily and the canvas can report a zero-size box for a beat after mount. */
export async function mapCenter(page: Page): Promise<{ x: number; y: number }> {
  const canvas = mapCanvas(page);
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Map canvas has no bounding box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Draw a tiny route shape on the map via mapbox-gl-draw's line-string mode.
 * `offsets` are pixel deltas from the map's visual center; the last point is
 * finished with a double-click (mapbox-gl-draw's line-finish gesture).
 * Handles the snap/unsnap dialog either way it resolves (snapped cleanly, or
 * couldn't match the road network) by keeping whatever geometry results.
 */
export async function drawShapeOnMap(
  page: Page,
  offsets: Array<{ dx: number; dy: number }> = [
    { dx: -40, dy: -25 },
    { dx: 0, dy: 0 },
    { dx: 40, dy: 20 },
  ],
) {
  const center = await mapCenter(page);
  const points = offsets.map((o) => ({ x: center.x + o.dx, y: center.y + o.dy }));

  for (let i = 0; i < points.length - 1; i++) {
    await page.mouse.click(points[i].x, points[i].y);
  }
  const last = points[points.length - 1];
  await page.mouse.dblclick(last.x, last.y);

  await resolveSnapDialogIfPresent(page);
}

/**
 * If the "Couldn't snap to roads" dialog appeared (partial road-network
 * match, or no network access to the snap service at all — either surfaces
 * the same dialog), keep the drawn/unsnapped geometry. "Keep unsnapped" /
 * "Keep current shape" is always the primary action regardless of whether
 * the snap partially matched or failed outright, so a single click resolves
 * either case without the test needing to know which one occurred.
 */
export async function resolveSnapDialogIfPresent(page: Page) {
  const dialogHeading = page.getByRole('heading', { name: /couldn.t snap to roads/i });
  // The snap-to-road request has no client-side timeout, so a network hiccup
  // (or no network access to the snap service at all, in a sandboxed CI) can
  // take a while to fail — give it a generous window before concluding no
  // dialog is coming (i.e. the snap succeeded outright).
  const appeared = await dialogHeading
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) {
    await page.getByRole('button', { name: /keep unsnapped|keep current shape/i }).click();
  }
}

/** Place `count` stops along the currently-drawn shape via the CreateStopPanel's
 *  "Place on Map" toggle (snap-to-route is the default placement mode). */
export async function placeStopsOnMap(page: Page, count: number) {
  await page.getByRole('button', { name: /place on map/i }).click();
  const center = await mapCenter(page);
  const offsets = [
    { dx: -30, dy: -18 },
    { dx: 0, dy: 0 },
    { dx: 30, dy: 15 },
  ].slice(0, count);
  for (const o of offsets) {
    await page.mouse.click(center.x + o.dx, center.y + o.dy);
    // Give the store a beat to commit before the next click — placement
    // mode stays active across clicks, but rapid-fire clicks on a fresh
    // mount can race the first stop's render.
    await page.waitForTimeout(150);
  }
  await page.getByRole('button', { name: /done placing/i }).click();
  // Placing via the map doesn't exit the "New stop" create panel on its own
  // (only the manual-entry form's Create button does) — the panel's back
  // arrow returns to the route's Stops list. It shares an accessible name
  // ("←") with nothing else in the rail, so no aside-scoping is needed.
  await page.getByRole('button', { name: '←' }).click();
}

/** Wait for a Playwright download and return its suggested filename + path. */
export async function expectDownload(page: Page, trigger: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return download;
}
