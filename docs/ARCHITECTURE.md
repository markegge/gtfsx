# GTFS·X — Architecture & Operations

The single engineering reference for GTFS·X: system architecture, data model,
API surface, security posture, the live deployed state, and the day-to-day
build/deploy/operate runbooks. The product-feature overview (what's shipped vs
planned) lives in [`REQUIREMENTS.md`](./REQUIREMENTS.md).

This file consolidates what used to be four separate docs (`WORKFLOW.md`,
`DEPLOY_BACKEND.md`, `BACKEND_STATUS.md`, `BACKEND_REQUIREMENTS.md`). `BE-*` /
`NF-*` anchors are preserved because code comments and other notes reference them.

> **Read this first when picking the project back up.** §5 (Live environment
> state) is the "where are we now" snapshot — keep it current when you change
> deployed state.

---

## 1. System architecture

Everything runs as **one Cloudflare Worker** (`gtfs-builder`) with a static-asset
binding serving the React SPA, plus multiple custom domains. There is no separate
backend service — the same Worker serves the editor, the JSON API, auth, the
public feeds origin, the embed renderer, the community forum, and the
marketing/SSR pages.

```
www.gtfsx.com / gtfsx.com   → editor SPA + /api + /auth + /_demand-tiles + /community + marketing SSR
feeds.gtfsx.com             → public feed distribution + embed renderer + /_/orgs/<id>/logo
staging.gtfsx.com           → staging editor (parked; manual deploy only)
staging-feeds.gtfsx.com     → staging feeds origin (parked)
```

Legacy hostnames (`gtfsbuilder.net`, `gtfsstudio.net`, their `www`/`feeds`
variants) remain bound and `301` to the `gtfsx.com` equivalents (path + query
preserved). Internal Cloudflare resource names are intentionally still
`gtfs-builder*` (renaming them is not worth the churn) — see the rename history
in project memory.

### Infrastructure

| Concern | Service |
|---|---|
| Compute | Cloudflare Worker (`gtfs-builder` prod + `gtfs-builder-staging`) |
| Relational metadata (users, orgs, projects, snapshots, publications, subscriptions, forum, audit, events) | D1 |
| Rate-limit counters, KV cache | KV |
| Tiles + feed blobs | R2 — `gtfs-builder-tiles` (demand-dot PMTiles); `gtfs-builder-feeds[-staging]` (working states, snapshots, ZIPs, org logos, feed thumbnails); `gtfs-builder-forum-images` (forum attachments) |
| Transactional email | Resend |
| Bot mitigation | Cloudflare Turnstile (signup gate) |
| Payments | Stripe (live mode in prod, test mode on staging) |
| Web analytics | First-party cookieless `event` table + Cloudflare Web Analytics |
| Ad attribution | Google Ads Offline Conversion Import (see Appendix B) |

### Worker module map (`worker/`)

| Module | Responsibility |
|---|---|
| `auth/` | Signup, login, magic-link, password reset, sessions, Turnstile |
| `me/` | Current-user profile, email/password change, account delete, data export |
| `orgs/` | Organizations, membership, invitations, ownership transfer, org logos |
| `projects/` | Feed CRUD, working-state sync, snapshots, draft links, quotas, thumbnails |
| `publication/` | Canonical publish, feeds-origin serving, `feed_info.json`, ID-stability |
| `distribution/` | Mobility Database + transit.land catalog submission |
| `embeds/` | Server-rendered mini-site, per-route/stop/system-map embeds, thumbnails |
| `billing/` | Stripe checkout, customer portal, webhooks, plan catalog, feature gating |
| `forum/` | Community forum: threads/posts/upvotes/subscriptions/search/SEO/notify |
| `events/` | Cookieless page-view + funnel beacon ingest (incl. `gclid` capture) |
| `marketing/` | Marketing-site SSR (`ssr.ts`) + Google Ads OCI uploader (`ads/`) |
| `admin/` | Staff operator console (dashboard, users, orgs, audit, events, ads attribution) |
| `import/` | Catalog-search / external feed import |
| `cron/` | Scheduled tasks (account-deletion reaper, metrics rollup, OCI upload) |
| `email/` | Resend templates |
| `db/`, `util/` | DB helpers; crypto, rate-limit, CSRF, errors |
| `legacy/` | Legacy tile/catalog handlers retained from before the rebrand |

