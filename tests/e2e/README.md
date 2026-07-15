# e2e suite

Playwright tests. `npm run test:e2e` runs the local `chromium` project only
(anonymous-editor flows against a `vite dev` server this config spawns on
port 5188 — see `playwright.config.ts`). Nothing here makes network calls to
staging unless `E2E_STAGING=1` is set, which adds a second `staging` project
pointed at `https://staging.gtfsx.com` (`npm run test:e2e:staging`).

## Layout

- `helpers.ts` — shared flow helpers (nav, map-draw, stop placement, snap-dialog
  handling, download capture). Selector convention: `getByRole` with
  case-insensitive **regex** names, never exact button/label text — a parallel
  branch is standardizing button-label casing and migrating dialogs to Radix,
  so exact-text selectors would flake as that lands. A `data-testid` was added
  to `FormField` (auto-derived from its `label`, e.g. `field-agency-name`) and
  to `BottomPanel`'s root (`bottom-panel`), sparingly, only where no stable
  role/text selector existed.
- `*.spec.ts` (this directory) — local, anonymous-editor tests.
- `staging/*.spec.ts` — staging-only tests, gated on `E2E_STAGING=1`.

## Seeding an auth'd user for staging tests

`staging/staging-seeded-auth.spec.ts` is `test.fixme()` stubs only — not
implemented yet. Intended approach for whoever picks this up:

1. **Seed, don't sign up.** `scripts/dev-seed-user.ts` already supports this:
   ```
   npx tsx scripts/dev-seed-user.ts --env staging --remote <email> <name> <password>
   ```
   This writes a pre-verified, `status='active'` user straight into the
   staging D1 (via `wrangler d1 execute --env staging --remote`), skipping
   the email-verification step a real signup would need. It requires
   whoever runs it to have `wrangler` authenticated against the account that
   owns the `gtfs-builder-staging` D1 binding — same auth this repo's other
   `--env staging --remote` scripts already assume.
2. **Reuse one seeded account**, not a fresh one per test run — reseeding
   with the same email is idempotent-ish (it INSERTs a new row) but the
   script doesn't currently handle "already exists" gracefully, so either
   pre-seed one fixed test account once (out of band) and hardcode its
   credentials in an env var (`E2E_STAGING_TEST_EMAIL` / `_PASSWORD`, not
   committed), or teach the script an upsert path first.
3. **Log in via the UI**, not a crafted cookie: `POST` the `/login` form
   fields (email/password) with Playwright, wait for the redirect/`/api/me`
   to confirm the session, then reuse that browser context (`storageState`)
   across the seeded-auth tests in the same file so login only happens once.
4. **Org-scoped tests** (org settings, some publish-panel states) need an
   org too, which `dev-seed-user.ts` does not create — that likely has to
   go through the real "create org" UI flow once signed in, or a follow-up
   seeding script. Check for an existing org-seed path before hand-rolling
   one.
5. **Guardrails:** never point any of this at production (only
   `--env staging --remote` / the local D1); never commit real credentials;
   prefer asserting UI state over relying on side effects like sent email
   actually arriving somewhere.
