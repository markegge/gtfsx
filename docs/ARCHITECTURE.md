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
| `cron/` | Scheduled tasks (due scheduled-publishes, account-deletion reaper, metrics rollup, OCI upload, daily owner digest) |
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
| `user` | One row per person; email is the identifier. `staff=1` grants `/admin`. `plan` ∈ `free`/`agency`/`enterprise` (Pro retired in pricing v4, 2026-07). |
| `credential` | Auth material (password hash or OAuth identity); a user may have several. |
| `session` | Active login (HTTP-only cookie scoped to the editor origin). |
| `auth_token` | Single-use hashed tokens: `verify_email`, `magic_link`, `password_reset`, `invitation`. |
| `organization` + `organization_membership` | Shared workspace + **many-to-many** user↔org with per-org role (critical for consultants). Includes org brand-logo columns. |
| `feed_project` | One feed. Owned by a user or org (`owner_type`+`owner_id`); slug unique per owner; `brand_primary_color`; thumbnail pointer; `locked`. Also `license_spdx` (0024) — a **projection** written at publish time, not the source of truth: the editor's feed state (`licenseSpdx`) is. There is deliberately **no `ntd_id` column**: an agency's NTD ID is `agency.external_id`, which lives *inside the feed*, so publication reads it per agency straight out of the snapshot state. A single project-level ID could not describe a multi-agency feed. Also `catalog_publisher_type` + `mdb_source_id` (0027) — the open-catalog opt-in/declaration and the Mobility DB switcher id (see `/catalog.json`). |
| `project_membership` *(future, BE-95)* | Per-project access inside an org without org-wide visibility. Not built. |
| `feed_snapshot` | Immutable point-in-time editor state. Two R2 blobs (gzipped JSON + rendered ZIP) + a summary row. *(Renamed from `feed_version` in 0012.)* |
| `draft_link` | Unguessable hashed token → a specific snapshot; time-limited, revocable. |
| `publication` / `publication_history` | Canonical-publish pointer (≤1 live snapshot per project) + append-only publish/unpublish/rollback log. |
| `project_catalog_submission` | **Legacy PUSH** opt-in per (project, catalog) for the abandoned direct Mobility DB / transit.land submission (`submit.ts`; the MDB v1 API `405`s on third-party writes). Superseded by the PULL open catalog (`feed_project.catalog_publisher_type` → `/catalog.json`); kept, not removed. |
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
| `0019_scheduled_publish` | `scheduled_publish` (publish-at-a-time, BE-77) |
| `0020_project_lock` | `feed_project.locked` |
| `0021_embed_impressions` | `embed_impression` (per-project embed view counts) |
| `0022_google_oauth` | `user.email_verified` + Google OAuth identity support |
| `0023_pro_intent` | `pro_intent` (pricing-funnel intent log) |
| `0024_feed_license` | `feed_project.license_spdx` (SPDX short id, NULL when undeclared) — projected at publish; feed state remains the source of truth. **License only.** No NTD-ID column: the ID belongs to the agency (`agency.external_id`) and rides inside the feed state. |
| `0025_scheduled_publish_acks` | `scheduled_publish.ignore_rt_breakage` + `.ignore_agency_churn` (both `INTEGER NOT NULL DEFAULT 0`) — the ID-stability gates the user acknowledged **at schedule time**, replayed by the cron at fire time. Without them a scheduled publish that tripped either gate could only fail unattended. (`ignore_warnings` was already on the row from 0019.) |
| `0026_demo_leads` | `demo_leads` (captured `/book-demo` lead-form submissions). |
| `0027_open_catalog` | `feed_project.catalog_publisher_type` (NULL / `official` / `community` — the open-catalog opt-in + declaration) + `feed_project.mdb_source_id` (Mobility DB source id for the switcher/update path); `publication.catalog_meta_json` (per-publish geography/metadata for `/catalog.json`, computed once at publish). See `docs/catalog-spec.md`. |

---

## 3. API surface

JSON over cookie-auth on the editor origin; fully public reads on the feeds
origin. This list is the source of truth.

### Editor origin (auth-gated except `/auth/*`, `/api/events/track`, billing webhooks)

| Method & Path | Purpose |
|---|---|
| `POST /auth/signup` · `/auth/verify` · `/auth/login` | Signup (Turnstile-gated) / verify email / password login |
| `POST /auth/magic-link/request` · `GET /auth/magic-link/consume` | Magic-link request / consume (magic link skips 2FA — it already proves the email factor; must gain an SMS challenge when SMS 2FA ships) |
| `POST /auth/2fa/verify` · `/auth/2fa/resend` | Login 2FA: password login (and Google OAuth, via `/login#twofa=…` redirect) returns 403 `twofa_required` + a challenge token instead of a cookie when 2FA applies; `verify` consumes the 6-digit emailed code (10 min TTL, 5 attempts, hashed at rest in D1 `twofa_challenge`) and issues the session; `resend` is 60s-cooldown-limited (max 3 sends) |
| `GET /api/me/twofa`, `POST /api/me/twofa/enable` · `/disable` · `/confirm`, `POST /api/me/phone[/verify]` | Per-user 2FA settings (off by default; enable/disable each round-trip a code). SMS method + phone enrollment run via Twilio Verify (`worker/sms/`) and return `sms_unavailable` until the three `TWILIO_*` secrets are set. Org-side: `PATCH /api/orgs/:id` accepts `require_2fa` (admin+) — members of a requiring org get an email challenge at login even if not enrolled, and can't disable 2FA |
| `POST /auth/logout` · `/auth/logout-all` | End current / all sessions |
| `POST /auth/password-reset/request` · `/auth/password-reset/confirm` | Forgot-password flow |
| `GET/PATCH /api/me`, `POST /api/me/email/change`, `POST /api/me/password`, `DELETE /api/me`, `GET /api/me/export` | Profile, email/password change, soft-delete, data export |
| `GET/POST /api/orgs`, `GET/PATCH/DELETE /api/orgs/:id`, `*/logo`, `*/invitations[...]`, `*/members/:uid`, `*/transfer`, `/api/orgs/invitations/accept` | Org lifecycle, branding, membership, invitations, transfer |
| `GET/POST /api/projects`, `GET/PATCH/DELETE /api/projects/:id`, `*/transfer`, `*/working-state` | Project CRUD + workspace transfer + working-state sync (If-Match) |
| `POST/GET /api/projects/:id/snapshots`, `*/snapshots/:sid/state`, `*/restore`, `DELETE *` | Snapshots (list/create/fetch/restore/delete) |
| `POST/GET/DELETE /api/projects/:id/draft-links[/:tokenHash]` | Draft review links |
| `POST /api/projects/:id/publish` · `/unpublish` · `/publish/rollback` · `GET /publish/history` | Canonical publish lifecycle. `publish` body (JSON or the multipart `meta` part): `snapshotId`, plus optional `ignoreWarnings`, `ignoreRtBreakage`, `ignoreAgencyChurn`, `licenseSpdx`. There is **no `ntdId` field** — an agency's NTD ID is `agency.external_id` inside the feed, so it arrives with the snapshot state and needs no publish-request plumbing. For `licenseSpdx`, `null` clears it and omitting the key leaves the existing projection alone (the cron path omits it and must not clobber the last interactive publish). Advisory 409s: `rt_breakage` (removed ids referenced by an external RT feed) and **`agency_id_churn`** (removed/renamed `agency_id` vs. the published feed — fires for *every* project, RT or not, because FTA's P-50 crosswalk keys on `agency_id`); each is acknowledged by its matching `ignore*` flag. |
| `POST/DELETE /api/projects/:id/publish/schedule` | Scheduled publish (BE-77). Body (JSON, or the multipart `meta` part + a rendered `zip` — the cron has no client to render one at fire time): `snapshotId`, `scheduledFor` (unix ms, ≥1 min out), plus the **same** optional acknowledgement flags as `publish`: `ignoreWarnings`, `ignoreRtBreakage`, `ignoreAgencyChurn`. **Scheduling runs the identical ID-stability gates and returns the identical advisory 409s** (`rt_breakage`, `agency_id_churn`) — one shared evaluation, `worker/publication/idStability.ts → assertIdStable()`, also called by `performPublish`. A scheduled publish targets a fixed, immutable snapshot, so the diff is computable *at schedule time*, while the user is present to acknowledge it; at fire time nobody is there to ask. The acknowledgements persist on the row (`scheduled_publish.ignore_rt_breakage` / `ignore_agency_churn`, 0025) and the cron replays **exactly those** into `performPublish`, which re-runs the gates — so churn that appears *after* scheduling (someone published something else, moving the baseline; or an RT feed gets registered) is still un-acknowledged, and the schedule **fails** (`status='failed'`, `failure_reason='agency_id_churn: …'`) instead of publishing something the user never agreed to. A 409 is raised before any write, leaving the existing pending schedule and stored ZIP untouched. Serialized schedule (here and in `GET /publish/history`): `{ id, snapshotId, scheduledFor, ignoreWarnings, ignoreRtBreakage, ignoreAgencyChurn, status, failureReason }`. `DELETE` cancels the pending row (idempotent). |
| `POST /api/projects/:id/catalog-submissions`, `PUT /api/projects/:id/rt-feeds`, `GET /api/projects/:id/audit` | Distribution opt-in, external RT-feed registration, per-project audit |
| `GET/POST/PUT/PATCH/DELETE /api/projects/:id/alerts[/:alertId]`, `GET */alerts/preview.json`, `POST */alerts/rt-feed` | Service Alerts authoring (Agency+; BE-90) |
| `POST /api/projects/import` | Anonymous→signed-in bulk import |
| `POST /api/billing/checkout` · `/portal` · `POST /api/billing/webhooks/stripe` · `GET /api/billing/me` · catalog | Stripe checkout/portal/webhooks; plan + usage |
| `GET /community/*`, `/api/forum/*` | Forum SSR pages + forum JSON API (threads/posts/upvotes/subscriptions/search/profile/uploads) |
| `POST /api/events/track` | Cookieless page-view/funnel beacon (no auth; CSRF + rate-limited; captures `?ref=`/`gclid`) |
| `GET /book-demo` | Demo-booking tracking redirect (no auth): logs `demo_request` event (`?src=` placement label + `gclid`, bot UAs skipped) then 302 → Fantastical booking page; `demo_request` uploads to Google Ads via the OCI cron |
| `GET /api/admin/*` | Staff operator console (404 to non-staff): stats, users, orgs, audit, events summary, ads attribution |

### Feeds origin (no auth)