### Frontend stack

React 18 + TypeScript, Vite, Zustand (Immer middleware), Radix UI + Tailwind,
Dexie (IndexedDB), JSZip + PapaParse for GTFS, `@turf/turf` for geometry,
`react-map-gl` + `@mapbox/mapbox-gl-draw` for the editor map (Mapbox GL JS via
CDN in the embed renderer). Worker tests use `@cloudflare/vitest-pool-workers`.
GTFS parsing for large feeds runs in a Web Worker (`src/services/gtfsImport.worker.ts`).

A rendered architecture diagram is in [`architecture.svg`](./architecture.svg).

---

## 2. Data model

Schema lives in `worker/migrations/*.sql`. All IDs are ULIDs (sortable,
URL-safe). All bearer-token values are SHA-256 hashed at rest — cleartext is
delivered once.

| Entity | Purpose |
|---|---|
| `user` | One row per person; email is the identifier. `staff=1` grants `/admin`. `plan` ∈ `free`/`pro`/`agency`/`enterprise`. |
| `credential` | Auth material (password hash or OAuth identity); a user may have several. |
| `session` | Active login (HTTP-only cookie scoped to the editor origin). |
| `auth_token` | Single-use hashed tokens: `verify_email`, `magic_link`, `password_reset`, `invitation`. |
| `organization` + `organization_membership` | Shared workspace + **many-to-many** user↔org with per-org role (critical for consultants). Includes org brand-logo columns. |
| `feed_project` | One feed. Owned by a user or org (`owner_type`+`owner_id`); slug unique per owner; `brand_primary_color`; thumbnail pointer. |
| `project_membership` *(future, BE-95)* | Per-project access inside an org without org-wide visibility. Not built. |
| `feed_snapshot` | Immutable point-in-time editor state. Two R2 blobs (gzipped JSON + rendered ZIP) + a summary row. *(Renamed from `feed_version` in 0012.)* |
| `draft_link` | Unguessable hashed token → a specific snapshot; time-limited, revocable. |
| `publication` / `publication_history` | Canonical-publish pointer (≤1 live snapshot per project) + append-only publish/unpublish/rollback log. |
| `project_catalog_submission` | Opt-in record per (project, catalog) for Mobility DB / transit.land; stores external feed id. |
| `project_rt_feed` | GTFS-RT feed URLs forwarded in `feed_info.json`. `managed=0` = externally-hosted feeds the agency registers; `managed=1` = the auto-wired pointer at our own generated Service Alerts feed (RT coexistence, BE-92). |
| `service_alert` | One GTFS-Realtime Service Alert per row, project-scoped (BE-90). Rendered to protobuf on demand; decoupled from publish. |
| `subscription` | Stripe-synced plan/status/renewal for a user or org. |
| `forum_*` | `forum_category`, `forum_thread`, `forum_post`, `forum_post_upvote`, `forum_subscription`, `forum_user_state`, `forum_image`, FTS5 `forum_search`. |
| `audit_event` | Append-only log of significant actions. |
| `event` | Cookieless page-view + funnel log (`kind`, `ref`, `gclid`, country, per-tab session id). No IP/UA/user-id. |

### Migrations

