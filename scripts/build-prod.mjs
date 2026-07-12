// The single correct way to build for production. Works both locally (reads
// .env) and inside Cloudflare Workers Builds (no .env; vars come from the build
// environment, which wins over .env).
//
// Why this exists instead of a bare `npm run build`: src/utils/featureFlags.ts
// resolves the Stripe key as
//   VITE_STRIPE_PUBLISHABLE_KEY ?? VITE_STRIPE_PUBLISHABLE_TEST_KEY ?? ''
// but .env only defines the _LIVE_KEY / _TEST_KEY pair, never the generic name.
// On 2026-07-12 a manual `npm run build` therefore fell through to the test key
// and prod shipped with pk_test_: build green, deploy green, checkout dead for
// ~30 minutes, and nothing errored or warned. VITE_MAPBOX_TOKEN fails the same
// silent way (unset means a dead map).
//
// This script: loads .env under the real env → promotes _LIVE_KEY to the
// generic name → validates EVERY required var up front (listing all problems at
// once) → runs the normal build → verifies the emitted bundle with
// check-prod-bundle.mjs. Any problem aborts nonzero. It never silently
// continues.
//
//   npm run build:prod            # local
//   Cloudflare Workers Builds → Settings → Build command: npm run build:prod
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env parser (no new dependency). KEY=VALUE, `#` comments, optional
// `export ` prefix, optional surrounding quotes. Good enough for our flat file.
function parseDotEnv(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue; // blank line, comment, or junk
    const [, key] = m;
    let value = m[2].trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim(); // strip trailing comment
    out[key] = value;
  }
  return out;
}

// .env goes UNDER process.env: in Cloudflare there is no .env and the real
// build environment must win.
const env = { ...parseDotEnv(resolve(root, '.env')), ...process.env };

// Promote the live key to the generic name featureFlags.ts actually reads.
// This is the line whose absence took prod down.
if (!env.VITE_STRIPE_PUBLISHABLE_KEY && env.VITE_STRIPE_PUBLISHABLE_LIVE_KEY) {
  env.VITE_STRIPE_PUBLISHABLE_KEY = env.VITE_STRIPE_PUBLISHABLE_LIVE_KEY;
}

const problems = [];
const require_ = (ok, what, fix) => { if (!ok) problems.push({ what, fix }); };

const stripeKey = env.VITE_STRIPE_PUBLISHABLE_KEY ?? '';
if (!stripeKey) {
  problems.push({
    what: `VITE_STRIPE_PUBLISHABLE_KEY is not set, and VITE_STRIPE_PUBLISHABLE_LIVE_KEY is not set either.`,
    fix: `Set VITE_STRIPE_PUBLISHABLE_LIVE_KEY=pk_live_… in .env (locally) or in the\n` +
      `    Cloudflare Workers Builds environment variables. Without it the app silently\n` +
      `    falls back to the TEST key and checkout dies in production.`,
  });
} else if (!stripeKey.startsWith('pk_live_')) {
  problems.push({
    what: `VITE_STRIPE_PUBLISHABLE_KEY is not a live key (starts with "${stripeKey.slice(0, 8)}…", expected "pk_live_").`,
    fix: `A prod build must use the pk_live_… key. Point VITE_STRIPE_PUBLISHABLE_LIVE_KEY at\n` +
      `    the live publishable key from the Stripe dashboard (never the pk_test_ one).`,
  });
}

require_(
  (env.VITE_MAPBOX_TOKEN ?? '').startsWith('pk.'),
  `VITE_MAPBOX_TOKEN is missing or not a public token (expected it to start with "pk.").`,
  `Set VITE_MAPBOX_TOKEN to the Mapbox PUBLIC token (pk.…). Unset means every map is dead.`,
);
require_(
  (env.VITE_TURNSTILE_SITE_KEY ?? '').length > 0,
  `VITE_TURNSTILE_SITE_KEY is empty — the signup form's bot gate would be skipped.`,
  `Set VITE_TURNSTILE_SITE_KEY to the Turnstile site key that pairs with the\n` +
    `    TURNSTILE_SECRET_KEY Worker secret.`,
);

if (problems.length > 0) {
  console.error(`\n✖ PROD BUILD ABORTED (${problems.length} problem${problems.length > 1 ? 's' : ''}) — nothing was built.\n`);
  for (const [i, p] of problems.entries()) {
    console.error(`  ${i + 1}. ${p.what}`);
    console.error(`     Fix: ${p.fix}\n`);
  }
  process.exit(1);
}

console.log(
  `▶ prod build: stripe=pk_live_ (from ${process.env.VITE_STRIPE_PUBLISHABLE_KEY ? 'VITE_STRIPE_PUBLISHABLE_KEY' : 'VITE_STRIPE_PUBLISHABLE_LIVE_KEY'}), ` +
    `mapbox + turnstile present`,
);

const build = spawnSync('npm', ['run', 'build'], { cwd: root, env, stdio: 'inherit' });
if (build.status !== 0) {
  console.error(`\n✖ PROD BUILD FAILED — \`npm run build\` exited ${build.status}.\n`);
  process.exit(build.status ?? 1);
}

const check = spawnSync(process.execPath, [resolve(root, 'scripts', 'check-prod-bundle.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(check.status ?? 1);
