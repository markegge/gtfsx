# Backend Implementation Status

**As of 2026-05-07.** This document is the "where we are now" snapshot. Companion to:

- `BACKEND_REQUIREMENTS.md` — the feature spec (what we're building).
- `BACKEND_IMPLEMENTATION_PLAN.md` — the phased plan (how we're building it).
- `DEPLOY_BACKEND.md` — the one-page provisioning runbook.

If you're picking this up cold, read the TL;DR, then §"How to resume" before touching code.

---

## 0. TL;DR

- **Branch**: `backend-phases-1-2` (24 commits ahead of `main`, pushed). PR open but not merged: https://github.com/markegge/gtfs_builder/pull/new/backend-phases-1-2
- **All six phases + the admin panel are code-complete.** 181/181 Vitest integration tests pass (serial runs; parallel has a pre-existing workerd flake).
- **Staging is deployed and live.** Editor at https://staging.gtfsbuilder.net/, public feeds at https://staging-feeds.gtfsbuilder.net/`<slug>`/gtfs.zip. First admin (`mark@eateggs.com`) is provisioned.
- **Production is deployed and live as of 2026-05-07.** Editor at https://www.gtfsbuilder.net/, public feeds at https://feeds.gtfsbuilder.net/`<slug>`/gtfs.zip. First admin (`mark@eateggs.com`) is provisioned. No published feeds yet.
- Phase 1–6 in production additionally includes: explicit Save button (replaces silent autosave), Save-As dialog with workspace picker, beforeunload guard on unsaved changes. See `docs/EMBEDS_REQUIREMENTS.md` for the not-yet-built Phase 7 (embeddable maps & schedules).
- Three technical follow-ups flagged in code + docs (see §5). Of those, **NF-40a (argon2id)** should land before RTAP broad distribution.

---

## 1. What shipped

### Phase 1 — Auth
| | |
|---|---|
| Signup + email verify + password login | ✅ `worker/auth/routes.ts`, `src/components/auth/*` |
| Magic link round-trip | ✅ |
| Password reset (request + confirm) | ✅ |
| Logout + logout-all | ✅ |
| Session cookies (HTTP-only, Secure, SameSite=Lax) | ✅ `worker/auth/session.ts` |
| Rate limits (per IP + per email), KV-backed | ✅ `worker/util/rateLimit.ts` |
| CSRF defense (X-GB-Client header) | ✅ `worker/auth/middleware.ts` |
| Password hashing | ⚠️ PBKDF2-SHA256 @ 100k (workerd cap; argon2id is NF-40a follow-up) |
| Account settings: profile, change-email, change-password, soft-delete | ✅ `worker/api.ts` + `src/components/auth/AccountSettingsPage.tsx` |
| Google OAuth | ⏳ deferred to v1.1 per decision §12 of requirements |

### Phase 2 — Feed projects
| | |
|---|---|
| Project CRUD | ✅ `worker/projects/routes.ts` |
| Working-state sync (If-Match optimistic concurrency) | ✅ |
| Version snapshot + restore + delete | ✅ |
| Anonymous → signed-in IndexedDB import | ✅ |
| Quotas (20 projects / 50 versions / 50 MB) | ✅ soft-warn; flip `HARD_LIMITS=true` to enforce |
| My Feeds page + server-backed editor route | ✅ `src/components/feeds/MyFeedsPage.tsx`, `src/App.tsx` |
| Version history panel ("Activity" tab) | ✅ `src/components/versions/VersionHistoryPanel.tsx` |
| Conflict dialog on stale saves | ✅ `src/components/versions/ConflictDialog.tsx` |

### Phase 3 — Publication
| | |
|---|---|
| Publish with validation gate (errors block, warnings optional) | ✅ |
| Unpublish + rollback | ✅ |
| Draft URLs with unguessable tokens, revocable | ✅ |
| Public feed distribution (ETag, Last-Modified, 304, Content-Disposition) | ✅ `worker/publication/feeds.ts` |
| `feed_info.json` sidecar | ✅ |
| `robots.txt` disallow on feeds subdomain | ✅ |
| PublishPanel + DraftLinksPanel + history view | ✅ `src/components/publication/*` |

### Phase 4 — Organizations
| | |
|---|---|
| Org CRUD + soft-delete cascades to owned projects | ✅ `worker/orgs/routes.ts` |
| Memberships (owner / admin / editor / viewer), last-owner protection | ✅ |
| Invitation flow (email, accept, rescind) | ✅ |
| Ownership transfer | ✅ |
| Role-scoped project access (replaces the old user-only `requireOwnedProject`) | ✅ |
| Workspace switcher in TopBar + org settings page + accept-invite page | ✅ `src/components/orgs/*` |

### Phase 5 — Distribution
| | |
|---|---|
| Catalog submission opt-in UI + auto-submit on publish | ✅ |
| Mobility Database integration (real API call) | ✅ `worker/publication/submit.ts` + `worker/distribution/mobility.ts` |
| transit.land integration | ⚠️ STUB — status=pending, manual-review marker (§5) |
| RT feed URL registration | ✅ |
| ID-stability check on publish (`rt_breakage` 409 when removing referenced ids) | ✅ `worker/publication/idStability.ts` |
| Distribution checklist UI (Google/Apple external links) | ✅ `src/components/distribution/DistributionPanel.tsx` |
| Global `gb:rt-breakage` event → `RtBreakageDialog` | ✅ |

### Phase 6 — Polish
| | |
|---|---|
| Per-project + per-user audit log endpoints | ✅ `worker/api.ts`, `worker/projects/routes.ts` |
| ProjectAuditPanel ("Activity" bottom-tab) + Recent activity on Account page | ✅ |
| Data export (GET /api/me/export) — streams ZIP | ✅ `worker/me/export.ts` |
| Account deletion cron — hard-purge 30 days after soft-delete | ✅ `worker/cron/tasks.ts` |
| /api/me/usage + `usage` bag on /api/me | ✅ `worker/me/usage.ts` |
| Weekly metrics rollup (KV-cached for admin dashboard) | ✅ |

### Admin panel (v1.1 spec, built in this cycle)
| | |
|---|---|
| Dashboard counters + trailing-8-week sparkline tables | ✅ `src/components/admin/AdminDashboardPage.tsx` |
| User list + filter + disable/enable + resend verify + soft-delete | ✅ |
| Impersonation (+ banner + exit) | ✅ `src/components/admin/ImpersonationBanner.tsx` |
| Org list + member role management | ✅ |
| Audit view (filtered + paginated + CSV export) | ✅ |
| Routing gated on `currentUser.staff` (renders 404 otherwise) | ✅ |

### Test harness
- **`@cloudflare/vitest-pool-workers`** (`vitest.config.ts`) with isolated D1/KV/R2 per test file.
- **181 integration tests** across 31 files. Serial runs are stable (`npm test -- --fileParallelism=false`). Parallel runs flake on a workerd concurrency bug — unrelated to application code.
- **Resend mock** via `globalThis.fetch` spy (`worker/__tests__/_setup.ts`), with `simulateSendFailure()` for send-failure paths.
- **Test-harness gotcha**: miniflare is looser than workerd. Two real bugs slipped past the suite and were caught in staging (`wrangler tail`): the PBKDF2-600k iteration cap and the `FEEDS_ORIGIN` hostname collision. Keep `wrangler tail` in the first-look toolkit when a staging flow misbehaves.

---

## 2. Environments

### Local dev
- Vite at http://localhost:5173, Worker at http://127.0.0.1:8787 via `wrangler dev --local`.
- Vite proxies `/auth`, `/api`, `/_import`, `/_demand-tiles` to the Worker.
- Local D1 + KV + R2 are miniflare-backed (no network).
- `.env` has `VITE_BACKEND_ENABLED=true` + `VITE_MAPBOX_TOKEN`. `.dev.vars` has the Resend key + overridden APP/FEEDS origins. Both gitignored.
- `scripts/dev-seed-user.ts` creates a pre-verified user directly in the local D1 for quick login without email.

### Staging — LIVE
- Worker: `gtfs-builder-staging` (Cloudflare account: `mark@eateggs.com`).
- Custom domains: `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`.
- D1: `gtfs-builder-staging` (id `f62aa5db-329f-4a78-bf35-4b96f79d4392`). All three migrations applied.
- KV: id `ceb1f063c83a4bec9306e66288a51dc8`.
- R2: `gtfs-builder-feeds-staging`.
- Secrets set: `RESEND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`.
- Cron registered: `0 3 * * *` (daily 03:00 UTC — account-deletion reaper + metrics rollup).
- First admin bootstrapped: `mark@eateggs.com` (staff=1, active).
- Redeploy with `wrangler deploy --env staging` from the project root after `npm run build`.

### Production — LIVE (as of 2026-05-07)
- Worker: `gtfs-builder` (Cloudflare account: `mark@eateggs.com`). Latest version `4715fe36-2b1b-4990-8685-7a72224c81fa`.
- Custom domains: `gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`. All three Worker routes are bound; DNS resolves; SSL cert provisioned.
- D1: `gtfs-builder` (id `cfb27d4e-6ba8-488e-95f9-674cc0560cbe`). All three migrations applied; DB started empty (no staging data carried over).
- KV: id `da2476e5027346988e380474fa6deef5`.
- R2: `gtfs-builder-feeds` (separate from staging's `gtfs-builder-feeds-staging`).
- Secrets set: `RESEND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`.
- Cron registered: `0 3 * * *` (daily 03:00 UTC).
- First admin bootstrapped: `mark@eateggs.com` (staff=1, active).
- Resend sender for prod: `noreply@gtfsbuilder.net` (verified). Staging uses `staging@gtfsbuilder.net`.
- Redeploy with `wrangler deploy --env=""` (empty `--env` flag explicitly targets the top-level prod block; without it wrangler warns about ambiguity since multiple environments are defined).
- **Token gotcha for redeploys**: `CLOUDFLARE_API_TOKEN` (in `~/proj/.env`) needs **Workers KV Storage : Edit** + **Zone : Workers Routes : Edit** for the `gtfsbuilder.net` zone. The OAuth token from `wrangler login` was missing R2 write at first deploy — falling back to the API token + adding those scopes worked. If a future deploy fails with `code: 10023 (kv bindings require kv write perms)` or `code: 10000 (Authentication error)` on `/zones/.../workers/routes`, re-check the API token scopes at https://dash.cloudflare.com/profile/api-tokens.

---

## 3. Repo topology

Where to look when a thing breaks.

### Backend (Cloudflare Worker + D1 + R2 + KV)
```
worker/
  index.ts               # entry. dispatches feeds.*, tiles, /auth, /api, else → SPA
  env.ts                 # Env interface + Hono AppContext variable type
  api.ts                 # Hono router for /api; /me endpoints are inline,
                         # /projects /orgs /admin are mounted subrouters
  auth/
    routes.ts            # /auth/signup /login /verify /verify-resend /magic-link
                         # /password-reset /logout — THIS is the one that has
                         # signup's pending_verification retry + rollback logic
    session.ts           # cookie + token hashing; resolveSession / revoke
    tokens.ts            # auth_token table CRUD (verify / magic / reset / invitation)
    middleware.ts        # sessionMiddleware / requireAuth / requireStaff / CSRF header
  projects/
    routes.ts            # /api/projects/* — CRUD, sync, versions, publish, draft,
                         # catalog-submissions, rt-feeds, audit. Uses the org-aware
                         # requireOwnedProject helper.
    quotas.ts
    r2.ts                # R2 key builders
    slug.ts
  orgs/routes.ts         # /api/orgs/* — CRUD, memberships, invitations, transfer
  admin/routes.ts        # /api/admin/* — stats, users, orgs, audit, impersonate
  publication/
    feeds.ts             # public /<slug>/gtfs.zip, feed_info.json, draft, robots
    submit.ts            # background submitToCatalogs() — Mobility DB + transit.land
    idStability.ts       # BE-88 diffRemovedIds
    ungzip.ts
  distribution/mobility.ts  # shared Mobility DB token-exchange (factored from legacy)
  me/
    export.ts            # GET /api/me/export ZIP stream
    usage.ts             # per-user/per-org usage counters
  cron/
    index.ts             # scheduled() entry
    tasks.ts             # reapDeletedUsers + summarizeWeeklyMetrics
  email/index.ts         # Resend client + templates
  util/
    crypto.ts            # PBKDF2 password hashing + random tokens + SHA-256
    errors.ts            # ApiError + helpers (unauthenticated, conflict, etc.)
    audit.ts             # append-only audit log writer
    rateLimit.ts         # KV fixed-window counters
  migrations/
    0001_auth.sql        # user, credential, session, auth_token, audit_event
    0002_projects.sql    # organization + membership, feed_project, feed_version,
                         # draft_link
    0003_distribution.sql  # publication, publication_history,
                           # project_catalog_submission, project_rt_feed
  legacy/
    tiles.ts             # PMTiles out of R2 (pre-backend feature)
    imports.ts           # Mobility DB catalog search + ZIP proxy
  __tests__/             # 31 Vitest files, 181 tests
    _setup.ts            # applyMigrations, resetDb, seedUser, setupEmailCapture,
                         # gzip/ungzip helpers
    _client.ts           # cookie-jar-carrying test client
```

### Frontend
```
src/
  App.tsx                # BrowserRouter; routes: /, /demo, /login, /signup,
                         # /verify-email, /magic-link, /reset-password,
                         # /change-email, /account, /feeds, /feeds/:slug,
                         # /orgs/:slug, /orgs/accept, /admin/*
                         # Mounts <ImpersonationBanner> + <RtBreakageDialog> globally
  services/
    authApi.ts           # base `request()` + ApiError + auth + account methods
    projectsApi.ts       # project CRUD, sync, versions, publish, draft-links
    orgsApi.ts           # org CRUD, membership, invitations
    distributionApi.ts   # catalog submissions, RT feeds, audit endpoints, export
    adminApi.ts          # /api/admin/* client
  store/
    index.ts             # combined Zustand store (15+ slices)
    authSlice.ts         # currentUser, hydrateAuth (triggers loadOrgs), clearAuth
    orgsSlice.ts         # userOrgs, activeWorkspace (persisted to localStorage)
    feedsSlice.ts        # server-project state (version list, publication history, …)
    — plus existing agency / calendar / routes / stops / trips / shapes / fares /
      feedInfo / validation / ui / project / coverage / flex slices
  components/
    auth/                # LoginPage, SignupPage, VerifyEmailPage, MagicLinkPage,
                         # ResetPasswordPage, ChangeEmailPage, AccountSettingsPage
    feeds/MyFeedsPage.tsx
    publication/         # PublishPanel, DraftLinksPanel
    distribution/        # DistributionPanel, RtBreakageDialog,
                         # PublishWithDistribution composite
    versions/            # VersionHistoryPanel, ConflictDialog
    audit/               # AuditTable, ProjectAuditPanel, auditFormat
    orgs/                # OrgSettingsPage, AcceptInvitationPage
    admin/               # AdminLayout + Dashboard/Users/Orgs/Audit pages
                         # + ImpersonationBanner, adminShared, adminFormat
    layout/              # TopBar (workspace switcher, account menu, RoleBadge),
                         # AppShell, BottomPanel (Publish + Versions + Activity
                         # tabs gated on activeServerProjectId), WelcomeBanner
    misc/                # NotFoundPage, BackendDisabledPage
  db/
    dexie.ts             # existing local IndexedDB
    persistence.ts       # local autosave (unchanged pre-backend)
    serverPersistence.ts # debounced server autosave + version-token guard
  utils/featureFlags.ts  # VITE_BACKEND_ENABLED
```

### Docs + scripts
```
docs/
  BACKEND_REQUIREMENTS.md     # feature spec (BE-*, NF-*, NF-40a = argon2id)
  BACKEND_IMPLEMENTATION_PLAN.md  # six phases + risks
  DEPLOY_BACKEND.md           # one-page provisioning runbook
  BACKEND_STATUS.md           # THIS FILE
scripts/
  dev-seed-user.ts            # insert a pre-verified user into local D1
  reset-rate-limits.sh        # nuke rate-limit counters on staging/prod/local KV
```

---

## 4. Commits on the branch

In reverse order (newest first):

| SHA | What |
|---|---|
| `aa4ab97` | Wrangler: real prod D1 + KV ids for first production deploy |
| `f98ea7e` | Coverage: use bus-stop emoji for empty-state icon |
| `70be28e` | Editor: explicit Save button + Save-As + beforeunload guard |
| `cc6f0cb` | Docs: scope Phase 7 — embeddable maps & schedules |
| `91a7da7` | Worker: decompress working-state + version-state in worker, not via Content-Encoding header |
| `a8cf88b` | Docs: BACKEND_STATUS — resumable snapshot of where we are now |
| `a15d1dc` | Signup: idempotent retry for pending_verification + rollback on email failure |
| `d2f9e1c` | Relax auth rate limits 2× + reset-rate-limits script |
| `c14f998` | Docs: reflect PBKDF2-100k reality + NF-40a argon2id follow-up |
| `a02c4f7` | Drop PBKDF2 iterations 600k → 100k (workerd cap) |
| `4a02219` | Staging env + run_worker_first='/*' for feeds subdomain routing |
| `b4d5a14` | Frontend for phases 3–6 + admin panel |
| `b81994e` | Backend phases 3–6 + admin panel |
| `9c47d6f` | Requirements: add Admin Panel section (v1.1) |
| `aaccc17` | Editor UX: Tab between time cells; auto-exit place-stop mode |
| `b145563` | Verify flow: redirect to /login?verified=1 instead of auto-login |
| `1c7f4d1` | Fix: draw.create fires twice under StrictMode |
| `f489319` | Wrangler: run_worker_first for backend paths |
| `7ff6d1c` | Dev: use localhost (not 127.0.0.1) for APP_ORIGIN |
| `af9352e` | Better errors for unverified-email + failed verification sends |
| `4efd9cf` | Dev stack: Vite proxy, bug fixes from email-link audit |
| `12daef9` | Test harness: @cloudflare/vitest-pool-workers + 66 integration tests |
| `4b21cc2` | Frontend: auth UI, My Feeds, version history, server sync |
| `956ce35` | Backend: auth + feed management Worker (phases 1 & 2) |
| `e818ccf` | Backend: requirements, implementation plan, deploy runbook |

---

## 5. Outstanding work

Ordered roughly by when-it-needs-to-happen.

### Just-shipped follow-ups

1. **Merge** `backend-phases-1-2` → `main` via PR. The branch is what's deployed in production; merging just synchronizes the canonical history and makes future PRs target `main` again.
2. **Verify the Save flow on prod** end-to-end: anonymous edit → Save → Save-As dialog → `/feeds/<slug>` → edit → Save → reload-and-confirm. Already tested on staging + via direct DB-token auth in dev; do one organic walkthrough on prod when you have a free minute.
3. **Phase 7 (embeddable maps & schedules)** — scoped in `docs/EMBEDS_REQUIREMENTS.md` but not implemented. Sub-phases 7a–7f layer on top of the live publication infrastructure; doesn't block anything.

### Pre-broad-rollout (before RTAP distribution)

4. **NF-40a: argon2id password hashing** — swap PBKDF2-SHA256 @ 100k for argon2id via a WASM bundle (`hash-wasm` or equivalent). `verifyPassword` must remain dual-path so legacy PBKDF2 hashes keep authenticating; re-hash on successful sign-in. Target `m=19MiB, t=2, p=1`, <150 ms in workerd. Details in `BACKEND_REQUIREMENTS.md` NF-40a and `BACKEND_IMPLEMENTATION_PLAN.md` risks table.
5. **transit.land submission** — currently stubbed (`status=pending`, `last_error='transit_land submission pending manual review'`). Wire the real submission path (likely a PR to `transitland-atlas`) once we have credentials. See `worker/publication/submit.ts`.
6. **Hard-mode quotas** — flip `HARD_LIMITS=true` in `wrangler.jsonc` vars when RTAP starts distributing. Today it's soft-warn only.
7. **Parallel test flake** — running `npm test` without `--fileParallelism=false` sporadically fails with workerd WebSocket-disconnect noise across many files. Benign for now; serial runs in CI are fine. Worth filing upstream to cloudflare/workers-sdk if it gets in the way.

### Nice-to-have / watchlist

8. **Admin impersonation across tabs** — we carry the staff user id in `localStorage.gb_staff_id` so `ImpersonationBanner` can detect the cookie swap. If the user opens a second tab during impersonation, detection can go stale until reload. Not a bug per se; consider migrating to a readable cookie or a server-side "acting as" field on `/api/me`.
9. **Publication edge-cache invalidation** — on publish we don't call `caches.default.delete()`. Clients get fresh bytes on next cache expiry (3600s TTL + versioned ETag). Probably fine; revisit if we see stale-feed reports.
10. **Dev-mode Cloudflare content-signals injection** — Cloudflare prepends its content-signals block to `/robots.txt` on our feeds subdomain. Our `Disallow: /` is still preserved below. Can be disabled per-zone if it looks untidy.

---

## 6. How to resume

### If you're just reading the docs
- Scan §1 for what shipped, then §5 for outstanding items. §3 is a code-pointer reference when you need to find something.

### If you want to run it locally
```
cd ~/proj/gtfs-builder
npm install
# In one shell:
npx wrangler dev --port 8787 --local
# In another:
npm run dev
```
Open http://localhost:5173. To sign in without configuring Resend: `npx tsx scripts/dev-seed-user.ts you@test.com "You" hunter2-hunter2`.

### If you want to poke at staging
- Editor: https://staging.gtfsbuilder.net/
- Feeds: https://staging-feeds.gtfsbuilder.net/`<slug>`/gtfs.zip
- Admin console (as mark@eateggs.com): /admin
- Tail: `npx wrangler tail gtfs-builder-staging` (note: NO `--env` flag — the tail command takes the Worker name directly).
- Run SQL: `source ~/proj/.env && npx wrangler d1 execute gtfs-builder-staging --remote --env staging --command "SELECT …"`
- Reset rate limits if you hit the counters during testing: `scripts/reset-rate-limits.sh staging`

### If you want to redeploy prod
Production is already provisioned. After committing changes:
```
npm run build
source ~/proj/.env  # exports CLOUDFLARE_API_TOKEN
npx wrangler deploy --env=""
```
The empty `--env=""` is required to dismiss wrangler's "ambiguous environment" warning — it explicitly targets the top-level (prod) block. Without it, wrangler falls back to top-level by default but emits the warning each time.

### If you want to poke at prod
- Editor: https://www.gtfsbuilder.net/
- Feeds: https://feeds.gtfsbuilder.net/`<slug>`/gtfs.zip
- Admin console (as mark@eateggs.com): /admin
- Tail: `npx wrangler tail gtfs-builder` (note: NO `--env` flag — the tail command takes the Worker name directly).
- Run SQL: `unset CLOUDFLARE_API_TOKEN; npx wrangler d1 execute gtfs-builder --remote --command "SELECT …"` (the OAuth token has D1 write; the API token may not depending on which scopes you've left enabled).

### If you're debugging a production issue
1. `wrangler tail <worker-name>` first. JSON format (`--format json`) is easier to grep.
2. Check the audit log: `GET /api/admin/audit?subjectId=<user-or-project-id>`.
3. For a stuck user: the pending_verification retry path (see `worker/auth/routes.ts`) is the documented recovery — don't hand-edit the DB unless you need to.
4. Known divergences between dev and prod:
   - miniflare doesn't enforce workerd's PBKDF2 iteration cap.
   - The "Cloudflare Managed Content" robots.txt preamble is injected at the edge, not by our Worker.