| File | Adds |
|---|---|
| `0001_auth` | `user`, `credential`, `session`, `auth_token`, `audit_event` |
| `0002_projects` | `organization`, `organization_membership`, `feed_project`, `feed_snapshot` (orig. `feed_version`), `draft_link` |
| `0003_distribution` | `publication`, `publication_history`, `project_catalog_submission`, `project_rt_feed` |
| `0004_branding` | `feed_project.brand_primary_color` |
| `0005_org_branding` | `organization.brand_logo_*` |
| `0006_billing` | `user`/`organization` plan columns; `subscription`; Stripe customer ids |
| `0007_events` | `event` table (cookieless page-view analytics) |
| `0008_forum` | `forum_thread`/`_post`/`_post_upvote`/`_subscription`/`_user_state` |
| `0009_consolidate_consultant` | Migrate dropped `consultant`/`consultant_firm` plans → `pro`/`team` |
| `0010_forum_images` | `forum_image` attachments |
| `0011_forum_categories_and_search` | Forum categories + FTS5 `forum_search` |
| `0012_rename_version_to_snapshot` | `feed_version`→`feed_snapshot`; `version_id`→`snapshot_id` on `draft_link`/`publication`/`publication_history` |
| `0013_event_kinds` | Funnel: `event.kind` ∈ `page_view`/`editor_loaded`/`feed_exported`/`paywall_view` + `label` |
| `0014_gclid` | `event.gclid` for Google Ads attribution |
| `0015_event_oci_upload` | `event.oci_uploaded_at` — Google Ads Offline Conversion Import bookkeeping |
| `0016_feed_thumbnail` | Route-map thumbnail pointers on `feed_project` (Mapbox Static Images → R2; og:image) |
| `0017_rename_team_plan_to_agency` | Internal plan id `team`→`agency` (display name changed at pricing-v2; this aligns the data) |
| `0018_service_alerts` | `service_alert` (GTFS-RT Service Alerts authoring, BE-90); `project_rt_feed.managed` column for RT coexistence (BE-92) |

---

## 3. API surface

JSON over cookie-auth on the editor origin; fully public reads on the feeds
origin. This list is the source of truth.

### Editor origin (auth-gated except `/auth/*`, `/api/events/track`, billing webhooks)

| Method & Path | Purpose |
|---|---|
| `POST /auth/signup` · `/auth/verify` · `/auth/login` | Signup (Turnstile-gated) / verify email / password login |
| `POST /auth/magic-link/request` · `GET /auth/magic-link/consume` | Magic-link request / consume |
| `POST /auth/logout` · `/auth/logout-all` | End current / all sessions |
| `POST /auth/password-reset/request` · `/auth/password-reset/confirm` | Forgot-password flow |
| `GET/PATCH /api/me`, `POST /api/me/email/change`, `POST /api/me/password`, `DELETE /api/me`, `GET /api/me/export` | Profile, email/password change, soft-delete, data export |
| `GET/POST /api/orgs`, `GET/PATCH/DELETE /api/orgs/:id`, `*/logo`, `*/invitations[...]`, `*/members/:uid`, `*/transfer`, `/api/orgs/invitations/accept` | Org lifecycle, branding, membership, invitations, transfer |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, `*/transfer`, `*/working-state` | Project CRUD + workspace transfer + working-state sync (If-Match) |
| `POST/GET /api/projects/:id/snapshots`, `*/snapshots/:sid/state`, `*/restore`, `DELETE *` | Snapshots (list/create/fetch/restore/delete) |
| `POST/GET/DELETE /api/projects/:id/draft-links[/:tokenHash]` | Draft review links |
| `POST /api/projects/:id/publish` · `/unpublish` · `/publish/rollback` · `GET /publish/history` | Canonical publish lifecycle |
| `POST /api/projects/:id/catalog-submissions`, `PUT /api/projects/:id/rt-feeds`, `GET /api/projects/:id/audit` | Distribution opt-in, external RT-feed registration, per-project audit |
| `GET/POST/PUT/PATCH/DELETE /api/projects/:id/alerts[/:alertId]`, `GET */alerts/preview.json`, `POST */alerts/rt-feed` | Service Alerts authoring (Agency+; BE-90) |
| `POST /api/projects/import` | Anonymous→signed-in bulk import |
| `POST /api/billing/checkout` · `/portal` · `POST /api/billing/webhooks/stripe` · `GET /api/billing/me` · catalog | Stripe checkout/portal/webhooks; plan + usage |
| `GET /community/*`, `/api/forum/*` | Forum SSR pages + forum JSON API (threads/posts/upvotes/subscriptions/search/profile/uploads) |
| `POST /api/events/track` | Cookieless page-view/funnel beacon (no auth; CSRF + rate-limited; captures `?ref=`/`gclid`) |
| `GET /api/admin/*` | Staff operator console (404 to non-staff): stats, users, orgs, audit, events summary, ads attribution |

