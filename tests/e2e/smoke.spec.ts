/**
 * SPA bootstrap smoke. Catches:
 *  - module-load errors from a bad refactor
 *  - missing or renamed exports surfacing as runtime exceptions
 *  - obvious render-on-mount crashes
 *
 * What this does NOT cover (intentionally):
 *  - Full feature flow (import → coverage → title VI) — needs stable test
 *    selectors first; tracked separately.
 *  - Mapbox tile rendering — requires VITE_MAPBOX_TOKEN baked into the build,
 *    and Mapbox 401s are filtered out below so token absence isn't a failure.
 *  - External API contracts (Census, FCC, Mapbox) — covered by the daily
 *    workflow in .github/workflows/external-apis.yml.
 */
import { expect, test } from '@playwright/test';

// Console / page errors we tolerate. Anything outside this allowlist that
// surfaces during the smoke is treated as a regression. We match against
// both the message text AND the source URL/stack — mapbox-gl exceptions
// surface as minified identifiers like "Kt" in text and only the source
// URL reveals they're not our code.
const IGNORED_PATTERNS: RegExp[] = [
  /api\.mapbox\.com/i,            // Map tile/token requests — out of scope here.
  /events\.mapbox\.com/i,
  /mapbox-gl-[A-Za-z0-9_-]+\.js/, // Bundled mapbox-gl chunk; needs token in build.
  /favicon/i,                     // Missing favicon doesn't matter for the smoke.
  /Failed to load resource.*401/, // Auth-required endpoints when not signed in.
  /Failed to load resource.*403/,
  /Failed to load resource.*502/, // Mapbox events endpoint 502s without a token.
  /\[Vite\]/,                     // Vite preview HMR/devtool chatter.
];

function shouldIgnore(...parts: string[]) {
  const combined = parts.filter(Boolean).join(' | ');
  return IGNORED_PATTERNS.some((p) => p.test(combined));
}

test('home page loads without JS errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', async (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const loc = msg.location();
    const sourceUrl = loc?.url ?? '';
    // Error.stack is non-enumerable — jsonValue() returns "{}". Use evaluate
    // to extract the real stack so we can see (and filter) where it came from.
    const argDetails: string[] = [];
    for (const arg of msg.args()) {
      try {
        const d = await arg.evaluate((v) => {
          if (v instanceof Error) return v.stack || v.message || String(v);
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v); } catch { return String(v); }
        });
        if (d) argDetails.push(d);
      } catch { /* ignore extraction failures */ }
    }
    const detail = argDetails.length ? argDetails.join(' | ') : text;
    if (shouldIgnore(detail, text, sourceUrl)) return;
    consoleErrors.push(`${detail} (logged from ${sourceUrl || 'unknown'})`);
  });
  page.on('pageerror', (err) => {
    if (shouldIgnore(err.message, err.stack ?? '')) return;
    pageErrors.push(err.stack ?? err.message);
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // React mounts into #root; verify it has children (anything beyond the
  // noscript fallback that's outside #root in index.html).
  await expect(page.locator('#root')).not.toBeEmpty({ timeout: 15_000 });

  // Give async chunks + first render a beat to surface any errors they throw.
  await page.waitForTimeout(2_000);

  expect(pageErrors, `Page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `Console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
});
