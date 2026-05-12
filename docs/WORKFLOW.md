# Git + Deployment Workflow

How code moves from "I'm starting work" to "live for users." Solo-project conventions; tightened where past pain showed up.

For first-time Cloudflare provisioning (D1, KV, R2, secrets, Resend, Turnstile) see [`DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md). For the live environment snapshot see [`BACKEND_STATUS.md`](./BACKEND_STATUS.md). This file is the day-to-day cadence.

---

## TL;DR

```
main = source of truth.   Stays deployable at all times.
Feature branches = short-lived, branched off main, merged via --ff-only.

Push to main          → CI deploys to staging.gtfsbuilder.net  (auto)
Tag a commit prod-*   → CI deploys to gtfsbuilder.net          (deliberate)

Kill-switch flags (BACKEND_ENABLED + VITE_BACKEND_ENABLED) keep prod safe
while main races ahead with backend features under development.
```

There is no long-lived "develop" branch. Staging tracks `main` continuously; production only moves when you tag a commit `prod-YYYY-MM-DD` and push the tag. See "Deploying to production" below.

---

## Branching

### Naming

```
feature/<short-name>     — net-new functionality
bug/<short-name>         — fixes
docs/<short-name>        — doc-only changes
chore/<short-name>       — dependency bumps, infra hygiene, etc.
```

Keep names short and human. The branch will live for a few hours to a few days; long names are noise.

### Starting work

```bash
git checkout main
git pull origin main
git checkout -b feature/turnstile-on-magic-link
```

Always branch off the latest `main`. If you've been away for a while, `git pull` first — `main` may have moved.

---

## Local dev

The frontend and the worker run separately:

```bash
# Terminal 1 — Vite dev server (proxies /api, /auth, /_import, /_demand-tiles → :8787)
npm run dev          # http://localhost:5173

# Terminal 2 — Worker
npx wrangler dev --port 8787 --local
```

`.env` carries `VITE_BACKEND_ENABLED=true`, `VITE_TURNSTILE_SITE_KEY`, `VITE_MAPBOX_TOKEN`. `.dev.vars` carries `RESEND_API_KEY` plus overridden `APP_ORIGIN` / `FEEDS_ORIGIN`. Both gitignored.

For an authenticated session without configuring real email:

```bash
npx tsx scripts/dev-seed-user.ts you@test.com "You" hunter2-hunter2
```

Tests:

```bash
npx tsx run-tests.ts                                          # editor integration tests
npx vitest run --fileParallelism=false                        # worker integration tests
npx tsc -p tsconfig.app.json --noEmit                         # frontend typecheck
npx tsc -p tsconfig.worker.json --noEmit                      # worker typecheck
```

`--fileParallelism=false` is required for the worker tests because of a workerd WebSocket-disconnect quirk under parallel runs. Serial is stable.

---

## Deploying to staging

Free and reversible. Deploy to staging often — that's the whole point.

**Automatic (default):** every push to `main` triggers `.github/workflows/deploy.yml` → the `staging` job. The build runs with `VITE_BACKEND_ENABLED=true` / `VITE_BILLING_ENABLED=true` and `wrangler deploy --env staging`. Watch it under the Actions tab.

**Manual (when you can't push yet, or for hotfix iteration):**

```bash
npm run build
source ~/proj/.env                       # exports CLOUDFLARE_API_TOKEN
npx wrangler deploy --env staging
```

You can also re-run the staging deploy from `main` without a new commit via Actions → "Deploy" → Run workflow → `staging`.

Visit https://staging.gtfsbuilder.net (editor) and https://staging-feeds.gtfsbuilder.net (feeds + embeds) to verify. Then iterate.

`wrangler tail gtfs-builder-staging` is your first stop when something looks off — the worker name (not the env flag) is the argument, and JSON output (`--format json`) is easier to grep.

### Schema migrations

If your branch adds a `worker/migrations/000N_*.sql` file:

```bash
# Apply to staging
npx wrangler d1 migrations apply gtfs-builder-staging --remote --env staging
```

If `migrations apply` errors on token scopes, fall back to `wrangler d1 execute gtfs-builder-staging --remote --file worker/migrations/000N_*.sql` and then mark the migration applied via `INSERT INTO d1_migrations (name, applied_at) VALUES (...)` — see `BACKEND_STATUS.md` "Deploy gotchas."

---

## Merging to main

Once staging looks good:

```bash
git checkout main
git pull origin main
git merge --ff-only feature/<branch>
git push origin main
```

Use `--ff-only` so history stays linear (when possible). If `--ff-only` refuses, it means `main` moved ahead while you were working — `git rebase main` your branch, retest if needed, then merge again.

For larger changes that you want to keep grouped, use `git merge --no-ff` to force a merge commit. For routine work, fast-forward is fine.

### Cleanup

```bash
git branch -d feature/<branch>
git push origin --delete feature/<branch>
```

---

## Deploying to production

`main` is always deployable. Deploys to prod are **tag-driven** — pushing to `main` only updates staging. Production ships when you tag a commit `prod-YYYY-MM-DD[.N]` and push the tag, which triggers `.github/workflows/deploy.yml` → the `production` job.

### Promotion checklist

Before tagging, in order:

1. **Staging is healthy.** You've actually used staging.gtfsbuilder.net for the work being shipped, not just verified it built. Eyeball `wrangler tail --env staging` for unexpected errors in the last session.
2. **Migrations applied on prod first** (manual; staging-first). See "Schema migrations on prod" below.
3. **Kill-switch flags reviewed.** If the commit being promoted relies on backend features, are `BACKEND_ENABLED` (wrangler.jsonc top-level) and `VITE_BACKEND_ENABLED` (workflow build env) flipped in sync? They're tied: the CI build of `production` uses the values in `.github/workflows/deploy.yml`; the worker reads `wrangler.jsonc`. Out-of-sync = SPA shows a feature the worker rejects, or vice versa.
4. **Promote.** Tag and push:

   ```bash
   git checkout main
   git pull origin main
   # Tag format: prod-YYYY-MM-DD, with .2, .3, … suffixes for same-day re-promotions.
   git tag prod-$(date +%Y-%m-%d)
   git push --tags
   ```

   GitHub Actions builds with `VITE_BACKEND_ENABLED=false` / `VITE_BILLING_ENABLED=false` (matching today's prod kill-switch state) and runs `wrangler deploy --env=""`.

5. **Smoke-test in an incognito window:** homepage loads, anonymous IndexedDB editor saves/loads, GTFS export downloads.
6. **Leave the tag in place.** It's your "last known good" anchor for rollback (`gh run rerun <runId>` or re-deploy from that SHA).

If the build fails mid-promotion, delete the tag (`git tag -d prod-… && git push origin :refs/tags/prod-…`) and re-tag a fixed commit. Tags should always represent successful deploys.

### Re-running prod manually

Actions → "Deploy" → Run workflow → `production`. Runs against the workflow file's `main` head (workflow_dispatch always uses the default branch). To deploy a specific older commit to prod, re-tag that SHA with a new `prod-…` name and push.

### Why tag-driven

- "Push to main" auto-deploys staging only. You can race main ahead without touching prod.
- Promoting prod is a deliberate, named act tied to a commit you can roll back to. No accidental prod shipments because someone merged a docs typo.
- The tag is the audit trail; `git tag --list 'prod-*' --sort=-creatordate | head` shows recent deploys at a glance.

### Manual fallback

If GitHub Actions is unavailable and you must ship now:

```bash
git checkout main
git pull origin main
VITE_BACKEND_ENABLED=false VITE_BILLING_ENABLED=false npm run build
source ~/proj/.env
npx wrangler deploy --env=""
```

The `--env=""` is required: with multiple environments declared in `wrangler.jsonc`, omitting the flag emits an "ambiguous environment" warning. Pass an empty string to be explicit. After a manual deploy, retro-tag the SHA so the audit trail stays intact: `git tag prod-$(date +%Y-%m-%d) <sha> && git push --tags`.

### Schema migrations on prod

Prod migrations are **manual**. Apply on prod only after staging has run with them for a while:

```bash
unset CLOUDFLARE_API_TOKEN     # OAuth token has D1 write; the API token may not
npx wrangler d1 migrations apply gtfs-builder --remote
```

### The kill-switch flags

Two flags gate the backend visibility. Both default to off in `.env.example` and `wrangler.jsonc` so an accidental deploy doesn't expose backend features:

| Flag | Where | Effect when `false` |
|---|---|---|
| `BACKEND_ENABLED` | `wrangler.jsonc` top-level `vars` | Worker runs, but the var signals "do not expose new features." (Today this is informational; the worker doesn't yet refuse `/api/*` calls based on it.) |
| `VITE_BACKEND_ENABLED` | `.env` (baked into the SPA at build time) | The SPA hides Sign in / Save / `/feeds*` / `/account` and renders `BackendDisabledPage` for those routes. The anonymous IndexedDB editor stays available. |

To **disable backend on prod**: flip `BACKEND_ENABLED` to `"false"` in `wrangler.jsonc`, build with `VITE_BACKEND_ENABLED=false npm run build`, deploy.

To **re-enable backend on prod**: flip both to `true`, ensure secrets (`RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`) and pending migrations are in place, deploy. Walk the `DEPLOY_BACKEND.md` §7 smoke-test in an incognito window.

Staging always runs with both flags `true` (a separate `env.staging` block in `wrangler.jsonc` carries `BACKEND_ENABLED=true`; staging deploys are built with whatever the local `.env` says, which today is `VITE_BACKEND_ENABLED=true`).

---

## Hotfixes

If prod breaks and you need to ship a fix without taking the rest of `main` along:

```bash
# Branch off the prod tag/commit, not main
git checkout <last-deployed-prod-sha>
git checkout -b hotfix/<short-name>
# … fix …
git commit -m "Hotfix: …"
npm run build && npx wrangler deploy --env=""
# Then bring the fix back into main
git checkout main
git pull origin main
git merge hotfix/<short-name>
git push origin main
git branch -d hotfix/<short-name>
```

In practice we haven't needed this yet because prod has stayed disabled — most fixes go through staging like everything else.

---

## API token scopes (one-time setup)

If a deploy fails with `code: 10023 (kv bindings require kv write perms)` or `code: 10000 (Authentication error)` on `/zones/.../workers/routes`, it's the `CLOUDFLARE_API_TOKEN` (in `~/proj/.env`) missing scopes. Required scopes for a smooth deploy:

- **Account** — Workers Scripts : Edit, Workers KV Storage : Edit, Workers R2 Storage : Edit, D1 : Edit, Account Settings : Read
- **Zone** (`gtfsbuilder.net`) — Workers Routes : Edit, Zone : Read

Manage at https://dash.cloudflare.com/profile/api-tokens.

For ad-hoc D1 SQL that the API token can't authorise, fall back to the OAuth token from `wrangler login`:

```bash
unset CLOUDFLARE_API_TOKEN
npx wrangler d1 execute gtfs-builder-staging --remote --command "SELECT …"
```

---

## What goes in commits

- **Subject line**: `<area>: <imperative verb phrase>`. Examples: `Auth: gate /auth/signup with Turnstile`, `Embeds: stop dropping unreferenced stops on export`, `Docs: REQUIREMENTS rewrite`. Limit ≈70 characters.
- **Body**: explain *why*. The diff shows *what*. If a fix is non-obvious or tied to a real incident, reference the symptom or the user-visible bug.
- **Footer** (when AI-assisted): `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Don't commit**: `.env`, `.dev.vars`, `node_modules/`, generated `dist/`, ad-hoc test artifacts. Confirm `git status` before `git add -A`.

---

## When something is uncertain

- "Is this safe to deploy to prod?" — if the answer isn't a confident yes, deploy to staging first, sit with it for a day, then prod.
- "Did the merge bring everything?" — `git diff origin/main..HEAD` before pushing. Run the worker tests + `npx tsx run-tests.ts` after a non-trivial merge.
- "Should this be a hotfix or a normal feature?" — hotfix when prod is bleeding right now; otherwise normal flow.