### Feeds origin (no auth)

`GET feeds.*/<slug>/gtfs.zip` · `/feed_info.json` · `/alerts.pb` · `/alerts.json` ·
`/draft/<token>.zip` · `/<slug>` (mini-site) · `/embed/route/<id>` ·
`/embed/stop/<id>` · `/embed/system-map` · `/_/orgs/<org_id>/logo` ·
`/robots.txt` (`Disallow: /`).

---

## 4. Auth, authorization & non-functional posture

**Auth (BE-1..16):** email+password and magic-link both ship; new accounts are
`pending_verification` until verified; password reset via single-use token;
`HttpOnly`/`Secure`/`SameSite=Lax` sessions (30 d idle / 90 d absolute) with
logout-all; per-IP+per-email rate limits; Turnstile on `/auth/signup`. Google
OAuth (BE-16) is deferred.

**Authorization (BE-20..22):** role matrix `owner` > `admin` > `editor` >
`viewer`; many-to-many org membership; `staff=1` → `/admin`; no public read of
editor state (published feeds public by design, drafts public-but-unguessable).

**Security (NF-40..45):** passwords are PBKDF2-HMAC-SHA256 @ 100k iterations
(workerd ceiling), stored self-describing as `pbkdf2$<iter>$<salt>$<hash>`.
**NF-40a — migrate to argon2id via WASM (dual-path verify) before broad RTAP
distribution — is the one outstanding security debt** (tracked as a GitHub
issue). All bearer tokens ≥128-bit, single-use, hashed at rest. CSRF via
required `X-GB-Client` header + `SameSite=Lax`. Auth/publish endpoints
rate-limited. Audit log covers login/publish/delete/member/transfer/admin
actions.

**Privacy (NF-50..54):** PII limited to email, display name, session IP/UA, and
feed contents. Data export at `GET /api/me/export`. Hard-purge 30 d after
account deletion (cron). Analytics are cookieless — `event` rows carry
`path`/`ref`/`gclid`/country/per-tab id only; `?ref=` is stripped from the URL
on capture.

**Performance (NF-60..63):** edge-cached feed URLs (p95 < 100 ms); editor API
p95 < 500 ms; idempotent working-state save; atomic publish (D1 pointer flips
only after the R2 object is fully written).

