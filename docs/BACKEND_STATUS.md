# Backend Status Snapshot

**As of 2026-05-14.** Live operational picture of the backend and embeds. This is the doc you should re-read first when you come back after a break — and the doc you should update when you change deployed state.

The high-level overview is in [`REQUIREMENTS.md`](./REQUIREMENTS.md). The reference spec is in [`BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md). Provisioning instructions are in [`DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md). Embeds spec is in [`EMBEDS_REQUIREMENTS.md`](./EMBEDS_REQUIREMENTS.md).

---

## TL;DR

- **Branch**: `main` is the source of truth. The most recent merge (2026-05-11) was the rail refactor on `exploration/right-rail-and-responsive-left` — replaces the legacy 300 px sidebar with a two-rail editor shell (responsive left nav 40–260 px + configuration right rail at 460 px), unifies the header across all pages via shared `AppBrand` + `UserMenu`, hoists the route delete dialog, adds `duplicateRoute`, and tightens responsive behaviour. Prior `staging-features` work (Turnstile, embeds, org logo, cross-workspace transfer, orphan-stop choice, export-all-stops fix, requirements rewrite) had already landed on `main`.
- **Staging is live.** Editor at https://staging.gtfsbuilder.net (worker version `e8b698fd-5e85-4405-9298-eb661bbd1fb8` as of 2026-05-11). Public feeds + embeds at https://staging-feeds.gtfsbuilder.net. First admin (`mark@eateggs.com`) is staff. One published demo feed: `bozeman-demo`.
- **Production is DISABLED.** The Worker is deployed to `gtfsbuilder.net` (worker version `59147bd4-3f6b-45fb-9dc7-eec845ac4b7e` as of 2026-05-11, ships the rail refactor); the kill switch (`BACKEND_ENABLED=false` in `wrangler.jsonc` + `VITE_BACKEND_ENABLED=false` baked into the SPA bundle) remains flipped from 2026-05-08 after a premature launch (4 user accounts had been created within 24 hours, including 2 strangers). Existing data is preserved; flip both flags to re-enable.
- **NF-40a (argon2id)** is the only spec-level technical debt that should land before broad RTAP distribution. Tracked in `BACKEND_REQUIREMENTS.md` §8.1.
- **Analytics (2026-05-14).** Cookieless page-view tracking is live: `POST /api/events/track` writes to the `event` table; `/admin/events` aggregates visits + page views grouped by inbound `?ref=` tag. No PII recorded. Beacon does not fire on prod until the kill switch is flipped (the frontend gates on `backendEnabled`). Migration 0007 is applied on both D1 databases.

---

## Environments

### Local dev

- Vite at http://localhost:5173, Worker at http://127.0.0.1:8787 via `wrangler dev --local`.
- Vite proxies `/auth`, `/api`, `/_import`, `/_demand-tiles` to the Worker.
- Local D1 + KV + R2 are miniflare-backed (no network).
- `.env` has `VITE_BACKEND_ENABLED=true`, `VITE_TURNSTILE_SITE_KEY`, `VITE_MAPBOX_TOKEN`. `.dev.vars` has `RESEND_API_KEY` + overridden `APP_ORIGIN` / `FEEDS_ORIGIN`. Both gitignored.
- `scripts/dev-seed-user.ts` creates a pre-verified user in the local D1 for quick login without email.

### Staging — LIVE

- Worker: `gtfs-builder-staging`.
- Custom domains: `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`.
- D1: `gtfs-builder-staging` (id `f62aa5db-329f-4a78-bf35-4b96f79d4392`). Migrations 0001–0007 applied.
- KV: id `ceb1f063c83a4bec9306e66288a51dc8`.
- R2: `gtfs-builder-feeds-staging` (feed blobs + org logos).
- Secrets: `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`.
- Vars: `BACKEND_ENABLED=true`, `HARD_LIMITS=false`, `MAPBOX_TOKEN=…` (public publishable token).
- Cron: `0 3 * * *` (account-deletion reaper + weekly metrics rollup).
- First admin: `mark@eateggs.com` (staff=1). Two demo orgs (`flex-builder-demo-org`, `demo-org`) and one published demo feed (`bozeman-demo`).
- Redeploy: `npm run build && wrangler deploy --env staging` (with `CLOUDFLARE_API_TOKEN` set from `~/proj/.env`).

### Production — DISABLED (kill switch active 2026-05-08)

- Worker `gtfs-builder` is deployed but the SPA renders the anonymous IndexedDB-only flow. `/login`, `/signup`, `/feeds*`, `/account`, `/admin/*` render the `BackendDisabledPage` placeholder.
- Resources provisioned and intact:
  - D1: `gtfs-builder` (id `cfb27d4e-6ba8-488e-95f9-674cc0560cbe`). Migrations 0001–0007 applied (0007 = cookieless `event` analytics table, applied 2026-05-14 ahead of the broader re-enable).
  - KV: id `da2476e5027346988e380474fa6deef5`.
  - R2: `gtfs-builder-feeds`.
  - Secrets: `RESEND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`.
  - Custom domains bound: `gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`. SSL certs provisioned.
