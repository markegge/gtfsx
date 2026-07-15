import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import { openSection, openRouteTab, drawShapeOnMap, placeStopsOnMap, expectDownload } from './helpers';

/**
 * The documented golden path (public/docs/quick-start/): agency -> calendars
 * -> routes -> shapes -> stops -> timetables -> export. This is the
 * highest-value test in the suite — it exercises the whole authoring flow an
 * anonymous first-time user would follow, end to end, and asserts the
 * resulting GTFS zip actually contains the files it should.
 *
 * Selectors are role/regex-based throughout (see helpers.ts) rather than
 * exact button text, and rely on waiting for the resulting UI state (a row
 * appearing, a tab count showing up) rather than fixed timeouts.
 */
test('quick start: agency through export produces a valid GTFS zip', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#root')).not.toBeEmpty();

  // 1. Agency — starts empty; "+ Add Agency" seeds a draft row and reveals the form.
  await openSection(page, /agency/i);
  await page.getByRole('button', { name: /add agency/i }).click();
  await page.getByTestId('field-agency-name').fill('Sunny Valley Transit');
  await page.getByTestId('field-agency-url').fill('https://example.com');
  await expect(page.getByTestId('field-agency-name')).toHaveValue('Sunny Valley Transit');

  // 2. Calendars — a service pattern with sane defaults (Weekdays) is enough;
  // the doc's "day toggles + date range" are pre-filled by addCalendar().
  await openSection(page, /calendars/i);
  await page.getByRole('button', { name: /add service pattern/i }).click();
  await expect(page.getByText(/operating days/i)).toBeVisible();

  // 3. Routes — create one, then draw a shape.
  await openSection(page, /routes/i);
  await page.getByRole('button', { name: /create route|add route/i }).first().click();
  await page.getByTestId('field-short-name').fill('10');

  // 4. Shapes tab — draw a tiny 3-point shape on the map.
  await openRouteTab(page, /^shapes$/i);
  await page.getByRole('button', { name: /draw route shape|add new shape/i }).click();
  await drawShapeOnMap(page);
  // A shape row now exists (rename input defaults to the "Untitled shape"
  // placeholder until named) with a non-zero point count.
  await expect(page.getByText(/\d+ pts/).first()).toBeVisible({ timeout: 10_000 });

  // 5. Stops tab — create 2-3 stops along the shape via snap-to-route.
  await openRouteTab(page, /^stops$/i);
  await page.getByRole('button', { name: /create new stop/i }).click();
  await placeStopsOnMap(page, 3);
  await expect(page.getByText(/stops \(\d+\)/i)).toBeVisible();

  // 6. Trips tab -> open the timetable editor -> generate trips. The right-rail
  // Trips tab's shortcut ("✨ Generate service" / "Open timetable editor") opens
  // the bottom-panel timetable; the timetable itself then uses the refreshed UI:
  // a "Generate trips…" tool (and an empty-state "Generate trips" CTA) that opens
  // an inline drawer — no longer a modal.
  await openRouteTab(page, /^trips$/i);
  await page.getByRole('button', { name: /generate service|open timetable editor/i }).first().click();
  // In the bottom panel, both the Trip-tools "Generate trips…" button and the
  // empty-state "Generate trips" CTA open the same inline drawer — either match.
  const bottomPanel = page.getByTestId('bottom-panel');
  await bottomPanel.getByRole('button', { name: /generate trips/i }).first().click();
  // The bulk-tool form is an inline drawer (a labelled region), not a Radix
  // dialog, so assert it by its accessible name rather than role=dialog.
  const generateDrawer = page.getByRole('region', { name: /generate trips/i });
  await expect(generateDrawer).toBeVisible();
  // The drawer's primary action is "Generate N trips"; commit it.
  const generateButton = generateDrawer.getByRole('button', { name: /generate .*trip/i });
  await expect(generateButton).toBeEnabled();
  await generateButton.click();
  // Trips exist now — the tab label picks up a count ("Trips 33"), so match
  // it as a substring rather than the exact pre-generation name.
  await openRouteTab(page, /trips/i);
  await expect(page.getByRole('columnheader', { name: /direction/i })).toBeVisible();

  // 7. Export — the dialog lists GTFS files with row counts, then downloads.
  await page.getByRole('button', { name: /^export gtfs$/i }).click();
  await expect(page.getByText(/agency\.txt/)).toBeVisible();
  await expect(page.getByText(/^\d+ routes?$/)).toBeVisible();
  await expect(page.getByText(/^\d+ stops?$/)).toBeVisible();

  // The dialog is now open, so there are two "Export GTFS" buttons on screen
  // (the TopBar trigger, still behind the dialog, and the dialog's own submit
  // button, rendered after it in the DOM) — .last() is the submit action.
  const download = await expectDownload(page, async () => {
    await page.getByRole('button', { name: /^export gtfs$/i }).last().click();
  });
  const zipPath = await download.path();
  expect(zipPath).toBeTruthy();

  const fs = await import('node:fs/promises');
  const buf = await fs.readFile(zipPath!);
  const zip = await JSZip.loadAsync(buf);
  for (const name of ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt']) {
    expect(zip.file(name), `${name} missing from export`).toBeTruthy();
  }
});