**Observability (NF-70..73):** Workers Analytics + first-party page-view/funnel
analytics at `/admin/events`. **NF-72 baseline done** — native Cloudflare Workers
Observability is enabled (`wrangler.jsonc` `observability`) and every worker error
sink logs through `worker/util/redact.ts` (`errorDetail`/`redactPii`: scrubs
emails, auth headers, Stripe keys, the session cookie, sensitive query params). A
richer Sentry error-aggregation upgrade is the remaining open part (issue #27).
**NF-71 (per-project usage metrics for owners) remains open** (GitHub issue).

**GTFS-Realtime Service Alerts (BE-90..93):** Agency+ editors author Service
Alerts (`worker/projects/alerts.ts`, gated by `requireOwnerFeature('service_alerts')`
+ project `editor`) stored one-row-per-alert in `service_alert` (migration 0018),
decoupled from publish. **BE-90** authoring CRUD + activate/preview; **BE-91**
public serving at `feeds.*/<slug>/alerts.pb` / `.json` — a `FeedMessage` v2.0 /
FULL_DATASET rendered on demand (`worker/alerts/render.ts`, pure; uses
`gtfs-realtime-bindings`) from currently-active rows, `max-age=30`. **BE-92** RT
coexistence (Option A): authoring upserts a managed `project_rt_feed` row
(`kind='alerts'`, `managed=1`) so `feed_info.json` advertises our feed; managed
rows are excluded from the publish ID-stability warning and the external-feed
editor, and never coexist with an external alerts feed (UI forces a choice).
**BE-93 (backlog):** multi-language alert text — v1 emits a single-language
`TranslatedString`, so adding languages needs no wire-format change.

Design rationale is preserved in the decisions appendix of the archived
`BACKEND_REQUIREMENTS.md` (`docs/archive/`).

---

## 5. Live environment state

**As of 2026-05-30.** Keep this section current when deployed state changes.

### Production — LIVE

- Worker `gtfs-builder`. SPA serves the full editor + auth + billing + forum.
- **Backend + billing live since 2026-05-15.** `wrangler.jsonc` top-level vars:
  `BACKEND_ENABLED=true`, `BILLING_ENABLED=true`, `HARD_LIMITS=false`. (Originally
  disabled 2026-05-08 after a premature launch; re-enabled 2026-05-15 with
  live-mode Stripe in a coordinated deploy.)
- D1 `gtfs-builder` (`cfb27d4e-…`), KV (`da2476e5…`), R2 `gtfs-builder-feeds`
  + `gtfs-builder-forum-images`, tiles in `gtfs-builder-tiles`. Migrations
  0001–0018 applied.
- **GTFS-Realtime Service Alerts (BE-90..93)** live since 2026-05-30 — Agency+
  authoring under `/api/projects/:id/alerts`, public serving at
  `feeds.*/<slug>/alerts.pb` + `/alerts.json`.
- **Error reporting (NF-72 baseline)** live since 2026-05-30 — native Workers
  Observability enabled (`observability.enabled`, `head_sampling_rate: 1`); worker
  error sinks redact PII via `worker/util/redact.ts`. Sentry aggregation upgrade
  deferred (issue #27).
- **Pricing/signup consolidation** live since 2026-05-30 — the former `/upgrade`
  tier-picker (`WelcomePlanPage`) is merged into `/pricing`, which now renders one
  set of plan cards for both the public marketing view and authenticated checkout
  (Stripe / Agency org-create / billing-portal downgrade). `/upgrade` and
  `/welcome/plan` 301 → `/pricing` (query preserved; see `LEGACY_ALIAS_REDIRECTS`).
  Logged-out plan CTAs go to `/signup?next=/pricing?plan=…`, so checkout resumes
  automatically after email verification with no second plan choice; the
  post-verify redirect lands on `/pricing?source=welcome`.
- Secrets: `RESEND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`,
  `TURNSTILE_SECRET_KEY`, `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SIGNING_SECRET` (live).
- Stripe: live-mode Price IDs (`STRIPE_PRICE_PRO_*`, `STRIPE_PRICE_AGENCY/TEAM_*`),
  portal config, webhook `→ /api/billing/webhooks/stripe`. Pricing v2 (Agency
  $299/mo · $2,499/yr) is live.
- `mark@eateggs.com` is staff + enterprise. Pre-launch D1 backup under
  `backups/` (gitignored).
- **Rollback:** `BILLING_ENABLED=false` disables paid checkout/portal but leaves
  auth + editor up; `BACKEND_ENABLED=false` (with SPA rebuild) hides the whole
  backend. Both are `wrangler.jsonc` edits + redeploy. The two `*_ENABLED` flags
  and their `VITE_*` build-env twins must move in lockstep (see project memory).

### Staging — PARKED (since 2026-05-16)

Infra still exists (`gtfs-builder-staging`, `staging[-feeds].gtfsx.com`, separate
D1/KV/R2) but is **not auto-deployed**. Use as a manual rehearsal env for risky
changes: `npm run build && unset CLOUDFLARE_API_TOKEN && npx wrangler deploy --env staging`.
Staging runs test-mode Stripe and both `*_ENABLED` flags true.

### Deploy gotchas (these tripped past deploys)

- **API token scopes.** `CLOUDFLARE_API_TOKEN` (in `~/proj/.env`) needs Workers
  KV Storage: Edit + Zone Workers Routes: Edit for `gtfsx.com`. On
  `code 10023`/`10000` errors, prefer the OAuth token: `unset CLOUDFLARE_API_TOKEN`.
- **`--env=""`** explicitly targets the prod (top-level) block; without it
  wrangler warns about ambiguity (because `env.staging` is also declared).
- **D1 SQL via OAuth.** `unset CLOUDFLARE_API_TOKEN` then `wrangler d1 execute …`.
  If `migrations apply` fails on scopes, apply via `execute --file` then
  `INSERT INTO d1_migrations(name, applied_at) …`.
- **Stale asset manifest after auto-deploy.** A CF Workers Builds deploy can go
  "succeeded" yet leave a follow-up Worker version active bound to the *previous*
  asset bundle (observed 2026-05-30 on a docs/content push). **Always verify the
  live `index-*.js` hash changed** (§7 verify step); if not, use the manual
  fallback deploy.
- **Resend sending domain.** The prod key must be scoped to `gtfsx.com` (a
  legacy `gtfsbuilder.net`-scoped key fails signup email with "domain not verified").

---

## 6. Provisioning runbook (one-time)

Run from the repo root with `wrangler` (via `npm install`).

```bash
# Resources
wrangler d1 create gtfs-builder           # paste database_id into wrangler.jsonc
wrangler kv namespace create KV           # paste id into kv_namespaces[0].id
wrangler r2 bucket create gtfs-builder-feeds
# gtfs-builder-tiles + gtfs-builder-forum-images already exist.
# Staging mirrors: append "-staging"; paste ids into the env.staging block.

# Migrations
wrangler d1 migrations apply gtfs-builder --remote                 # prod
wrangler d1 migrations apply gtfs-builder-staging --remote --env staging
wrangler d1 migrations apply gtfs-builder --local                  # dev

# Secrets (repeat with --env staging)
wrangler secret put RESEND_API_KEY
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SIGNING_SECRET
# MOBILITY_DATABASE_REFRESH_TOKEN already set on both envs.
```

**Resend:** point at `gtfsx.com` (add SPF/DKIM/DMARC); `AUTH_EMAIL_FROM` must
match a verified sender (`GTFS·X <noreply@gtfsx.com>` prod). **Turnstile:**
Managed mode, hostnames `gtfsx.com`/`www`/`staging`; site key → `.env`
`VITE_TURNSTILE_SITE_KEY`, secret → Worker secret. **Stripe:** create
Products/Prices, set Price-ID + portal-config vars, register the webhook
endpoint, store the signing secret.

### Runtime flags (`wrangler.jsonc` `vars`; edit + redeploy)

| Var | Purpose |
|---|---|
| `BACKEND_ENABLED` | `"false"` hides sign-in/save/`/feeds*`/`/account`. Kill switch — pair with `VITE_BACKEND_ENABLED`. |
| `BILLING_ENABLED` | `"false"` disables paid checkout/portal (auth + editor stay up). Pair with `VITE_BILLING_ENABLED`. |
| `HARD_LIMITS` | `"true"` flips plan quotas from soft-warn to hard reject (for post-RTAP licensing). |
| `APP_ORIGIN` / `FEEDS_ORIGIN` | Base URLs for emailed links / published feeds. |
| `MAPBOX_TOKEN` | Public Mapbox token for the embed renderer + static thumbnails (== `VITE_MAPBOX_TOKEN`). |

---

## 7. Git & deploy workflow

```
main = source of truth; stays deployable. Feature branches are short-lived,
branched off main, merged via --ff-only. Every push to main is a prod deploy
(Cloudflare Workers Builds runs `npm run build` with the VITE_* build-env vars,
then `wrangler deploy`; live in ~1 minute).
```

Branch naming: `feature/` · `bug/` · `docs/` · `chore/`. There is no long-lived
develop branch and no tag-driven promotion. Staging is a manual rehearsal env
(§5), not part of the cadence.

### Local dev

```bash
npm run dev                              # Vite at :5173 (proxies /api,/auth,/_import,/_demand-tiles → :8787)
npx wrangler dev --port 8787 --local     # Worker (miniflare D1/KV/R2)
npx tsx scripts/dev-seed-user.ts you@test.com "You" hunter2-hunter2   # pre-verified local user
```
`.env` carries `VITE_BACKEND_ENABLED`/`VITE_BILLING_ENABLED`/`VITE_TURNSTILE_SITE_KEY`/
`VITE_MAPBOX_TOKEN`; `.dev.vars` carries `RESEND_API_KEY` + overridden origins. Both gitignored.

### Tests

```bash
npx tsx run-tests.ts                          # editor integration tests
npx vitest run --fileParallelism=false        # worker tests (serial — workerd WS-disconnect flake under parallel)
npx tsc -p tsconfig.app.json --noEmit         # frontend typecheck
npx tsc -p tsconfig.worker.json --noEmit      # worker typecheck
```

### Shipping to prod (pre-push checklist)

1. Tests + both typechecks pass locally.
2. **Migrations applied on prod first** (manual): `unset CLOUDFLARE_API_TOKEN; npx wrangler d1 migrations apply gtfs-builder --remote`.
3. **Kill-switch pair in sync** — `BACKEND_ENABLED`/`BILLING_ENABLED` in `wrangler.jsonc` match their `VITE_*` twins in CF Workers Builds → Settings → Variables.
4. `git push origin main` → CF Workers Builds deploys.
5. **Verify the new build went live** (a "succeeded" build doesn't guarantee the active asset manifest):
   ```bash
   curl -sS https://www.gtfsx.com/ | grep -oE 'index-[a-zA-Z0-9_-]+\.js'   # must differ from the previous bundle
   ```
   If unchanged, use the manual fallback.
6. Smoke-test in incognito (homepage, anonymous IndexedDB editor save/load, ZIP export; if backend on, `/login` shows the form not the placeholder).

### Manual fallback deploy (CF Builds broken, or to ship a specific local SHA)

```bash
git pull origin main
VITE_BACKEND_ENABLED=true VITE_BILLING_ENABLED=true npm run build
unset CLOUDFLARE_API_TOKEN
npx wrangler deploy --env=""
```

### Hotfix

Branch off the deployed SHA (not main), fix, `npm run build && npx wrangler deploy --env=""`,
then merge the fix back into main.

---

## 8. Operator runbook

In an incognito window against the deployed origin, **smoke test:** signup
(Turnstile + verify email) → verify link → password login → magic link → forgot
password → account settings (name/email/password/logout-all) → create+save+reload
a project → snapshot/restore/delete → create org + switch workspace + move
project → upload org logo → publish + visit `feeds.*/<slug>/gtfs.zip`, `/<slug>`,
`/embed/route/<id>`, `/embed/system-map`, `/embed/stop/<id>` → anonymous→signin
import → `?ref=smoke-test` appears in `/admin/events`.

| Task | Command |
|---|---|
| Tail logs | `wrangler tail gtfs-builder --format json` (pass the worker name, not `--env`) |
| One-off query | `unset CLOUDFLARE_API_TOKEN; wrangler d1 execute gtfs-builder --remote --command "SELECT …"` |
| Disable a user | `… UPDATE user SET status='disabled' WHERE email='…'` |
| Revoke a user's sessions | `… UPDATE session SET revoked_at=unixepoch()*1000 WHERE user_id='…'` |
| Promote to staff | `… UPDATE user SET staff=1 WHERE email='…'` |
| Active users (30d) | `… SELECT COUNT(DISTINCT user_id) FROM session WHERE last_used_at > (unixepoch()-2592000)*1000` |
| Reset rate limits | `scripts/reset-rate-limits.sh [staging|prod|local]` |
| Purge old events | `… DELETE FROM event WHERE ts < (unixepoch()-15552000)*1000` (>180 d) |

When something breaks: `wrangler tail` first; then the audit log
(`GET /api/admin/audit?subjectId=…`); for a stuck signup use the
pending-verification retry path in `worker/auth/routes.ts` rather than editing D1.
Known dev/prod divergences: miniflare doesn't enforce workerd's PBKDF2 cap;
Cloudflare Managed `robots.txt` is injected at the edge on the feeds origin.

---

## 9. Outstanding engineering debt

The product backlog (undeveloped features) lives in GitHub issues. The
infra/tech-debt items that originated as `NF-*` anchors:

- **NF-40a** — argon2id password hashing (dual-path verify) before broad RTAP rollout.
- **NF-72** — error reporting (Sentry / Logpush sink with PII redaction).
- **NF-71** — per-project usage metrics surfaced to feed owners.
- **transit.land** catalog submission is stubbed (`status='pending'`) in
  `worker/distribution/` — wire the real API when credentials land.
- **HARD_LIMITS** flip from soft-warn to hard-reject is gated on the RTAP
  licensing launch.

---

## Appendix A — Demand-dot tiles: yearly regen runbook

The nationwide demand-dot layer (`us-2026b` archive in `gtfs-builder-tiles`,
served at `/_demand-tiles/<archive>/{z}/{x}/{y}.pbf`, wired into
`DemandDotsLayer.tsx`) is regenerated manually once a year (~January, after the
December ACS 5-year release). Display-only; not wired into the analysis pipeline.

```bash
# Prereqs: uv, tippecanoe (brew install tippecanoe), CLOUDFLARE_API_TOKEN with R2 Object Write, CENSUS_API_KEY
cd /Users/clippy2/proj/gtfsx
YEAR=2027; ACS_YEAR=2025
rm -rf demand-dots/cache/*                        # 1. clear cache
# 2-3. bump ACS_YEAR and the TIGER year in demand-dots/build_dots.py
mkdir -p tiles/ldjson                              # 4. build all states (≤4 parallel)
for st in AL AK AZ … WY PR; do
  (cd demand-dots && uv run python build_dots.py --state $st --output ../tiles/ldjson/dots_$st.ldjson --ldjson) &
  while [ $(jobs -rp | wc -l) -ge 4 ]; do sleep 5; done
done; wait
cat tiles/ldjson/*.ldjson | tippecanoe --output=tiles/us-${YEAR}.pmtiles \
  --layer=demand --minimum-zoom=4 --maximum-zoom=15 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping --base-zoom=12 --read-parallel --force   # 5
npx wrangler r2 object put gtfs-builder-tiles/us-${YEAR}.pmtiles --file=tiles/us-${YEAR}.pmtiles \
  --remote --content-type=application/vnd.pmtiles --cache-control="public, max-age=31536000, immutable"  # 6
# 7. bump the ARCHIVE constant in src/components/map/DemandDotsLayer.tsx, commit, push (CI deploys)
# 8. verify: toggle the layer, spot-check 3 metros. 9. (later) delete the prior year's pmtiles.
```

Sanity checks: total dots within ~5% YoY; file size within ~10%. Known
breakages: LODES lags ACS ~1 yr (label only); TIGER block system changes every
decennial (next 2030); validate ACS variable IDs still return data; bump
`LODES_BASE` if LODES9 ships. Full decision log preserved in the archived
`demand-dots-nationwide-plan.md`.

## Appendix B — Google Ads offline-conversion (OCI) pipeline

Cookieless ad attribution is shipped: the SPA captures `?gclid=` into the
`event` table (`worker/events/routes.ts`, `src/services/trackBeacon.ts`,
migration 0014); a daily cron uploads conversion events to Google Ads via the
Offline Conversion Import API (`worker/marketing/ads/oci.ts`, dedup-tracked via
`event.oci_uploaded_at`, migration 0015); `/admin` surfaces ads-attribution
status. Campaign strategy + the original spec are in the archived
`GOOGLE_ADS_PLAN.md` (referenced by the 0015 migration comment).
