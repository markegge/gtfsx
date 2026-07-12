// Verifies that the built bundle in dist/ is a REAL production bundle: live
// Stripe key, no test key, and a Mapbox token.
//
// Why: on 2026-07-12 prod shipped with a pk_test_ key. `.env` defines
// VITE_STRIPE_PUBLISHABLE_LIVE_KEY / _TEST_KEY but not the generic
// VITE_STRIPE_PUBLISHABLE_KEY that featureFlags.ts reads first, so a bare
// `npm run build` fell through to the `?? TEST_KEY` branch. Build green, deploy
// green, site up, checkout dead for ~30 minutes. Nothing errored, nothing
// warned. VITE_MAPBOX_TOKEN fails the same silent way: unset means a dead map.
//
// Run standalone (`npm run check:prod-bundle`) or automatically as the last
// step of `npm run build:prod`. Exits nonzero on any failure.
//
// NOTE: the Stripe key lives in a LAZY-LOADED chunk (AuthLayout-*.js), not the
// entry bundle, so every chunk under dist/assets must be scanned, not just
// index-*.js.
import { readdirSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = resolve(root, 'dist', 'assets');

function jsFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) jsFiles(p, acc);
    else if (e.name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

if (!existsSync(ASSETS)) {
  console.error(`\n✖ PROD BUNDLE CHECK: no dist/assets — nothing to verify.`);
  console.error(`  Fix: run the build first (npm run build:prod).\n`);
  process.exit(1);
}

// Read as utf-8; Node substitutes U+FFFD for invalid sequences (the bundles
// carry non-ASCII, which naive byte-wise tooling such as `grep` misreads as
// binary and mis-scans). We only match ASCII markers, so replacements are
// harmless.
const chunks = jsFiles(ASSETS).map((f) => ({
  name: relative(root, f),
  src: readFileSync(f, 'utf8'),
}));

if (chunks.length === 0) {
  console.error(`\n✖ PROD BUNDLE CHECK: dist/assets contains no .js chunks.`);
  console.error(`  Fix: run the build first (npm run build:prod).\n`);
  process.exit(1);
}

const anyChunk = (needle) => chunks.filter((c) => c.src.includes(needle));

const failures = [];
const fail = (what, fix) => failures.push({ what, fix });

// 1. A Stripe TEST key in a prod bundle is the 2026-07-12 incident, exactly.
const testKeyChunks = anyChunk('pk_test_');
if (testKeyChunks.length > 0) {
  fail(
    `PROD BUNDLE CONTAINS A STRIPE TEST KEY (pk_test_) in: ${testKeyChunks.map((c) => c.name).join(', ')}\n` +
      `    Checkout will be dead in production. This is the 2026-07-12 incident.`,
    `Build with \`npm run build:prod\` (never a bare \`npm run build\`). It sets\n` +
      `    VITE_STRIPE_PUBLISHABLE_KEY from VITE_STRIPE_PUBLISHABLE_LIVE_KEY. Without it,\n` +
      `    src/utils/featureFlags.ts silently falls back to VITE_STRIPE_PUBLISHABLE_TEST_KEY.`,
  );
}

// 2. ...and the live key must actually be present.
if (anyChunk('pk_live_').length === 0) {
  fail(
    `NO STRIPE LIVE KEY (pk_live_) in any chunk — billing cannot work in production.`,
    `Set VITE_STRIPE_PUBLISHABLE_KEY (or VITE_STRIPE_PUBLISHABLE_LIVE_KEY, which\n` +
      `    npm run build:prod promotes for you) to the pk_live_… key from the Stripe\n` +
      `    dashboard, then rebuild with \`npm run build:prod\`.`,
  );
}

// 3. Mapbox public token — unset means every map renders blank.
if (anyChunk('pk.eyJ').length === 0) {
  fail(
    `NO MAPBOX PUBLIC TOKEN (pk.eyJ…) in any chunk — the map will be dead.`,
    `Set VITE_MAPBOX_TOKEN to the pk.… public token and rebuild.`,
  );
}

if (failures.length > 0) {
  console.error(
    `\n✖ PROD BUNDLE CHECK FAILED (${failures.length} problem${failures.length > 1 ? 's' : ''}) — DO NOT DEPLOY dist/\n`,
  );
  for (const [i, f] of failures.entries()) {
    console.error(`  ${i + 1}. ${f.what}`);
    console.error(`     Fix: ${f.fix}\n`);
  }
  process.exit(1);
}

console.log(
  `✔ prod bundle OK — ${chunks.length} chunks scanned: stripe=pk_live_ (no pk_test_), mapbox token present`,
);