`GET feeds.*/catalog.json` · `feeds.*/<slug>/gtfs.zip` · `/feed_info.json` ·
`/dmfr.json` · `/alerts.pb` · `/alerts.json` · `/draft/<token>.zip` ·
`/<slug>` (mini-site) · `/embed/route/<id>` · `/embed/stop/<id>` ·
`/embed/system-map` · `/_/orgs/<org_id>/logo` · `/robots.txt` (`Disallow: /`).

- **`/feed_info.json`** — sidecar metadata. Adds an **`agencies[]`** array, one entry per
  agency in the published snapshot state:
  `{ "agency_id": "SVT", "agency_name": "…", "external_id": "00123" }`. Each key is
  **omitted when unset** (a consumer crosswalking feeds to NTD IDs should see "absent",
  not an explicit null), and `external_id` is a **string** — leading zeros are
  significant, never `Number()`-coerced. Also `license_spdx_identifier`, likewise omitted
  when unset. The agencies are projected out of the **snapshot state** (`projectAgencies()`
  in `publication/feeds.ts`), not out of D1: the feed is the source of truth for its own
  agencies. This replaced an earlier single top-level `ntd_id`, which could not describe a
  multi-agency feed.
- **`/dmfr.json`** — [DMFR](https://dmfr.transit.land/) v0.5.1 registry document
  (`worker/publication/dmfr.ts`; schema vendored at
  `worker/__tests__/fixtures/dmfr.schema-v0.5.1.json` and asserted against in
  `publication.ntd.test.ts`). Carries the NTD crosswalk on `operators[].tags.us_ntd_id`
  so a publisher can hand one URL to Transitland / the Mobility Database. `Cache-Control:
  public, max-age=3600` + `Access-Control-Allow-Origin: *` (registry tooling and
  browser-based validators fetch it cross-origin). Emits **one operator per agency**, each
  with its own `tags.us_ntd_id` and its own `associated_feeds[].gtfs_agency_id` — the
  agency↔operator mapping is asserted, not left to the registry maintainer. The required
  `operator.onestop_id` is *derived* (`o-<geohash>-<name>`) rather than faked; the geohash
  is of the **feed's** stop centroid (we model no per-agency service area), so co-located
  agencies share it and are distinguished by the name component. With no usable stop
  coordinates the optional `operators` container is dropped, and the NTD ID falls back to
  feed-level `tags` **only when exactly one agency declares an `external_id`** (a
  feed-level tag cannot name its agency; with two or more we emit none rather than assert
  an ambiguous crosswalk). A companion `gtfs-rt` feed entry is emitted only when the
  project has registered RT feeds. `buildDmfrDocument()` is pure (no env, no I/O) so the
  schema test drives it directly and the route stays a thin loader.
- **`/catalog.json`** — the GTFS-X **open catalog** (`worker/publication/catalog.ts`;
  spec at `docs/catalog-spec.md`; tests in `publication.catalog.test.ts`). One
  origin-level document (no slug) listing **every published feed whose owner opted into
  public listing** (`feed_project.catalog_publisher_type IN ('official','community')`),
  for MobilityData / TransitLand to **pull** on their own cadence — the successor to the
  dead **push** integration (`submit.ts` → the MDB v1 API, which `405`s on third-party
  writes). Self-healing: the query `JOIN`s `publication`, so unpublish drops a feed, and
  opt-out clears the column. Field names mirror MDB's `add_gtfs_schedule_source`; source
  authority is the publisher-declared `is_official` boolean (**no silent default** — an
  undeclared feed is omitted). `Cache-Control: public, max-age=3600` +
  `Access-Control-Allow-Origin: *`. Built from **D1 only**: the per-feed geography/metadata
  it needs (`bounding_box`, features, `feed_publisher_name`, `feed_contact_email`) is
  computed **once at publish** and persisted (`publication.catalog_meta_json`), so the
  route never loads N feed blobs per request. `buildCatalogDocument()` is pure. The
  canonical URL is the `feeds.` host; `www.*/catalog.json` **301**s here (see §5).

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
**NF-40a (migrate to argon2id) is deferred indefinitely** (issue #26, closed
2026-05-30): the clean WASM path is blocked on workerd (no runtime
`WebAssembly.compile`) and pure-JS argon2id runs ~0.5–1s/op — not worth it given
low data sensitivity (no PII/financial). Revisit if that changes. All bearer
tokens ≥128-bit, single-use, hashed at rest. CSRF via
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

**As of 2026-07-15.** Keep this section current when deployed state changes.

### Production — LIVE

- **Repo transferred to the GTFS-X GitHub org (2026-07-12):** moved from
  `markegge/gtfsx` to `GTFS-X/gtfsx` (https://github.com/GTFS-X/gtfsx), same
  `main` default branch, still public.
- **Push-to-main auto-deploy: BROKEN by the transfer, now RECONNECTED and
  verified (2026-07-12).** The Cloudflare Workers Builds GitHub App had been
  connected to the old `markegge/gtfsx` and did not follow the repo to the org,
  so for a window that day `main` pushes gave a green CI run and no deploy while
  prod kept serving the pre-transfer bundle. The GitHub App has been
  re-authorized on the GTFS-X org and the build re-linked. Verified with a real
  push: `ce88751` landed at 22:57:16Z and Cloudflare created a deployment at
  22:58:39Z (~83s later), and prod served a string unique to that commit.
  Manual ship (still the fallback, and the only path for a hotfix that cannot
  wait for the build):
  ```
  npm run build:prod && npx wrangler deploy   # wrangler does NOT build
  ```
  Always `build:prod`, never a bare `npm run build`, which ships a Stripe test
  key (see §5 deploy gotchas).
  **Verifying a deploy actually shipped:** `npx wrangler@4 deployments list` and
  compare the newest timestamp against your push. Do NOT try to fingerprint the
  prod bundle by grepping the chunks linked from a page's HTML: that HTML lists
  only the entry and preloaded chunks, so lazily-imported code (most components)
  is absent from it and you will get confident false negatives.
- `main` is protected by the **"main protection" ruleset** (blocks deletions and
  force-pushes; repo admins can bypass). It survived the org transfer intact.
  ⚠️ Check it with the RULESETS api, not the legacy branch-protection one:
  `gh api repos/GTFS-X/gtfsx/rulesets` shows it, whereas
  `gh api repos/GTFS-X/gtfsx/branches/main/protection` returns a misleading
  `404 Branch not protected` for ruleset-based protection. That 404 looks
  identical to genuinely unprotected. Do not conclude from it that main is open.
- Worker `gtfs-builder`. SPA serves the full editor + auth + billing + forum.
- **Backend + billing live since 2026-05-15.** `wrangler.jsonc` top-level vars:
  `BACKEND_ENABLED=true`, `BILLING_ENABLED=true`, `HARD_LIMITS=false`. (Originally
  disabled 2026-05-08 after a premature launch; re-enabled 2026-05-15 with
  live-mode Stripe in a coordinated deploy.)
- D1 `gtfs-builder` (`cfb27d4e-…`), KV (`da2476e5…`), R2 `gtfs-builder-feeds`
  + `gtfs-builder-forum-images`, tiles in `gtfs-builder-tiles`. Migrations
  **0001–0026 applied** (verified against `d1_migrations` 2026-07-15; this line
  has drifted twice before — check the table, not this doc, before applying).
- **Demand-dot pipeline rebuilt to ATTRIBUTE DOTS (2026-07-13), PUBLISHED and
  serving.** Archive `us-2026e`. This is a **tile schema change, not
  a reissue**: a dot is now one PERSON carrying a packed flag bitmask in an
  integer `d` attribute, and the old composite/backdrop/segment CLASSES
  (`prop_all`, `need_all`, `backdrop_prop`, `backdrop_need`, `carless`,
  `low_income`, `senior`, `disability`) no longer exist in the tiles at all.
  See Appendix A. Status:
  - Pipeline (`build_dots.py`, `joint_flags.py`, `puma_union.py`,
    `build_puma_corrections.py`, `verify_tiles.py`, `demand-legend.json`) and the
    frontend consumer (`demandCategories.ts`, `demandLegend.ts`,
    `DemandDotsLayer.tsx`, `MapLayerControls.tsx`) are **merged to `main` and
    deployed** (branch `feat/demand-dots-demographic-layers`, landed via the
    2026-07-13/14 merges).
  - **The nationwide re-tile is done** — all 51 states + DC + PR rebuilt from
    scratch under the attribute-dots schema (the prior `us-2026d`-era local
    artifacts were pre-attribute-dots and were correctly rejected by
    `verify_tiles.py`); the rebuild fed the `us-2026f` archive below.
  - **`us-2026e` is published** to R2 `gtfs-builder-tiles` as `us-2026e.pmtiles`
    (1,369,832,025 bytes, uploaded 2026-07-13 via rclone — wrangler cannot, see
    Appendix A), and verified serving HTTP 200 from prod at
    `/_demand-tiles/us-2026e/{z}/{x}/{y}.pbf`. It passed `verify_tiles.py`:
    every zoom carries exactly the dots the ladder promises, so the legend's
    "1 dot = N people" is true at every zoom. `us-2026b` (the original 3-class
    tileset, 6.6 GB) is left in the bucket as a rollback; `us-2026c` and
    `us-2026d` were never published.
  - **`us-2026f` — PUBLISHED and SERVING (uploaded 2026-07-14, verified from
    prod 2026-07-15).** Same tile schema as `us-2026e`; the ZOOM LADDER is 4x
    denser (full density at z13 instead of z15 — see the ladder table above).
    `us-2026e`'s ladder had been sized against a model of the worst tile that
    was ~3x too conservative; the new ladder is sized against the decoded
    archive and the heaviest tile in the country is 313k features / 1.06 MB
    (Manhattan) against caps of 400k / 2.0 MB. It passes `verify_tiles.py` —
    nothing thinned. Uploaded via rclone as `us-2026f.pmtiles` (2,334,493,893
    bytes, confirmed in the bucket listing), and
    `/_demand-tiles/us-2026f/{z}/{x}/{y}.pbf` returns HTTP 200 from prod.
    `us-2026e` stays in the bucket as rollback.
  - Publishing still requires the tile build (piped through `--cat-verified`,
    never a bare `cat`—see Appendix A) to pass `verify_tiles.py`, then an
    rclone upload (wrangler hard-fails above 300 MiB; the pmtiles archive is
    ~1.28 GiB—see the Demand-dot regen runbook in Appendix A). Do not consider
    the redesign live until both have happened.
- **Coverage block layer schema change — LIVE end to end (client merged and
  deployed; layer verified from prod 2026-07-15).** The new schema retires
  `riders` and adds `carless`, `disability`, `prop_all`, `need_all`
  (PUMS-derived ridership-propensity / transit-need unions).
  `coverage-pipeline/build_coverage_blocks.py` and the frontend consumers
  (`blockCoverage.ts`, `walkshedProfile.ts`, `demographics.ts`,
  `CoveragePanel.tsx`, `WalkshedProfileTable.tsx`) are merged to `main`
  (`COVERAGE_REGION = 'us-v2'` is what prod serves). Status:
  - **The R2 key is versioned, not overwritten in place.** The client reads
    `COVERAGE_REGION` (`src/services/blockCoverage.ts`) = `us-v2`, not a bare
    `us`, so the nationwide rebuild shipped to a **new** object,
    `coverage/us-v2.fgb`, leaving prod's currently-deployed old-schema client
    reading its existing `coverage/us.fgb` untouched. This covers the
    direction `CoverageLayerSchemaError` (below) cannot: an OLD,
    already-deployed client reading a NEW layer would otherwise read a
    missing `riders` column as `undefined → 0`, with no error surface,
    because that client was built before this change existed.
  - **The nationwide regen is done.** `build_us.py --out us-v2.fgb --jobs 4`
    ran to completion, and `us-v2.fgb` was uploaded to
    `gtfs-builder-tiles/coverage/us-v2.fgb` via **rclone**, not wrangler—
    wrangler hard-fails above 300 MiB ("Wrangler only supports uploading
    files up to 300 MiB in size") and the file is ~1.7 GiB, so `wrangler r2
    object put` has never been able to upload it. See the Coverage-layer
    regen runbook in Appendix A and
    `demand-dots/coverage-pipeline/README.md`'s "Host it" section for the
    exact command (`--s3-no-check-bucket` is required, or the R2 token—
    scoped to object read/write only—gets a 403 trying to `CreateBucket`).
  - **Verified serving from prod:** `/_coverage/us-v2.fgb` returns **HTTP
    206** (range request against the uploaded FlatGeobuf), confirmed against
    the bucket listing (`rclone lsl r2:gtfs-builder-tiles/coverage/`), not
    just the upload command's exit code—a piped `rclone … | tail` reports
    `tail`'s exit status, not rclone's, so that distinction mattered today.
  - **`coverage/us.fgb` (the old schema) is untouched** and remains in the
    bucket as the rollback for a client rollback. `loadBlocksInBbox()` throws
    `CoverageLayerSchemaError` if a served `.fgb` ever lacks the union
    columns, so a stale/old layer degrades to the block-group path (counts
    only, no propensity/need estimate) rather than rendering `prop_all` as a
    confident `0`.
  - **The old layer also under-counted.** Independent per-column rounding in
    the apportionment destroyed rare attributes: measured on Montana, the
    live `coverage/us.fgb` is short **-10.2% of zero-vehicle households** (a
    Title VI equity numerator) and **-5.7% of carless residents**. Fixed with
    largest-remainder apportionment; `us-v2.fgb` carries the fix, but it only
    reaches prod once the client redeploys reading the new key.
  - Prod is confirmed running the `us-v2` client (2026-07-15), so the old
    `coverage/us.fgb` object is now eligible for deletion from R2. It has NOT
    been deleted — that's an operator call, not an automatic step.
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
- **Owner notifications:** the per-signup owner BCC on the welcome email was
  replaced by a **daily owner digest** (new-signups / active-users / new-paid-subs
  over the trailing 24h). Fires on the `0 13 * * *` cron (gated in
  `worker/cron/index.ts` by the cron expression), sent best-effort to
  `OWNER_DIGEST_EMAIL` (falls back to `OWNER_NOTIFY_EMAIL`); kill switch
  `OWNER_DIGEST_ENABLED`. Metric definitions mirror the Admin dashboard exactly.
  The per-paid-subscriber notice (`sendUpgradeNotification`) is unchanged.
- Secrets: `RESEND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`,
  `TURNSTILE_SECRET_KEY`, `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SIGNING_SECRET` (live),
  `GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST` (set on prod 2026-07-12 —
  demo_request OCI uploads are live; see `worker/marketing/ads/README.md` §4).
- **Ask GTFS·X assistant secret (`ANTHROPIC_API_KEY`), shipped 2026-07-20.** Set
  on both `gtfs-builder` (prod) and `gtfs-builder-staging`; consumed by the Ask
  GTFS·X assistant (`worker/assistant/`). The key is a dedicated Anthropic
  Console workspace key for this assistant, isolated from other projects' keys.
  It **never expires**, but the workspace carries a **$25/month spend cap** —
  if the assistant starts returning upstream auth/quota errors near month end,
  check the cap first (raise it in the Anthropic Console). Local copy lives in
  gtfsx `.dev.vars` under the var name `ASK_GTFSX_ANTRHOPIC_API_KEY` (sic — note
  the transposed "RH", as it exists today).
  **Rotation runbook:**
  1. Validate the new key with a minimal 1-token curl to
     `api.anthropic.com/v1/messages` before installing it anywhere.
  2. From a gtfsx checkout: `unset CLOUDFLARE_API_TOKEN`, then pipe the value
     into `npx wrangler secret put ANTHROPIC_API_KEY` (prod) and
     `npx wrangler secret put ANTHROPIC_API_KEY --env staging`.
  3. Gotcha: a plain `secret put` fails with `"latest version isn't deployed"`
     if the worker has an undeployed newer version — in that case use
     `npx wrangler versions secret put ANTHROPIC_API_KEY` instead (stores the
     secret without deploying; the next deploy inherits it).
- Stripe: live-mode Price IDs (`STRIPE_PRICE_TEAM_*` only; `STRIPE_PRICE_PRO_*`
  removed from `wrangler.jsonc` in pricing v4), portal config, webhook
  `→ /api/billing/webhooks/stripe`. Post-v4 Stripe cleanup done 2026-07-12:
  `gtfsb_pro` product + prices archived (live mode), superseded team v1/v2
  prices archived, the live $2,988 annual price carries lookup_key
  `gtfsb_team_annual_v3`, the `gtfsb_team` product is display-named
  "GTFS·X Planner", portal config updated, and `scripts/setup-stripe.ts` had
  its team-annual $2,499 drift fixed plus a drift guard added.
- **Pricing v4 live since 2026-07-11** — Pro tier retired (zero subscribers);
  lineup is Editor (free) / Planner (`agency`, $299/mo · $2,988/yr, 14-day trial)
  / Enterprise (call us, "multi-agency subscriptions for consultants and state
  DOTs"). Former Pro entitlements folded into Planner; `geojson_export` now free.
  Primary agency-funnel conversion is **booked demos**: `GET /book-demo?src=…`
  logs a `demo_request` event then 302s to `https://fantastical.app/markegge/gtfsx-demo`;
  marketing pages (home two-panel hero, /planning, compare, state-dot, feed-health)
  are demo-first. Google Ads follow-through done 2026-07-12: `demo_request`
  conversion action created (ctId 7682006138), its secret set on prod, budgets
  reweighted (Editor $12/day, Planning $28/day), Book-appointments goal wired
  into the Agency & Planning campaign, RSAs rewritten for the planning audience
  (Route Planning ad → Excellent strength; Title VI ad → Average; stale
  "Pro"/"Agency Tier" copy scrubbed from sitelinks and headlines), a
  "Book a 30-Min Demo" campaign sitelink added, duplicate sitelinks removed,
  and 12 negative keywords added (GIS-intent terms on Editor, consumer
  trip-planning terms on Agency & Planning). The disapproved bare-mark
  business logo was replaced 2026-07-12 with the full-lockup
  `docs/brand-kit/assets/google-ads/logo-coral-on-white-1200.png` (pending
  Google review). Bidding stays Maximize Clicks until ≥30 conversions/30 days.
- **Marketing videos (2026-07-17):** `lp_planning_demo-v3.mp4` uploaded to the
  `gtfsx-videos` R2 bucket behind videos.gtfsx.com (versioned key to dodge edge
  caching) — a tighter ~52s cut from the v3 script (Title VI one-click open,
  cost/coverage, scenario compare, demo + free-trial close); captions
  regenerated via Whisper. The /planning page reference moves v2 → v3 on
  `feat/planning-lp-conversion`; **prod still serves v2 until that branch
  ships**, so don't delete the v2 object.
  The editor LP `/lp/gtfs-editor/` was **retired** instead of re-recording its
  stale video: page deleted, path 301s to `/`, editor-campaign ads land on the
  homepage, `lp-editor-demo.mp4` removed from R2. No paid editor tier exists
  to upsell, so the homepage's editor hero panel is the landing experience.
- **`/transitfeeds/` static page live since 2026-07-12**
  (`public/transitfeeds/index.html`, `https://www.gtfsx.com/transitfeeds/`), a
  landing page for the shut-down transitfeeds.com/OpenMobilityData. Registered
  in `sitemap.xml` via its canonical tag; internally linked from
  `/learn/publish-gtfs-feed/` and from `/feed-health/` (`fh.js`, methodology
  section, national view).
- **`transitfeeds.net` redirect (Cloudflare-only, not in this repo).** Zone
  `transitfeeds.net`, in the mark@eateggs.com CF account, has a Single
  Redirect rule (Rules → Redirect Rules in the zone dashboard) matching
  `http.host eq "transitfeeds.net"` or `"www.transitfeeds.net"`, 301'ing
  (query string not preserved) to `https://www.gtfsx.com/transitfeeds/`
  (previously → `/feed-health/`; changed 2026-07-12 alongside the page
  above). Unlike the legacy-hostname redirects in §1 (`worker/index.ts`,
  covering `gtfsstudio.net`/`gtfsstudio.com`/`gtfsbuilder.net`), this domain
  is not bound to the Worker: `wrangler` has no command for redirect
  rules/rulesets, so changing it requires the Cloudflare dashboard or a
  direct API call.
- **NTD-ID alignment live since 2026-07-12/13** (merged from
  `feat/ntd-id-alignment`; migrations 0024 + 0025 applied to prod D1; a
  post-merge svt-demo publish on 2026-07-13 succeeded, confirming the path).
  Adds the agency-level **NTD / External ID** (`agency.external_id`, edited in
  the Agency panel and always exported as an `external_id` column on
  `agency.txt`), the feed license (`license_spdx`), the `dmfr.json` route on
  the feeds origin (one operator per agency, `tags.us_ntd_id` when set), the
  `agencies[]` array in `feed_info.json`, the `agency_id_churn` publish gate,
  the NTD `agency_id` validator warnings, the P-50 helper panel, and the
  scheduled-publish gate-hole fix (schedule endpoint runs the same
  `rt_breakage`/`agency_id_churn` gates; acks persist on `scheduled_publish`
  and the cron replays them). svt-demo carries a live example since
  2026-07-15 (`external_id: 99999`, license `CC0-1.0` — visible in its
  `dmfr.json` and `feed_info.json`).
- The project owner's account (`mark@gtfsx.com`) is staff + enterprise.
  Pre-launch D1 backup under `backups/` (gitignored).
- **Rollback:** `BILLING_ENABLED=false` disables paid checkout/portal but leaves
  auth + editor up; `BACKEND_ENABLED=false` (with SPA rebuild) hides the whole
  backend. Both are `wrangler.jsonc` edits + redeploy. The two `*_ENABLED` flags
  and their `VITE_*` build-env twins must move in lockstep (see project memory).

### Not yet deployed (in flight)

Work that exists in the repo but is **not** live in production. Delete an entry
from here when it ships, and fold it into the Production list above.

- Nothing at the moment (2026-07-15). The NTD-ID alignment entry that lived
  here shipped and moved to the Production list above.

### Staging — PARKED (since 2026-05-16)

Infra still exists (`gtfs-builder-staging`, `staging[-feeds].gtfsx.com`, separate
D1/KV/R2) but is **not auto-deployed**. Use as a manual rehearsal env for risky
changes: `npm run build && unset CLOUDFLARE_API_TOKEN && npx wrangler deploy --env staging`.
Staging runs test-mode Stripe and both `*_ENABLED` flags true. Staging D1 is
migrated through 0026 (checked 2026-07-15). Last manual deploy 2026-07-15:
current `main`.

**Open catalog — the `public/catalog.json` hack is obsolete (issue #47, branch
`feat/catalog-endpoint`).** `/catalog.json` is now a **dynamic worker route** on
the feeds origin (`worker/publication/catalog.ts`), so it serves on staging
(`staging-feeds.gtfsx.com/catalog.json`) and prod (`feeds.gtfsx.com/catalog.json`)
with no static file. `staging.gtfsx.com/catalog.json` (the app-host URL
MobilityData was shown) **301**s to the feeds-origin URL; `feeds.` is canonical.
**Do NOT re-add `public/catalog.json`** — it would only serve stale demo data.
*Shadowing truth (tested):* on the **feeds** host the static-assets binding is
never consulted — `feedsHandler` owns every path — so a static `catalog.json`
cannot shadow the canonical route at all; on the **app** host the worker's 301
runs *before* `env.ASSETS.fetch`, so it wins over a re-added file there too (the
file would be dead, never served). That branch adds migration **0027**
(`catalog_publisher_type`, `mdb_source_id`, `catalog_meta_json`) — **apply it to
staging and prod D1 BEFORE deploying the branch** (per §7).

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
- **A bare `npm run build` ships a Stripe TEST key to prod.** `featureFlags.ts`
  reads `VITE_STRIPE_PUBLISHABLE_KEY` and falls back to
  `VITE_STRIPE_PUBLISHABLE_TEST_KEY`, but `.env` only defines the `_LIVE_KEY` /
  `_TEST_KEY` pair, never the generic name (CF's build env used to supply it).
  On 2026-07-12 a manual `npm run build` silently took that fallback and prod
  shipped `pk_test_`: build green, deploy green, site up, checkout dead for ~30
  minutes. **Prod is built with `npm run build:prod`, never a bare
  `npm run build`.** It promotes `_LIVE_KEY` to the generic name, aborts if any
  build var is missing or wrong, and verifies the emitted bundle
  (`scripts/check-prod-bundle.mjs`: rejects `pk_test_`, requires `pk_live_` +
  a Mapbox token + backend/billing on). `npm run build` is unchanged and still
  correct for dev and staging, which legitimately use the test key.
- **Resend sending domain.** The prod key must be scoped to `gtfsx.com` (a
  legacy `gtfsbuilder.net`-scoped key fails signup email with "domain not verified").
- <a id="tsc-noemit-noop"></a>**`npx tsc --noEmit` is a NO-OP here—it is not a
  typecheck.** The root `tsconfig.json` is a *solution file*: `"files": []` plus
  three project references. A bare `tsc --noEmit` therefore compiles an empty file
  list and **exits 0 no matter how broken the code is** (`npx tsc --noEmit
  --listFiles` prints zero files). Using it as a gate is how a full session of
  "typecheck clean" verification turned out to be hollow. The real typechecks:
  ```bash
  npx tsc -b                                    # all three projects (--force bypasses the incremental cache)
  npx tsc -p tsconfig.app.json --noEmit         # what CI runs (frontend)
  npx tsc -p tsconfig.worker.json --noEmit      # what CI runs (worker)
  ```
  `tsc -b` with no args reads `./tsconfig.json` from the **CWD**, so a stray `cd`
  into a subdirectory fails with `error TS5083: Cannot read file
  '.../<subdir>/tsconfig.json'`—that is a wrong working directory, not a broken
  config. Run it from the repo root.
- <a id="large-r2-uploads"></a>**Large R2 uploads (>300 MiB) cannot use wrangler.**
  `wrangler r2 object put` hard-fails above 300 MiB ("Wrangler only supports
  uploading files up to 300 MiB in size"). Both census artifacts have always been
  far over that ceiling (`tiles/us-2026f.pmtiles` ~2.2 GB; `coverage-pipeline/us-v2.fgb`
  ~1.7 GB), so any runbook showing a `wrangler r2 object put` for them documented a
  command that could never have worked. **Use rclone**, which is already configured
  with an `r2:` remote (S3 endpoint, Cloudflare provider):
  ```bash
  rclone copyto us-2026f.pmtiles r2:gtfs-builder-tiles/us-2026f.pmtiles \
    --s3-no-check-bucket --s3-chunk-size 64M --s3-upload-concurrency 4
  rclone lsl r2:gtfs-builder-tiles/          # verify HERE, not by exit code
  ```
  Three ways this bites, all observed:
  - **`--s3-no-check-bucket` is REQUIRED.** Without it rclone calls `CreateBucket`
    first, and our R2 token is scoped to object read/write but *not* bucket
    creation, so it dies with `403 AccessDenied`—an error that points at bucket
    creation rather than at the upload.
  - **Verify against the bucket listing, never the exit code.** `rclone … | tail`
    reports *tail's* exit status, so a failed upload reports success. This
    happened: an upload "completed, exit 0" having transferred nothing after three
    403s. `rclone lsl` is the source of truth.
  - **Upload to the key something actually reads.** Tilesets live at the bucket
    **ROOT** (`us-2026f.pmtiles`)—`worker/legacy/tiles.ts` reads `${archive}.pmtiles`.
    The coverage layer lives at `coverage/<region>.fgb`, where `<region>` is
    `COVERAGE_REGION` in `src/services/blockCoverage.ts`. Full runbooks: Appendix A.

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
| `OWNER_DIGEST_ENABLED` | Daily owner-digest kill switch. `"false"` stops the `0 13 * * *` cron send; any other value (incl. unset) leaves it on. |
| `OWNER_DIGEST_EMAIL` | Recipient for the daily owner digest. Optional; falls back to `OWNER_NOTIFY_EMAIL`. |

---

## 7. Git & deploy workflow

Repo: `GTFS-X/gtfsx` (https://github.com/GTFS-X/gtfsx), public, default branch
`main`.

```
main = source of truth; stays deployable. Feature branches are short-lived,
branched off main, merged via --ff-only. Every push to main is a prod deploy
(Cloudflare Workers Builds runs `npm run build:prod` with the VITE_* build-env
vars, then `wrangler deploy`; live in ~1 minute).
```

The CF Workers Builds **"Build command" must be `npm run build:prod`**, so a
missing build var fails the build loudly instead of shipping a test-key bundle
(§5 deploy gotchas).

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
npx tsc -p tsconfig.app.json --noEmit         # frontend typecheck   ⎫ what CI runs;
npx tsc -p tsconfig.worker.json --noEmit      # worker typecheck     ⎭ `npx tsc -b` covers both
```

⚠️ **A bare `npx tsc --noEmit` typechecks NOTHING and exits 0**—the root
`tsconfig.json` is a solution file (`"files": []`). Never use it as a gate; run
`npx tsc -b` from the repo root, or the two `-p` commands above.
[Details](#tsc-noemit-noop).

### Shipping to prod (pre-push checklist)

1. Tests + both typechecks pass locally.
2. **Public docs updated in the same change.** New/changed user-facing
   functionality must be documented for the END USER on the live docs site
   (**gtfsx.com/docs** → `public/docs/<topic>/index.html`): add a new topic page
   (and link it from `public/docs/index.html`) or a section to the closest
   existing page, and bump that page's JSON-LD `dateModified`. Also flip the
   feature's status in [`REQUIREMENTS.md`](./REQUIREMENTS.md) as a secondary
   internal update. Code without public docs is not "done" — don't merge or close
   the issue until gtfsx.com/docs reflects it.
3. **Migrations applied on prod first** (manual): `unset CLOUDFLARE_API_TOKEN; npx wrangler d1 migrations apply gtfs-builder --remote`.
4. **Kill-switch pair in sync** — `BACKEND_ENABLED`/`BILLING_ENABLED` in `wrangler.jsonc` match their `VITE_*` twins in CF Workers Builds → Settings → Variables.
5. `git push origin main` → CF Workers Builds deploys.
6. **Verify the new build went live** (a "succeeded" build doesn't guarantee the active asset manifest):
   ```bash
   curl -sS https://www.gtfsx.com/ | grep -oE 'index-[a-zA-Z0-9_-]+\.js'   # must differ from the previous bundle
   ```
   If unchanged, use the manual fallback. The deployed bundle is self-describing:
   `__GTFSX_BUILD__` in prod devtools reports `{backend, billing, stripeKeyKind,
   mapbox}`. `stripeKeyKind` must read `live`.
7. Smoke-test in incognito (homepage, anonymous IndexedDB editor save/load, ZIP export; if backend on, `/login` shows the form not the placeholder).

### Manual fallback deploy (CF Builds broken, or to ship a specific local SHA)

```bash
git pull origin main
npm run build:prod                  # reads .env, promotes the live Stripe key, verifies the bundle
unset CLOUDFLARE_API_TOKEN
npx wrangler deploy --env=""
```

### Hotfix

Branch off the deployed SHA (not main), fix, `npm run build:prod && npx wrangler deploy --env=""`,
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

The product backlog (undeveloped features) lives in GitHub issues
(`GTFS-X/gtfsx`). The infra/tech-debt items that originated as `NF-*` anchors:

- **NF-40a** — argon2id password hashing. **Deferred indefinitely** (issue #26,
  closed): WASM argon2 is blocked on workerd, pure-JS is too slow, and account
  data is low-sensitivity. Staying on PBKDF2-100k.
- **NF-72** — error reporting (Sentry / Logpush sink with PII redaction).
- **NF-71** — per-project usage metrics surfaced to feed owners.
- **transit.land** catalog submission is stubbed (`status='pending'`) in
  `worker/distribution/` — wire the real API when credentials land.
- **HARD_LIMITS** flip from soft-warn to hard-reject is gated on the RTAP
  licensing launch.

---

## Appendix A — Census data layers: yearly regen runbook

Two prebuilt layers come out of `demand-dots/`, both fed by ACS + TIGER + LODES
and both regenerated once a year (~January, after the December ACS 5-year
release):

| Layer | Builder | Output | Served as |
|---|---|---|---|
| **Demand dots** (display-only; not wired into the analysis pipeline) | `demand-dots/build_dots.py` | `<archive>.pmtiles` in `gtfs-builder-tiles` | `/_demand-tiles/<archive>/{z}/{x}/{y}.pbf`—the archive name is read out of the committed `demand-dots/demand-legend.json` (`demandLegend.ts`), not hardcoded in `DemandDotsLayer.tsx`; the legend currently names `us-2026f` (built + verified, **upload pending** — see §5) |
| **Coverage blocks** (exact block-level counts behind the Coverage panel) | `demand-dots/coverage-pipeline/` (`build_coverage_blocks.py` per state, `build_us.py` to drive + merge) | `<region>.fgb` FlatGeobuf, `<region>` versioned per schema (`COVERAGE_REGION` in `blockCoverage.ts`; currently `us-v2`, prod still serving the old-schema `us` — see §5) | `/_coverage/<region>.fgb`, bbox range-reads |

### The ACS vintage is not a manual bump any more

`demand-dots/acs_vintage.py` probes `api.census.gov/data/<year>/acs/acs5`
downward from an impossible year and takes the newest release that answers. Both
builders call it, and it emits the same year into `src/generated/acsVintage.ts`,
which `src/services/demographics.ts` imports. That generated file is **committed**
— the Vite build imports it, and it is what guarantees the running app and the
prebuilt tiles can never disagree about which ACS release they are on. The
frontend does no runtime probing and pays no extra request.

So there is nothing to edit for a new ACS year. Just regenerate the constant:

```bash
cd demand-dots && ./.venv/bin/python acs_vintage.py --emit   # rewrites src/generated/acsVintage.ts
```

The TIGER year (`TIGER_YEAR`) and the LODES probe start are still literals in
both builders; check them when TIGER publishes a new vintage.

### Connecticut is pinned, on purpose

`ACS_YEAR_BY_STATE = {"09": 2021}` in **both** builders. Connecticut swapped its 8
counties for 9 planning regions as county-equivalents in ACS 2022+ (county codes
110-190), but TIGER `TABBLOCK20` still codes CT blocks with the old counties
(001-015). Since both builders apportion ACS block groups down to TIGER blocks by
12-char GEOID prefix, a current-vintage CT block group prefix-matches nothing and
the state silently produces zero population records. ACS 2021 still uses the old
county codes and joins cleanly, so CT builds one year behind. CT is the only state
affected. Retire the pin only when TIGER re-codes `TABBLOCK20` onto planning
regions — and retire the separate CT workaround in `public/census/TR09.txt` at the
same time (see `public/census/README.md`; that file has the *opposite* problem,
because the app joins ACS to tract centroids rather than to blocks).

### ATTRIBUTE DOTS: one dot = one person, carrying a flag bitmask (`us-2026e`)

**There are no dot classes any more.** The tiles carry ONE integer attribute,
`d`, on every feature in the single `demand` source-layer:

| `d` | meaning |
|---|---|
| `0`–`15` | a **person**, as the bitwise OR of their four membership flags: **1** carless (`B25044`), **2** low_income (`C17002`), **4** senior (`B01001`), **8** disability (`C21007`). `0` = none of the four; `15` = all four. |
| `16` | a **job** (LODES WAC C000). A workplace universe — never deduped against, mixed into, or drawn from the residential population. Its own code, its own color, forever. |

The composites are **evaluated at render time from the flags**, and exist
nowhere in the tiles:

```
propensity composite = carless OR low_income
need composite       = carless OR low_income OR senior OR disability
```

`prop_all`, `need_all`, `backdrop_prop`, `backdrop_need`, `carless`,
`low_income`, `senior` and `disability` were all tile CLASSES in `us-2026d` and
earlier. **They are gone.** A `us-2026d` tile has a string `class`; a `us-2026e`
tile has an integer `d`. The two share not one attribute name or value, which is
why the archive name had to move (`TILESET_ARCHIVE` in `build_dots.py`).

#### Why: the old schema drew a quarter of the population NOWHERE

The class-per-segment schema emitted a separate dot per (person, class) pair —
about **2.65 dots per person** — plus a backdrop computed as
`population − composite`. So with the **Carless** segment selected the map drew:

```
carless (blue)  +  population − (carless ∪ low_income) (gray)
```

Look at what is missing. The backdrop was population minus the *composite*, not
population minus the *selection*, so the low-income-but-not-carless people —
**24.6% of the population** — were drawn nowhere at all. Nothing was
double-counted, so every disjointness invariant passed; a quarter of the town
simply vanished, and a planner reading gray as "everyone else" was misled.

With flags on the dot the UI **recolors instead of reclassing**, and the roles
partition the population by construction:

| role | who | color |
|---|---|---|
| segment | the flag you selected (or the whole composite, with **All**) | strong blue `#2563eb` |
| composite | in the mode's composite, but NOT the selected flag | muted blue `#60a5fa` |
| backdrop | in neither | gray `#9ca3af` |
| jobs | `d == 16` | orange `#f97316` |

`segment ∪ composite ∪ backdrop == every population dot, always.` Every person
is drawn **exactly once in every view**. Double-counting and vanishing are now
STRUCTURAL impossibilities rather than properties maintained by careful
bookkeeping — there is no representation of "the same person twice" left in the
tiles. `demandCategories.roleForCode()` is the whole model in one function, and
a test walks all 16 codes × every selection to prove no population code is ever
undrawn.

Two more things fell out of this for free:

- **2.23x smaller tiles.** One dot per person instead of ~2.65 (Montana:
  17.0 MB → 7.3 MB).
- **Segments work at z8.** The old schema held the four segment classes back to
  `OVERLAY_MINZOOM = 9` because they were extra dots competing for the tile
  budget, so picking "Carless" while zoomed out drew *nothing*. A flag is not an
  extra dot — it rides on a person who is in the z8 tile anyway — so there is no
  per-class minzoom left to gate anything.

#### Packing, and why the frontend enumerates

`d` is a single packed integer rather than four boolean properties on purpose: in
the MVT wire format each property costs a (key index, value index) varint pair,
so four booleans cost ~4x what one small integer does, per feature, across ~200M
features.

The cost of packing is that **Mapbox GL expressions have no bitwise operators** —
the frontend cannot ask for "dots where bit 1 is set". It does not have to: the
set of codes matching any predicate over 4 flags is at most 16 literals, so
`demandCategories.ts` **enumerates** them into an `['in', …]` filter and a
`['match', …]` color. Those enumerations are built from bit values that
`demandLegend.ts` verifies against the pipeline's own `demand-legend.json` at
import, and **throws** on mismatch. That check is not decoration: a wrong bit
value does not break the map, it silently colors the *wrong people*, plausibly,
forever.

`demand-legend.json` (emitted by `build_dots.py --emit-legend`, committed) is the
single source of truth for the flag bits, the jobs code, the archive name, the
zoom envelope and the zoom→density ladder. Never hardcode any of them in the UI.
`MapLayerControls.tsx` renders `1 dot ≈ {ratio} {unit}` computed live per role
and per zoom (`perDotAtZoom`), not a hardcoded string. When the legend is an
older schema entirely (no `flags`/`attribute` key), `demandLegend.ts` returns
`stale` and disables the layer with a reason rather than crashing or drawing a
plausible-looking empty map.

Race/ethnicity is deliberately NOT a flag: it isn't a transit-propensity
predictor, using it as one is ethically fraught, and the Title VI equity
panel (fed by the coverage pipeline, which does fetch B03002) already serves
that need properly. Don't add a minority flag.

### The union is measured, not invented

A dot is a PERSON, so `prop_all` and `need_all` have to be UNIONS, not sums—a
carless, low-income senior is ONE dot, not three. The old pipeline
solved this by summing the marginals and multiplying by an invented 0.6.
That constant is gone. `puma_union.py` now supplies an estimator built from
actual PUMS microdata:

```
indep     = pop * (1 - Π(1 - share_i))       independence backbone
union_hat = clamp(c(PUMA) * indep, lo, hi)   c() measured from PUMS, Fréchet-clamped
```

`c(PUMA)` (the correction on the independence backbone) and the
zero-vehicle-household→person scale both come from
`demand-dots/data/puma_corrections.csv` (2,462 PUMAs), which is **baked
into the repo**—`build_dots.py` reads it and never touches PUMS at build
time. Regenerate it with `build_puma_corrections.py` (a ~1.2 GB, 51-state
PUMS pull—slow) only when the ACS vintage rolls over; the overlap
structure it measures is stable year to year, so this is not a per-regen
step. Hold-out validation (fit on the state, predict its PUMAs, score
against PUMS truth): 1.66% MAPE for `prop`, ~2% for `need`, against 34% for
the old ×0.6.

Dropping the composite CLASSES did not drop the composite NUMBERS. `prop_all` and
`need_all` are still computed exactly as before; they are simply **constraints on
the flag fit** now (below) rather than classes of their own.

`puma_union.reconcile()` is the mandatory, idempotent choke point: it clips each
union to its Fréchet bounds and re-derives the backdrops as `pop − union`. It runs
at BLOCK-GROUP level, on the raw estimate. It no longer needs a second pass after
apportionment: a block's 16 flag cells are its block group's cells times one
scalar weight, so the block's marginals, both unions and the backdrop are all
roll-ups of a REAL SET SYSTEM and every invariant holds **by construction rather
than by clamping**. The build still asserts them over every block of every state
(`check_invariants(atol=1e-6)` — the `atol` is a float-noise allowance, nothing
more). Running `reconcile()` again on its own output is a no-op by design.

#### BUG FIXED — the Fréchet upper bound on `need_all` was WRONG. Do not revert it.

The obvious bound is Fréchet over all four marginals, `min(Σm, pop)`. It is **not
tight**, and the slack is not harmless:

```
need = prop ∪ (senior ∪ disability)
     ⇒ |need| ≤ |prop| + |senior| + |disability|
```

because the only people `need` can ADD to `prop` are seniors and disabled people.
`Σm = carless + low_income + senior + disability` can exceed
`prop_all + senior + disability` by exactly `min(carless, low_income)` — the
carless ∩ low_income overlap that `prop_all` already deduplicated. Bounding `need`
by `Σm` therefore let `need_all` be clamped to a number **that counts that overlap
twice, and that no set system on earth realizes.**

The correct bound, now in `reconcile()`:

```python
need_hi = np.minimum(prop_all + senior + disability, pop)
```

(It subsumes `min(Σm, pop)`, since `prop_all ≤ carless + low_income` always.)

Under the old class-per-segment schema this was **invisible**: `need_all` was just
a count, nothing cross-checked it against the others, and every disjointness
invariant still passed. Under attribute dots it is **fatal and loud**, because
`need_all` is a feasibility constraint on the 16-cell IPF and the fit simply
cannot converge on an infeasible system. That is how it was found. The schema made
a latent arithmetic lie impossible to hold.

### The JOINT is measured too: 16 cells per PUMA, IPF'd onto each block group

Attribute dots pose a question the class schema never had to answer: **for THIS
dot, which combination of the four flags is it in?** Four flags = 16 combinations,
and the ACS publishes marginals at block group and *no joint distribution below
PUMA*.

Rolling each flag independently at its marginal rate would silently reimpose the
very independence assumption `c()` exists to remove (nationally it inflates the
union by ~10%). So:

1. **Tabulate, don't infer.** `build_puma_corrections.py` counts all 16 cells
   directly from PUMS *person* microdata, weighted by `PWGTP`, per PUMA →
   `data/puma_joint.csv` (2,463 rows: 2,462 PUMAs + a pooled `__default__`). This
   is a **headcount of the joint**, not an estimate: the person file knows every
   person's true combination.
2. **Fit, don't impose.** `joint_flags.fit()` IPFs that PUMA seed onto each block
   group's own six constraints — the four ACS marginals plus both PUMS-derived
   unions — so:

   ```
   Σ cells with flag f    == the block group's ACS marginal for f
   Σ cells with any flag  == its need_all      (nobody vanishes)
   Σ all 16 cells         == its total_pop     (nobody is invented)
   ```

   IPF converges to the distribution satisfying every constraint while staying as
   close as possible to the seed, which is exactly what is wanted: reproduce the
   block group's own ACS numbers exactly, and where the ACS is silent (the joint
   structure) inherit the PUMA's *measured* correlations rather than invent
   independence.

**Fit at BLOCK GROUP, not at block.** The block group is the geography the ACS
actually publishes: its marginals are DATA. A block's marginals are an artifact of
our own apportionment, so fitting a joint to them would be fitting to our own
rounding. It is also ~150x fewer rows, which is what makes a tight tolerance
affordable. The joint is then apportioned DOWN to blocks.

#### Honest limits of the joint (state these; do not quietly drop them)

- **The correlation structure is assumed uniform WITHIN a PUMA** (~100k people).
  The marginals do all the local work. This is an assumption — the same *class* of
  assumption `c()` already makes, but far weaker than independence, and it is the
  strongest thing the published data supports. **Block-group joint distributions
  do not exist in any public product**, so it cannot be validated at that scale by
  us or anyone.
- **Where a block group's marginals are extreme relative to its PUMA, IPF drifts a
  long way from the seed.** It still hits the marginals exactly; it is the residual
  *correlation* that degrades toward whatever the marginals force.
- **50 of the 2,463 PUMA rows have at least one empty cell** (nobody in that PUMA
  is, say, carless + disabled + not-poor + under-65). IPF cannot move mass into a
  zero cell, so the seed is floored at `SEED_FLOOR = 1e-9` of a geography's
  population before fitting. **That floor is the only invented number in the
  module**, and it exists so the fit is always feasible rather than silently
  stalling.
- Convergence tolerance is ABSOLUTE, in people (`TOLERANCE_PEOPLE = 0.05`), not
  relative — a relative tolerance would demand the most precision exactly where
  the numbers are smallest and arithmetic has already forced the answer. The build
  **raises rather than shipping** an unconverged fit.

`joint_flags.py` has no RNG anywhere: same inputs → same cells, bitwise.

National (population-weighted) values, used only as the fallback default—
every build uses the PUMA-specific row:

| value | measured | old pipeline used instead | error corrected |
|---|---|---|---|
| persons per zero-vehicle household | 1.802 | ~2.43 (block group's average household size) | ~35% overcount of `carless` |
| c_prop (carless ∪ low_income) | 0.9485 | 1.0, implicit (summed the marginals) |—|
| c_need (+ senior + disability) | 0.9085 | 1.0, implicit |—|

Puerto Rico publishes no PUMS person file, so its PUMAs fall back to this
national default row (and to the pooled `__default__` joint row) rather than a
measured one—its carless/poverty structure is unlike the mainland's, so its dot
counts are lower-confidence than any state with its own measured PUMA rows.

### Zoom ladder: density is baked into the tiles, and the stride must be the ONLY thinning

There is one grain, `PEOPLE_PER_DOT = 5`, for the whole population universe,
because a population dot is a PERSON and people do not come in grains. (The old
schema had a `per_dot` per class and had to be kept uniform by hand or the map
lied about relative density.)

"1 dot = N people" instead varies with **zoom**, via `ZOOM_DENSITY_LADDER`:

| zoom | stride | 1 dot = |
|---|---|---|
| 8 | 32 | 160 people |
| 9 | 16 | 80 |
| 10 | 8 | 40 |
| 11 | 4 | 20 |
| 12 | 2 | 10 |
| 13 | 1 | **5** (full density) |
| 14 | 1 | 5 |
| 15 | 1 | 5 (overzoomed at z16+) |

The ladder is sized against the **densest tile in the country** (Manhattan at every
zoom from z8 to z14; the Chicago Loop at z15), because the legend states ONE number
and it has to be true there too. It is measured against the BUILT ARCHIVE, not a
model: decode the last archive, bin the real dots into web-mercator tiles with the
tile buffer included, and scale. The `us-2026e` ladder (128/64/…/1) was sized
against an estimate that was ~3x too conservative — its heaviest tile came out at
78k features / 0.30 MB against caps of 300k / 1.5 MB, which is why the map was so
sparse. `us-2026f` spends that headroom: worst tile 313k features / 1.06 MB, and
full density arrives at z13 instead of z15.

The ceiling, for whoever retunes this next: the next rung down (full density at
**z12**) needs a 625k-feature / ~2.4 MB Manhattan tile — 8x today's heaviest. Do not
adopt it without a render measurement.

This has to be baked into the tiles at build time: **Mapbox GL forbids `["zoom"]`
inside a filter expression**, so there is no client-side way to say "draw every
128th dot at z8". Each dot carries a per-CODE running ordinal, and the ordinal's
slot sets a per-feature `tippecanoe: {minzoom}`. The strides form a nesting chain
(each divides the one before it, asserted at import by `_validate_ladder()`), so
the z8 dots are a SUBSET of the z9 dots and a dot never pops out of existence as
you zoom in. Striding **per code** is what keeps the flag mix intact: every cell is
thinned by the same factor, so the z8 sample has the same carless share as the z15
one.

**Why these numbers.** The ladder is sized against the DENSEST TILE IN THE COUNTRY
(Manhattan/Midtown), not a comfortable one, so that no tile ever exceeds the
byte/feature caps and `--drop-densest-as-needed` never has to fire. The cost is
real and worth stating: full density (1:5) now arrives at **z15 rather than z12**.
If the ladder is ever retuned, retune it against the same measurement and re-run
`verify_tiles.py`.

#### BUG FIXED — tippecanoe's default `--drop-rate=2.5` was silently decimating the low zooms

`--drop-rate` is a **global geometric thinning** applied below `--base-zoom` in
every tile, everywhere. It has nothing to do with tile size, and the legend knew
nothing about it. With the old `--base-zoom=12` it kept only `1/2.5^(12-z)` of any
feature that had no explicit per-feature minzoom. Measured over a fixed Missoula
footprint: **the z8 tiles carried 2% of what the legend claimed** (1 dot ≈ 1,850
people, not the advertised 40).

The build is now generated from constants by `build_dots.tippecanoe_command()` so
the runbook cannot hand-type a flag that disagrees with the legend:

```
./.venv/bin/python build_dots.py --cat-verified '../tiles/ldjson/*.ldjson' \
  | tippecanoe --output=../tiles/us-2026f.pmtiles \
    --layer=demand --minimum-zoom=8 --maximum-zoom=15 \
    --drop-rate=1 --base-zoom=8 \
    --maximum-tile-bytes=2000000 --maximum-tile-features=400000 \
    --drop-densest-as-needed \
    --read-parallel --force
```

- `--drop-rate=1` — no dropping. `--base-zoom` is pinned to `TILE_MIN_ZOOM` as
  well, so there is no zoom below base zoom for a drop rate to apply to even if
  someone changes it back.
- **`--extend-zooms-if-still-dropping` is GONE.** It silently extended the pyramid
  past `--maximum-zoom` whenever tiles were still dropping, which is where the
  phantom "z16" came from. The ladder is now sized so nothing drops, which makes
  the built maxzoom deterministic and equal to `TILE_MAX_ZOOM = 15`.
- `--drop-densest-as-needed` is kept as a **safety net only**. The ladder is sized
  so it never fires, and `verify_tiles.py` fails the build if it ever does.

#### CRITICAL: the input is piped through `--cat-verified`, NEVER a bare `cat`

A bare `cat ../tiles/ldjson/*.ldjson | tippecanoe …` is wrong in two ways, both
found the hard way in production, and either alone is enough to block a
publish:

- **It bypasses the staleness gate.** `--cat-verified` checks every input's
  `.meta.json` sidecar against the pipeline's current `config_hash` before it
  emits a single byte, and refuses outright if any input is missing its
  sidecar, unreadable, pre-attribute-dots, or built under a different config
  (`validate_tile_inputs()`/`StaleInputError` in `build_dots.py`). Fifty-two
  leftover `.ldjson` files from a previous schema are exactly the kind of thing
  a bare `cat` would happily splice into a tileset that comes out internally
  consistent and entirely wrong—with no error raised anywhere, because once
  the bytes are concatenated no downstream check can tell a stale state from a
  fresh one.
- **It re-phases the zoom ladder across the whole stream, and a bare `cat`
  reintroduces a real dot bias.** Each dot's per-feature `minzoom` comes from
  its code's running ordinal, taken modulo the ladder's period (128, the z8
  stride)—see `restride_lines()`. That ordinal has to run across the ENTIRE
  archive, not restart per state, or every state's z8 slot (ordinal 0, the
  rarest rung) rounds its count up by an extra dot, and the ~0.5-dot excess per
  code accumulates once per state. `--cat-verified` does this re-phasing at
  concatenation time, the one point where the whole archive exists as a single
  stream. A bare `cat` leaves each of the 52 states' ordinals restarting at
  zero: measured on the real archive, `carless+disability` (121,221 dots)
  carried 28 extra dots at z8 against an expected 947—**+2.9%**, six times
  `verify_tiles.py`'s 0.5% tolerance—and it hits the rarest codes hardest, at
  the lowest zooms only, which is exactly the signature a bare `cat` produces.

Both failures produce a tileset that **passes casual inspection**—it renders,
it looks internally consistent, the totals are plausible—**and fails
verification**. Do not "simplify" the generated command back to a bare `cat`;
that is precisely the bug this flag exists to close.

The mandatory verify step—an archive that fails it must not be published:

```
./.venv/bin/python verify_tiles.py ../tiles/us-2026f.pmtiles \
  --meta '../tiles/ldjson/*.ldjson.meta.json' --legend demand-legend.json
```

#### CRITICAL: EVERY feature carries an explicit minzoom—do not revert this

`iter_dot_features()` stamps `tippecanoe: {minzoom}` on **every dot, always**, even
when the value equals `TILE_MIN_ZOOM`. A feature with no explicit minzoom is one
tippecanoe feels free to thin with its own `--drop-rate`; the dots in the z8 slot
are exactly the ones that used to go unstamped, which is precisely why they were
the ones getting decimated (2% survived) while the rest of the ladder came through
fine. Stating the minzoom on every feature makes the ladder the only thing that
decides what a tile carries.

There is **no per-class minzoom** any more (`OVERLAY_MINZOOM` is gone with the
classes). A flag rides on a person who is in the z8 tile on their own merits.

#### `verify_tiles.py` is MANDATORY after every build

```bash
./.venv/bin/python verify_tiles.py ../tiles/us-2026f.pmtiles \
  --meta '../tiles/ldjson/*.ldjson.meta.json'
```

It re-decodes the built archive and proves **retained == emitted**, per zoom and
per CODE, against what the ladder promises — attributing every feature to the one
tile its coordinates actually fall in, so the tile buffer's ~7% duplicates are not
counted twice. It also checks the archive's own zoom header against the legend and
the pipeline, and the legend's flag bits and jobs code against the pipeline's.

Nothing caught the `--drop-rate` bug for an entire release because **nothing ever
compared what went in to what came out**. A pass means the legend's "1 dot ≈ N" is
true by measurement, not by hope. If it fails, the legend is lying: fix the build,
do not publish.

It has already earned its keep twice. The second catch:

> **zsh gotcha — an unquoted `$FLAGS` variable does NOT word-split.** A build that
> assembled the tippecanoe flags into a shell variable and passed it unquoted had
> them silently ignored, and tippecanoe fell back to its defaults (z0–14, drop-rate
> 2.5). Everything looked fine. `verify_tiles.py` caught it. **Without it, a wrong
> archive would have shipped quietly.** Use the generated command
> (`build_dots.py --emit-tile-cmd`) verbatim; do not template the flags through a
> variable.

The legend's stated "1 dot = N people" is now **true within ±3% at every zoom**,
verified by counting rendered dots.

### Apportionment: it now rounds ONCE, and NOT with largest-remainder

`APPORTION_VERSION = 3`. There used to be two rounding steps and they compounded.
Now there is one.

**Block group → block is an EXACT FLOAT split.** `apportion_state_dots()` multiplies
the block group's 16 flag cells by one scalar weight per block (`POP20` →
`HOUSING20` → `ALAND20` → even split). Nothing rounds there at all. That is what
makes every invariant hold exactly: a block's cells are non-negative, sum to the
block's population, and the weights sum to 1 within each block group, so the
state's totals come back to the ACS totals EXACTLY. (The old code apportioned each
*marginal* to integers here — needed only because a dot count was then derived per
class, per block.)

**The one rounding step is a block's dot budget across its 16 cells** — and
largest-remainder is BIASED there. Do not put it back.

Largest-remainder (Hamilton) is right for apportioning ONE quantity across MANY
units: the remainders vary from unit to unit, so over a state the leftovers land
fairly. It is **wrong** for splitting one block's dots across 16 cells whose shares
are FIXED and wildly unequal, because then the same cells are small in *every*
block and they lose the leftovers *every* time. A block of 125 people gets 25 dots;
the no-flags cell (~55%) wants 13.75 and the carless-only cell (~1.7%) wants 0.42.
Floors hand out 13 and 0; 0.75 beats 0.42 in that block, and in the next block, and
in every block, forever. The rare cells are systematically starved.

Measured on Gallatin County, with largest-remainder here:

| flag | error |
|---|---|
| carless | **−50.7%** |
| disability | **−31.9%** |
| senior | −10.0% |
| low_income | −6.6% |

Every flag under-counted, the rarest ones catastrophically — a map whose "Carless"
layer draws half the carless people it claims. **Every total balanced perfectly,
which is exactly why it would have shipped.**

`_apportion_dots()` now uses **systematic (Cox) randomized apportionment**: walk the
cumulative wanted-dots line and cut it at integer boundaries offset by one seeded
uniform draw.

```python
cum   = cumsum(shares × budget)          # ends exactly at budget
out_c = floor(cum_c - u) - floor(cum_{c-1} - u)
```

Each cell gets `floor(v_c)` or `ceil(v_c)`, with the fractional part decided by
where the cut lands, so `E[out_c] = v_c` **exactly** — no cell is ever
systematically rounded down. The cuts are shared across all 16 cells rather than
drawn independently, so the budget still comes back exact AND the variance is far
below an independent multinomial draw.

### Rounding a block's count into dots: stochastic is the default (densifies rural areas)

This is the step *upstream* of the 16-cell split above: turning a block's
POPULATION into a dot budget at all.

The old `count // per_dot` floor division silently discards each block's
remainder. The loss is proportional to `per_dot` and inversely proportional
to block size, so it hits rural, sparse blocks hardest—measured on the
old 3-class `us-2026b` build, Montana's `high` class (now retired; 1:5)
shipped 24% under-drawn: 43,173 dots where 57,042 was correct, while dense
Massachusetts was off by only about 5%.

The default is now stochastic rounding (`--rounding stochastic`,
`iter_dot_features()`): a block's budget is `floor(q) + 1` with probability
`frac(q)`, so the dot count is correct in expectation for every block and
"1 dot = N" holds nationwide, not just in dense areas. It draws from its own
RNG stream (seed 1337, separate from the placement RNG's seed 42), so
placement of whatever dots do get drawn is unaffected.

**This will visibly densify rural areas relative to `us-2026b`**—that's
the under-draw being corrected, not a bug. `--rounding floor` reproduces
the old (biased) output exactly, if that's ever wanted for an A/B or a
rollback.

### build_all_states.sh: don't revert the fingerprint check

`demand-dots/build_all_states.sh` used to skip any existing non-empty
`dots_{ST}.ldjson`, on the assumption a present file meant "already built."
That broke the moment the class vocabulary changed: a partial nationwide
rebuild would silently keep the old 3-class `.ldjson` for any state it
hadn't reached yet and `cat` it together with freshly-built files from the
new vocabulary—producing a tileset with the new classes present in some
states and missing in others, with no error raised anywhere.

It now fingerprints everything that decides a `.ldjson`'s CONTENT (flag bits, jobs
code, per-universe density, ACS variable list, PUMS corrections **and** joint
tables, apportionment version—`config_hash()` in `build_dots.py`) into each state's
`.meta.json` sidecar, and only skips a state if the sidecar's `config_hash` matches
the current script's. Any change to the flags, to `ACS_VARS`, or a
`puma_corrections.csv` / `puma_joint.csv` regen invalidates every sidecar and forces
a full rebuild on the next run. Keep this check—do not restore "skip if the file
exists."

**The ZOOM LADDER and the zoom envelope are deliberately NOT in the fingerprint**
(they were, until 2026-07-14). They are TILING parameters, not content: the ladder
does decide each dot's baked `tippecanoe.minzoom`, but `--cat-verified` overwrites
that on every feature at concat time (`restride_lines`), and `--cat-verified` is
the only path from `.ldjson` to tileset—`test_gate.py` asserts the generated
tippecanoe command still pipes through it. So **changing the ladder costs a
~60-minute re-tile, not a ~2-hour 52-state rebuild**: leave the `.ldjson` alone and
just re-run the tippecanoe command. The corollary, which must not be lost: if the
concat is ever "simplified" back to a bare `cat`, the ladder has to go BACK into
`config_hash()` in the same commit, or every state will silently tile itself at
whatever ladder it happened to be born with.

**As of 2026-07-14 the current fingerprint is `4e2a79420914` and all 52 states
match it.** `verify_tiles.py` independently refuses any sidecar without a
`code_dots` key, so a stale one cannot slip into a verification pass either.

### Demand-dot regen

```bash
# Prereqs: uv, tippecanoe (brew install tippecanoe), CLOUDFLARE_API_TOKEN with R2 Object Write, CENSUS_API_KEY
cd /Users/clippy2/proj/gtfsx
# 1. if the tile SCHEMA or the density/zoom config changed, bump TILESET_ARCHIVE
#    in demand-dots/build_dots.py (e.g. us-2026d -> us-2026e)—it is a literal in
#    code, not a shell variable; the tiles and demand-legend.json always ship
#    under whatever name is baked in there.
(cd demand-dots && ./.venv/bin/python acs_vintage.py --emit)   # 2. refresh the ACS vintage constant
# 3. check TIGER_YEAR in demand-dots/build_dots.py against the newest TIGER release
# 4. build all states (≤4 parallel, resumable, fingerprinted—also regens
#    demand-legend.json). SKIP THIS ENTIRELY IF THE ONLY THING YOU CHANGED IS THE
#    ZOOM LADDER (or the zoom envelope): those are not in config_hash, the .ldjson
#    on disk are still valid, and the ladder is applied at concat time. Go to 5 —
#    but run `--emit-legend` first, or the legend will still name the old ladder.
(cd demand-dots && ./build_all_states.sh)          #    (≤4 parallel, resumable,
                                                    #    fingerprinted—also regens demand-legend.json).
                                                    #    No manual cache clear needed: the ACS cache
                                                    #    filename already folds in the vintage, the
                                                    #    derived columns and the PUMS-table hash, so a
                                                    #    stale cache from a different config just can't
                                                    #    be reused (rm -rf demand-dots/cache/* is only
                                                    #    for reclaiming disk).

# 5. TILE. Do NOT retype this and do NOT copy an older one out of a runbook: the
#    command is GENERATED from build_dots.py's zoom + ladder constants, which are
#    the same constants the per-feature minzooms and the legend come from. Paste it
#    verbatim — piping it through an unquoted shell variable does NOT word-split in
#    zsh, so tippecanoe silently ignores every flag and falls back to its defaults.
(cd demand-dots && ./.venv/bin/python build_dots.py --emit-tile-cmd)   # then run what it prints

# 6. VERIFY — MANDATORY. Proves retained == emitted per zoom and per code, i.e.
#    that the legend's "1 dot = N people" is what the map actually draws. If this
#    fails, the legend is lying: fix the build, do NOT publish.
ARCHIVE="$(cd demand-dots && ./.venv/bin/python -c 'import build_dots; print(build_dots.TILESET_ARCHIVE)')"
(cd demand-dots && ./.venv/bin/python verify_tiles.py "../tiles/${ARCHIVE}.pmtiles" \
   --meta '../tiles/ldjson/*.ldjson.meta.json')

# 7. UPLOAD via rclone, NOT wrangler: the archive is ~2.2 GB and wrangler hard-fails
#    above 300 MiB. --s3-no-check-bucket is REQUIRED (without it: 403 AccessDenied on
#    CreateBucket). Tilesets go at the bucket ROOT—worker/legacy/tiles.ts reads
#    `${archive}.pmtiles`. Why, and the two ways this silently no-ops:
#    §5 deploy gotchas, "Large R2 uploads".
rclone copyto "tiles/${ARCHIVE}.pmtiles" "r2:gtfs-builder-tiles/${ARCHIVE}.pmtiles" \
  --s3-no-check-bucket --s3-chunk-size 64M --s3-upload-concurrency 4
# Verify against the bucket, not the exit code—a piped `| tail` reports tail's
# exit status, not rclone's, so a failed upload can still report success:
rclone lsl r2:gtfs-builder-tiles/ | grep "${ARCHIVE}.pmtiles"
# 8. commit demand-dots/demand-legend.json (it names the archive the frontend fetches,
#    and carries the flag bits every client-side filter is enumerated from)
#    alongside any TILESET_ARCHIVE bump, and push—CI deploys. No DemandDotsLayer.tsx
#    edit needed: it reads the archive name from the committed legend
#    (demandLegend.ts), with VITE_DEMAND_TILES_ARCHIVE as a build-env override for
#    pointing a dev/staging build somewhere else.
# 9. verify in-browser: toggle the layer, spot-check 3 metros, pick a segment at z8
#    (it must draw — the old schema drew nothing there). 10. (later) delete the
#    prior archive's pmtiles.
```

Other CLI notes: the class-selection flag is now **`--universes`** (`population`,
`jobs`); there are no classes to select. `--emit-legend PATH` writes the legend and
exits.

The tileset's zoom envelope is `TILE_MIN_ZOOM = 8` / `TILE_MAX_ZOOM = 15` in
`build_dots.py`, and it is now **exactly what gets built** — no
`--extend-zooms-if-still-dropping`, so no phantom z16. `DemandDotsLayer.tsx` reads
its `<Source minzoom/maxzoom>` from the legend, and the source maxzoom **must** be a
zoom that exists: declare one deeper and Mapbox requests tiles that were never
built and draws a BLANK layer from that zoom in (this shipped once, when the legend
said 16 and the build said 15). Mapbox overzooms the deepest tiles by itself, so
dots persist at z16+ at their full-density ratio. `verify_tiles.py` asserts the
built archive's own header agrees with both.

### Coverage-layer regen

`demand-dots/coverage-pipeline/` is **no longer standalone**: it imports
`../puma_union.py` — the same union estimator the demand-dot tiles are built
with, not a second copy of it — plus `../data/puma_corrections.csv` and the
tract→PUMA crosswalk. Copy the whole `demand-dots/` directory, not just
`coverage-pipeline/`, to run this elsewhere. It still carries its own copy of
the vintage probe and the CT pin (both inert lookups that resolve dynamically
against the same API and can't drift, unlike the estimator). Keep those two in
sync. See its README for the schema, the largest-remainder apportionment fix,
runtime/RAM, and merge-backend notes.

The `.fgb` schema (2026-07): `geoid, pop, hh, workers, minority, race_pop,
lowinc, pov_univ, zeroveh_hh, occ_hh, senior, youth, carless, disability,
prop_all, need_all, jobs`. `carless`/`disability` are straight ACS counts;
`prop_all` (ridership propensity = carless ∪ low-income) and `need_all`
(transit need = + senior + disability) are the PUMS-derived estimates. The old
`riders` column (renters ∪ carless ∪ adults 18–24, × an invented ×0.6) is gone.

```bash
cd demand-dots/coverage-pipeline
../.venv/bin/python build_us.py --out us-v2.fgb --jobs 4   # ~3-5 h cold, resumable
# Upload via rclone, NOT wrangler: us-v2.fgb is ~1.7 GB and wrangler hard-fails above
# 300 MiB. --s3-no-check-bucket is REQUIRED (without it: 403 AccessDenied on
# CreateBucket). Why, and the two ways this silently no-ops: §5 deploy gotchas,
# "Large R2 uploads". Schema/ordering detail: coverage-pipeline/README.md "Host it".
rclone copyto us-v2.fgb r2:gtfs-builder-tiles/coverage/us-v2.fgb \
  --s3-no-check-bucket --s3-chunk-size 64M --s3-upload-concurrency 4
# Verify against the bucket listing, NOT the exit code:
rclone lsl r2:gtfs-builder-tiles/coverage/
```

`us-v2` is the current value of `COVERAGE_REGION` in
`src/services/blockCoverage.ts` — that constant, not this doc, is the source
of truth for which key to upload to. **Do not upload to `coverage/us.fgb`**:
that object is prod's CURRENTLY-DEPLOYED key, read by an old client that
expects the (retired) `riders` column, and overwriting it in place would make
prod render "High-propensity riders: 0" to real users before prod's own
client ever redeploys — see the "Deploy ordering" note just below, and §5.

The ACS block-group cache key embeds `puma_union.corrections_hash()`, so it
busts automatically when the correction tables or schema change — no manual
cache-dir wipe needed. The old `acs<year>_cov_bg_state_<fips>.csv` cache files
(pre-union schema) are dead; delete them.

**Deploy ordering:** this schema change is breaking in both directions, and
only one of them can be caught client-side. A NEW client reading a STALE/OLD
layer is defended: `blockCoverage.ts` checks every loaded layer for the
union-schema columns and throws `CoverageLayerSchemaError` if they're
missing, so a stale layer degrades to "counts only, no estimate" instead of
rendering a confident wrong number. But an OLD, already-deployed client
reading a NEW layer canNOT be defended in code — that client was built before
this change existed. The fix is at the R2-key level, not the client:
1. Regenerate and upload the layer under the **new** key, `coverage/us-v2.fgb`
   (commands above) — `coverage/us.fgb` is left untouched.
2. Deploy the client (`COVERAGE_REGION = 'us-v2'`) and verify it in prod.
3. Only once prod is confirmed on the new client, delete the old
   `coverage/us.fgb` object from R2.
Any future breaking schema change should repeat this pattern: bump
`COVERAGE_REGION` again rather than overwriting the current key in place. See
`demand-dots/coverage-pipeline/README.md`'s "Deploy ordering" section for the
full detail.

### Nationwide rebuild cost, for planning

Nationwide archives now exist and have been measured end to end:

| build | schema / ladder | dots/person | nationwide pmtiles |
|---|---|---|---|
| `us-2026d` | class-per-segment (9 classes) | ~2.65 | — (never published) |
| `us-2026e` | attribute dots, ladder 128…1 (full density z15) | **1.0** | 1.37 GB |
| `us-2026f` | attribute dots, ladder 32…1 (full density z13) | **1.0** | see §5 |

The state builds (~2h, 52 states) are what produce the 13 GB of `.ldjson`; the
re-tile is ~60-90 min on top. A LADDER-ONLY change needs the re-tile ONLY — the
`.ldjson` are not invalidated by it (see the concat-gate section).

Attribute dots write one dot per person instead of ~2.65, so the nationwide archive
should come out **roughly 2.2x smaller than the equivalent `us-2026d` build** — but
that is an extrapolation from one rural state, so re-measure on the first dense
state that finishes rather than trusting it. Do NOT reuse the old 10-class
projection (~125M dots, ~11 GiB pmtiles): it was for a vocabulary that never
shipped. R2 storage cost is negligible at any of these sizes (order $0.20/mo for a
tens-of-GB archive).

### Sanity checks and known breakages

Total dots within ~5% YoY; file size within ~10%—**except this
attribute-dots regen, which is expected to blow both, and in a known
direction**: total dots FALL by ~2.65x (one dot per person, not per
(person, class)) and file size falls with them. That is the schema change, not a
breakage. Treat the 5%/10% guardrails as active again starting the regen after
this one.

The build's own gates, all of which **raise rather than shipping** a violation:

- `puma_union.check_invariants()` over every block group AND every block of every
  state (partition, ordering, subset, both Fréchet bounds).
- The IPF must converge (`joint_flags.fit` diagnostics); an unconverged fit means
  the tiles would not reproduce the ACS marginals or the PUMS union.
- Cells → marginals reconciliation: the 16 fitted cells must roll back up to the
  ACS numbers they were fitted to, within 0.05%.
- **`verify_tiles.py`**, after tiling — the only check that compares what went IN
  to what came OUT. Not optional. Not a formality.

Per-state population conservation is asserted inside the coverage build and fails
it on drift. Known breakages: LODES lags ACS ~1 yr (label only); the TIGER block
system changes every decennial (next 2030); validate that ACS variable IDs still
return data at block group geography; bump `LODES_BASE` if LODES9 ships. Full
decision log preserved in the archived `demand-dots-nationwide-plan.md`.

## Appendix B — Google Ads offline-conversion (OCI) pipeline

Cookieless ad attribution is shipped: the SPA captures `?gclid=` into the
`event` table (`worker/events/routes.ts`, `src/services/trackBeacon.ts`,
migration 0014); a daily cron uploads conversion events to Google Ads via the
Offline Conversion Import API (`worker/marketing/ads/oci.ts`, dedup-tracked via
`event.oci_uploaded_at`, migration 0015); `/admin` surfaces ads-attribution
status. Campaign strategy + the original spec are in the archived
`GOOGLE_ADS_PLAN.md` (referenced by the 0015 migration comment).