- 4 user accounts in prod D1 (`mark@eateggs.com` staff=1, 3 others including 2 strangers from the brief launch window). 0 published feeds.
- **To re-enable**: flip `BACKEND_ENABLED=true` in `wrangler.jsonc` top-level vars; rebuild with `VITE_BACKEND_ENABLED=true` (see `.env.example`); set `TURNSTILE_SECRET_KEY` secret on prod; `wrangler deploy --env=""`. (Migrations 0001–0007 are already applied on the prod D1.)

---

## Deploy gotchas

These tripped past deploys; capturing here so the next person doesn't have to retrace:

- **API token scopes.** `CLOUDFLARE_API_TOKEN` (in `~/proj/.env`) needs **Workers KV Storage : Edit** + **Zone : Workers Routes : Edit** for the `gtfsbuilder.net` zone. The OAuth token from `wrangler login` is fine for everything except the binding-attach step on first deploy. If a future deploy fails with `code: 10023 (kv bindings require kv write perms)` or `code: 10000 (Authentication error)` on `/zones/.../workers/routes`, re-check the API token at https://dash.cloudflare.com/profile/api-tokens.
- **Empty `--env` flag.** `wrangler deploy --env=""` explicitly targets the top-level (prod) block. Without the empty value, wrangler warns about ambiguity since multiple environments are defined (top-level + `env.staging`).
- **D1 SQL via OAuth.** The OAuth login from `wrangler login` has D1 write; the API token may not. For ad-hoc SQL: `unset CLOUDFLARE_API_TOKEN; npx wrangler d1 execute gtfs-builder-staging --remote --command "…"`.
- **Migration apply via execute.** When `wrangler d1 migrations apply` fails on token scopes but `wrangler d1 execute --file <migration.sql>` works, you can apply the migration manually and then `INSERT INTO d1_migrations (name, applied_at) VALUES ('<file>', strftime('%Y-%m-%d %H:%M:%f', 'now'))` to keep wrangler's bookkeeping aligned.

---

## Outstanding work

In rough priority order. Items that have a long-form home elsewhere are linked.

### Pre-broad-rollout (before RTAP licensing)

1. **NF-40a — argon2id password hashing.** Swap PBKDF2-SHA256 @ 100k for argon2id via WASM (`hash-wasm` or equivalent). Target <150 ms per hash at `m=19MiB, t=2, p=1`. Keep `verifyPassword` dual-path so legacy PBKDF2 hashes keep authenticating until each user's first sign-in re-hashes them. Spec: `BACKEND_REQUIREMENTS.md` §8.1.
2. **transit.land catalog submission.** Currently stubbed (`status='pending'`, manual-review marker in `worker/publication/submit.ts`). Wire the real submission path once we have credentials.
3. **Hard-mode quotas.** Flip `HARD_LIMITS=true` runtime var when RTAP starts distributing — turns soft-warn into hard-block at 20/50/50 MB.

### Re-enable production checklist

1. Set the `TURNSTILE_SECRET_KEY` secret on the prod Worker (the same Turnstile site is configured for both `staging.gtfsbuilder.net` and `gtfsbuilder.net`).
2. Verify `noreply@gtfsbuilder.net` is a verified Resend sender on the prod sending domain (`AUTH_EMAIL_FROM` in `wrangler.jsonc`).
3. Flip `BACKEND_ENABLED` (worker var) and `VITE_BACKEND_ENABLED` (frontend env) to `true`.
4. Promote yourself to staff after first signup: `wrangler d1 execute gtfs-builder --remote --command "UPDATE user SET staff=1 WHERE email='mark@eateggs.com'"`.
5. Walk the smoke-test in `DEPLOY_BACKEND.md` §7 (now includes a `?ref=` analytics check).

### Phase 7 (embeds) follow-ups

Tracked in `EMBEDS_REQUIREMENTS.md` §3 — main outstanding pieces are the `widgets.js` declarative loader (7c), the headless JSON API (7e), localization, free-text alerts, per-widget impression counts, and the GTFS-RT integration (7f stretch).

### Cross-cutting

- **Parallel test flake.** Running `npm test` without `--fileParallelism=false` sporadically fails with workerd WebSocket-disconnect noise. Benign; serial runs are stable. Worth filing upstream to `cloudflare/workers-sdk` if it gets in the way.
- **Cloudflare Managed robots.txt** preempts our `/robots.txt` on the feeds origin. Net effect is the same (`Disallow: /`) so it's not blocking; can be disabled per-zone if it ever looks untidy.
- **Branch hygiene.** `staging-features` accumulates; eventually merge → `main`, drop the branch, restart from main.

---

## Where to look when something breaks

1. `wrangler tail` first. JSON format (`--format json`) is easier to grep.
2. Audit log via `GET /api/admin/audit?subjectId=<user-or-project-id>`.
3. For a stuck user: the pending_verification retry path (`worker/auth/routes.ts`) is the documented recovery — don't hand-edit the DB unless you need to.
4. Known dev/prod divergences:
   - miniflare doesn't enforce workerd's PBKDF2 iteration cap.
   - Cloudflare Managed Content robots.txt is injected at the edge, not by our Worker.
