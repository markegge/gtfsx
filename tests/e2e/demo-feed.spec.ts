import { test, expect } from '@playwright/test';

/**
 * /demo fetches the published svt-demo feed from feeds.gtfsx.com over the
 * real network and imports it into the editor (see App.tsx's loadDemoFeed).
 * Known contents as of writing: 5 routes, 139 stops, 2 calendars — asserted
 * loosely (order-of-magnitude, not exact) since the published demo feed can
 * legitimately grow over time without that being a regression.
 */
test('demo feed loads with its known routes/stops/calendars and no console errors', async ({ page }) => {
  const IGNORED = [
    /api\.mapbox\.com/i,
    /events\.mapbox\.com/i,
    /mapbox-gl-[A-Za-z0-9_-]+\.js/,
    /favicon/i,
    /Failed to load resource.*40[13]/,
    /Failed to load resource.*502/,
    /\[Vite\]/,
  ];
  const errors: string[] = [];
  page.on('console', async (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const sourceUrl = msg.location()?.url ?? '';
    // msg.text() stringifies an Error argument as its minified constructor
    // name (e.g. "Ct"), not the message — pull the real stack/message out via
    // evaluate, same approach as smoke.spec.ts's console-error collector.
    const argDetails: string[] = [];
    for (const arg of msg.args()) {
      try {
        const d = await arg.evaluate((v) => {
          if (v instanceof Error) {
            // mapbox-gl AjaxError-style objects carry the failing request URL +
            // HTTP status on the error itself. Include them: since mapbox-gl 3.26
            // logs tile-load failures from a worker whose stack is only a blob:
            // URL, the request URL is the sole thing that attributes them to
            // api.mapbox.com so the IGNORED allowlist can filter them.
            const ax = v as Error & { url?: string; status?: number };
            const extra = [ax.url, ax.status].filter((x) => x != null).join(' ');
            return [v.stack || v.message || String(v), extra].filter(Boolean).join(' ');
          }
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v); } catch { return String(v); }
        });
        if (d) argDetails.push(d);
      } catch { /* ignore extraction failures */ }
    }
    const detail = argDetails.length ? argDetails.join(' | ') : text;
    if (IGNORED.some((p) => p.test(detail) || p.test(text) || p.test(sourceUrl))) return;
    errors.push(`${detail} (logged from ${sourceUrl || 'unknown'})`);
  });
  page.on('pageerror', (err) => {
    const text = err.stack ?? err.message;
    if (IGNORED.some((p) => p.test(text))) return;
    errors.push(text);
  });

  await page.goto('/demo');

  // Nav badges reflect the live store counts (agencies/routes/stops/calendars)
  // regardless of which panel is open, so we don't need to open each section.
  const routesBadge = page.getByRole('button', { name: /routes/i }).first();
  await expect(routesBadge).toContainText(/\d+/, { timeout: 20_000 });

  const routesText = (await routesBadge.textContent()) ?? '';
  const routesCount = Number(routesText.match(/\d+/)?.[0] ?? 0);
  expect(routesCount).toBeGreaterThanOrEqual(1);

  const stopsText = (await page.getByRole('button', { name: /stops/i }).first().textContent()) ?? '';
  const stopsCount = Number(stopsText.match(/\d+/)?.[0] ?? 0);
  expect(stopsCount).toBeGreaterThanOrEqual(50);

  const calendarsText = (await page.getByRole('button', { name: /calendars/i }).first().textContent()) ?? '';
  const calendarsCount = Number(calendarsText.match(/\d+/)?.[0] ?? 0);
  expect(calendarsCount).toBeGreaterThanOrEqual(1);

  // Give any late console/page errors from the import + first render a beat.
  await page.waitForTimeout(1_000);
  expect(errors, `Console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
