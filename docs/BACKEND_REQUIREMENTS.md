# GTFS Builder — Backend Reference

Reference spec for the account / project / publication / distribution backend. The high-level overview lives in [`REQUIREMENTS.md`](./REQUIREMENTS.md) §3–§4; the live operational picture is in [`BACKEND_STATUS.md`](./BACKEND_STATUS.md); deployment instructions are in [`DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md). This file is the long-form companion: data model, full API surface, security posture, and the design decisions that shaped them.

`BE-*` and `NF-*` numbers are anchors that other docs and code comments reference; they're preserved even where the corresponding feature is shipped.

---

## 1. Data model

| Entity | Purpose |
|---|---|
| `user` | One row per person. Email is the primary identifier. |
| `credential` | Auth material attached to a user: password hash or OAuth identity. A user may have multiple. |
| `session` | Active login. HTTP-only cookie scoped to the editor domain. |
| `auth_token` | Single-use bearer tokens hashed at rest: `verify_email`, `magic_link`, `password_reset`, `invitation`. |
| `organization` | Shared workspace for a team. Soft-deletable. |
| `organization_membership` | Many-to-many user↔org with a per-org role. **Many-to-many is critical for consultants** working across multiple agencies. |
| `feed_project` | The editing artifact — one feed. Owned by a user or organization (`owner_type` + `owner_id`). Slug unique per owner. Includes per-project `brand_primary_color`. |
| `project_membership` *(future)* | Per-project access inside an org without org-wide visibility — granted use case is a consultant retained for a single agency feed (BE-95). |
| `feed_version` | Immutable snapshot. Two R2 blobs (gzipped JSON state + rendered ZIP) plus a metadata row with the version summary (BE-46). |
| `draft_link` | Unguessable token (hashed at rest) pointing at a specific feed version, time-limited and revocable. |
| `publication` | "Version X of project Y is live at canonical URL." At most one published version per project at any moment. |
| `publication_history` | Append-only list of publish/unpublish/rollback events. |
| `project_catalog_submission` | Opt-in record per (project, catalog) for Mobility DB / transit.land. Stores the external feed id. |
| `project_rt_feed` | Registered external GTFS-RT feed URLs (BE-87). Metadata only — we don't proxy. |
| `audit_event` | Append-only log of significant actions. |
| `event` | Cookieless page-view log for inbound-referral analytics. One row per route change; no IP, no UA, no user id. `session_id` is a random per-tab value the client holds in sessionStorage; `ref` is the inbound `?ref=…` tag captured once per session. |

Schema lives in `worker/migrations/*.sql`. All IDs are ULIDs (lexicographically sortable, URL-safe). All bearer-token values are SHA-256 hashed at rest — the cleartext is delivered only once.

Per-org branding columns (`brand_logo_r2_key`, `brand_logo_content_type`, `brand_logo_updated_at`) live on `organization`; logo bytes live in the FEEDS R2 bucket and are served publicly via the FEEDS origin.

---

## 2. Authentication and accounts

### 2.1 Sign-up & identity

- **BE-1**: Sign up with email + display name.
- **BE-2**: Email is normalized (lowercase + trimmed) and unique per user.
- **BE-3**: A new account is `pending_verification` until the email is verified.
- **BE-4**: User can change display name, email (with re-verify), password.
- **BE-5**: Account deletion is a soft-delete (30-day grace) followed by hard-purge of PII and any owned feed versions with no other dependents.

### 2.2 Authentication methods

- **BE-10**: Email + password login. Hashes are stored as `pbkdf2$<iter>$<salt>$<hash>` so iteration counts can be raised per-hash without migrating existing credentials.
- **BE-11**: Magic-link login via single-use, 15-minute, rotating token.
- **BE-12**: "Forgot password" reset (single-use, 1-hour token).
- **BE-13**: Sessions are `HttpOnly`, `Secure`, `SameSite=Lax` cookies scoped to the editor origin.
- **BE-14**: Session idle timeout (30 d), absolute timeout (90 d). "Log out of all devices" invalidates all sessions for a user.
- **BE-15**: Per-IP and per-email rate limits on auth endpoints.
- **BE-16** *(deferred)*: Google OAuth as an alternate sign-in. Accounts keyed by verified email so users with existing password credentials can add Google later.

A Cloudflare Turnstile gate sits in front of `/auth/signup` (signup is the primary email-amplification target). The site key is public (in the SPA bundle); the secret is a Worker secret.

### 2.3 Authorization

- **BE-20**: A user can read/write only feed projects they own personally or where their org role grants access. Role matrix: `owner` > `admin` > `editor` > `viewer`.
- **BE-21**: A `staff` flag on the `user` table grants the operator console at `/admin/*`. Staff actions write `audit_event`s with an `admin.*` prefix that surface on the affected user's own audit log.
- **BE-22**: No public read of editor state. Published feeds are public by design; drafts are public-but-unlisted via unguessable tokens.

---

## 3. Organizations

Specced as v1 (rather than v2) because the consultant-across-multiple-agencies workflow is a primary use case.

- **BE-90/91**: Roles: `owner` / `admin` / `editor` / `viewer`. Membership is many-to-many. A feed project is owned by either a user or an org.
- **BE-92**: Invitations email the invitee a single-use token (`auth_token` kind=`invitation`); the invitee accepts (signing up if needed) and joins with the specified role.
- **BE-93**: Roles allow:
  - `owner` — full control, including transfer ownership and delete the org.
  - `admin` — manage members + projects.
  - `editor` — edit projects, publish.
  - `viewer` — read-only (auditors, stakeholders, clients reviewing a consultant's work-in-progress).
- **BE-94**: Last owner cannot leave or self-demote until they transfer ownership.
- **BE-95** *(future)*: Per-project membership — a user can be granted access to a single project inside an org without seeing the rest of the org. Specced; not built.
- **BE-96**: No real-time multi-cursor editing in v1. Last-writer-wins working-state sync (BE-42) with a clear "another device edited this" modal.
- **BE-97**: Workspace switcher in the top bar. Per-workspace project list.

Cross-workspace project transfer is implemented as `POST /api/projects/:id/transfer` — admin+ on the source, editor+ on the destination org. Slug auto-suffixes on collision and `publication.canonical_slug` is updated in lockstep so a published URL keeps pointing at the same project after a move.

---

## 4. Project management

### 4.1 CRUD & sync

- **BE-30**: Create. Slug auto-generated from name; editable; unique per (owner_type, owner_id).
- **BE-31**: List with last-edited time, version count, publication status.
- **BE-32**: Open in the editor — server working state hydrates the Zustand store; local IndexedDB acts as cache.
- **BE-33**: Rename / change description / change slug. Slug change after publication keeps the old slug as a permanent redirect.
- **BE-34**: Archive (hidden from default list, restorable). Soft-delete (30-day grace → hard purge).
- **BE-35**: Duplicate ("start new feed from this one") — copies working state, not version/publication history.

Working-state sync (BE-40/41/42) uses `If-Match` on a monotonic `working_state_version` token. Conflicts return 409 with the server's current version; the client offers "reload theirs / keep mine."

Anonymous → signed-in migration (BE-43): on first sign-in, the local IndexedDB editor uploads any local-only feeds via `POST /api/projects/import` (gzipped base64 snapshots). Slug or id collisions surface a prompt.

### 4.2 Versions

- **BE-44**: Explicit "Save version" creates an immutable named snapshot.
- **BE-45**: Version history view. Restore a version into the working draft.
- **BE-46**: Each version stores a **summary** (route count, stop count, trip count, service-day count, feed start/end dates, weekly revenue hours, ZIP size, validation error/warning counts, populated GTFS files). Lets a reviewer scan "what changed between v12 and v13" at a glance.
- **BE-47**: Per-version `summary.json` sidecar at `feeds.*/<slug>/versions/<vid>/summary.json` (auth-gated). Same data as BE-46, reusable for dashboards.

### 4.3 Storage and quotas

- **BE-50/51**: Working drafts and version JSON blobs live in R2 (gzipped); D1 holds pointer rows. Each version has two immutable R2 objects: state JSON and rendered ZIP.
- **BE-52**: **Quota: 20 projects per owner, 50 versions per project, 50 MB per ZIP.** Soft-warn at the 90% threshold. The runtime flag `HARD_LIMITS=true` flips behaviour to hard reject — intended for the eventual RTAP licensing model.

---

## 5. Publication

### 5.1 Draft links

- **BE-60**: One click on any saved version generates `feeds.*/<slug>/draft/<token>.zip` with an unguessable 192-bit token (hashed at rest).
- **BE-61**: `X-Robots-Tag: noindex`; feeds-origin `robots.txt` disallows `/draft/`.
- **BE-62**: Default 30-day expiry; renewable; revocable.
- **BE-63**: Each draft URL points to a specific `feed_version` so the bytes don't change once shared.
- **BE-64**: `Cache-Control: private, max-age=300`; downloadable filename derived from slug + draft date.

### 5.2 Canonical publication

- **BE-70**: "Publish" promotes a version to `feeds.*/<slug>/gtfs.zip`. URL stable across republishes; only bytes change.
- **BE-71**: Validation gate: errors block; warnings are configurable per-publish.
- **BE-72**: Publication URL is stable; only bytes change across republishes.
- **BE-73**: Cache headers tuned for ingestors: `public, max-age=3600, s-maxage=3600`, version-id ETag, `Last-Modified`, `If-None-Match` 304 support; cache invalidated on publish.
- **BE-74**: `feeds.*/<slug>/feed_info.json` sidecar (title, description, effective dates, version_id, contact, distribution targets, registered RT feeds — see BE-85, BE-89).
- **BE-75**: Unpublish — `410 Gone`; republish restores.
- **BE-76**: Publication history view; rollback ("publish this old version again").
- **BE-77** *(future, stretch)*: Scheduled publish ("go live on date X").

### 5.3 Custom domains

**Not supported.** All published feeds live on `feeds.gtfsbuilder.net/<slug>/...`. Agencies can `301` from their own domain if they want. Eliminates per-tenant cert + CNAME-verification + isolation work.

---

## 6. Distribution integrations

- **BE-80**: One-time opt-in per project at first publish to register with the **Mobility Database**. Subsequent publishes update the same catalog entry automatically — no re-prompt. Implemented against the existing `MOBILITY_DATABASE_REFRESH_TOKEN`.
- **BE-81**: Submission stores the returned `external_feed_id` on `project_catalog_submission`.
- **BE-82**: Catalog link + status surfaced on the publication panel; opt-back-out stops future automatic updates.
- **BE-83**: Same opt-in pattern for **transit.land** — currently stubbed (`status='pending'`, manual-review marker). Pre-RTAP follow-up; the abstraction (`CatalogClient`) is in place.
- **BE-84**: Distribution checklist UI — Mobility DB (auto), transit.land (auto/stub), Google Transit Partners (external link + mark-done), Apple Maps Transit (external link + mark-done), Transit app (manual toggle; auto-discovers via Mobility DB in most cases).
- **BE-85**: `feed_info.json` (BE-74) carries a list of where the feed is known to be distributed; updateable by the user.
- **BE-86**: Generic GTFS consumers — valid `HEAD`, correct `ETag`/`Last-Modified`, stable filename for cheap polling.

### GTFS-Realtime coordination

We don't host or generate RT feeds, but many agencies have an existing one that references the static feed by ID:

- **BE-87**: A project can record one or more external GTFS-RT feed URLs (trip_updates, vehicle_positions, alerts). Metadata only.
- **BE-88**: On publish, **ID-stability check** diffs the about-to-publish version's entity IDs against the currently-published version. Any removed/renamed `trip_id`/`stop_id`/`route_id`/`agency_id` triggers a warning ("This will break your registered RT feed at `<url>`. Re-check after publishing."). User acknowledges and proceeds; not a hard block.
- **BE-89**: Registered RT URLs are included in `feed_info.json` and forwarded to Mobility DB / transit.land.

---

## 7. API surface

JSON over cookie-auth for the editor; fully public reads on the FEEDS origin. The list below is the source of truth for endpoints.

### Editor origin (auth-gated except `/auth/*`)

| Method & Path | Purpose |
|---|---|
| `POST /auth/signup` | Start signup; sends verify email (Turnstile-gated) |
| `POST /auth/verify` | Consume email-verify token |
| `POST /auth/login` | Password login |
| `POST /auth/magic-link/request` | Request magic link |
| `GET  /auth/magic-link/consume` | Consume magic-link token (redirects on success) |
| `POST /auth/logout` | End current session |
| `POST /auth/logout-all` | End all sessions for current user |
| `POST /auth/password-reset/request` | Start password reset |
| `POST /auth/password-reset/confirm` | Consume reset token, set new password |
| `GET  /api/me` | Current user, memberships, usage against quota |
| `PATCH /api/me` | Change display name |
| `POST /api/me/email/change` | Start email change (re-verify) |
| `POST /api/me/password` | Change password |
| `DELETE /api/me` | Soft-delete account |
| `GET  /api/me/export` | Stream a ZIP of all the user's data |
| `GET  /api/orgs` | Orgs the user belongs to |
| `POST /api/orgs` | Create an org |
| `GET  /api/orgs/:id` | Org detail (members, project count) |
| `PATCH /api/orgs/:id` | Rename / change slug |
| `DELETE /api/orgs/:id` | Soft-delete (cascades to org-owned projects) |
| `POST /api/orgs/:id/logo` | Upload brand logo (multipart, ≤1 MB, PNG/JPEG/WebP/SVG) |
| `DELETE /api/orgs/:id/logo` | Remove brand logo |
| `POST /api/orgs/:id/invitations` | Invite by email + role |
| `GET  /api/orgs/:id/invitations` | List pending invitations |
| `DELETE /api/orgs/:id/invitations/:tokenHash` | Rescind an invitation |
| `PATCH /api/orgs/:id/members/:uid` | Change a member's role |
| `DELETE /api/orgs/:id/members/:uid` | Remove member (or self-leave) |
| `POST /api/orgs/:id/transfer` | Transfer ownership |
| `POST /api/orgs/invitations/accept` | Accept an invitation |
| `GET  /api/orgs/invitations/pending` | The current user's pending invitations |
| `GET  /api/projects?scope=personal\|org:<id>&include_archived=1` | List projects in a workspace |
| `POST /api/projects` | Create (`owner: { type: 'user' \| 'org', id? }`) |
| `GET  /api/projects/:id` | Get project + working-state pointer |
| `PATCH /api/projects/:id` | Update name/slug/description/archivedAt/brandPrimaryColor |
| `DELETE /api/projects/:id` | Soft-delete |
| `POST /api/projects/:id/transfer` | Move between workspaces |
| `GET  /api/projects/:id/working-state` | Fetch gzipped JSON |
| `PUT  /api/projects/:id/working-state` | Replace (If-Match version-token guarded) |
| `POST /api/projects/:id/versions` | Snapshot current working state |
| `GET  /api/projects/:id/versions` | List versions with per-version summary |
| `GET  /api/projects/:id/versions/:vid/state` | Fetch a version's gzipped JSON state |
| `POST /api/projects/:id/versions/:vid/restore` | Restore as the working draft |
| `DELETE /api/projects/:id/versions/:vid` | Delete a version |
| `POST /api/projects/:id/draft-links` | Create a draft URL token |
| `GET  /api/projects/:id/draft-links` | List active draft links |
| `DELETE /api/projects/:id/draft-links/:tokenHash` | Revoke |
| `POST /api/projects/:id/publish` | Publish (validation + ID-stability gated) |
| `POST /api/projects/:id/unpublish` | Take down |
| `POST /api/projects/:id/publish/rollback` | Rollback to a prior version |
| `GET  /api/projects/:id/publish/history` | Publication history |
| `POST /api/projects/:id/catalog-submissions` | Opt in to Mobility DB / transit.land |
| `PUT  /api/projects/:id/rt-feeds` | Register/update RT feed URLs |
| `GET  /api/projects/:id/audit` | Per-project action log |
| `POST /api/projects/import` | Bulk-import local IndexedDB feeds (signed-in migration) |
| `POST /api/events/track` | Cookieless page-view beacon (no auth; CSRF-gated; rate-limited 120/min/IP) |
| `GET  /api/admin/events/summary?from=&to=` | Staff-only: visits + page views grouped by `ref` over a time window |
| `GET  /api/admin/*` | Operator console — staff-only, returns 404 to non-staff |

### Feeds origin (no auth)

| Method & Path | Purpose |
|---|---|
| `GET feeds.*/<slug>/gtfs.zip` | Canonical published feed |
| `GET feeds.*/<slug>/feed_info.json` | Sidecar metadata |
| `GET feeds.*/<slug>/draft/<token>.zip` | Unlisted draft URL |
| `GET feeds.*/<slug>` | Mini-site landing page |
| `GET feeds.*/<slug>/embed/route/<route_id>` | Per-route embed |
| `GET feeds.*/<slug>/embed/stop/<stop_id>` | Per-stop embed |
| `GET feeds.*/<slug>/embed/system-map` | System-overview embed |
| `GET feeds.*/_/orgs/<org_id>/logo` | Per-org brand logo |
| `GET feeds.*/robots.txt` | `Disallow: /` (feeds aren't for crawling) |

---

## 8. Non-functional requirements

### 8.1 Security

- **NF-40**: Passwords hashed via Web Crypto's `PBKDF2-HMAC-SHA256` at 100,000 iterations — the current workerd ceiling. Matches NIST SP 800-63B's minimum but is below OWASP 2023's 600k recommendation. Hashes are stored in a self-describing format (`pbkdf2$<iter>$<salt>$<hash>`) so a future higher-cost algorithm can co-exist with legacy hashes. Raw passwords and full hash strings are never logged.
- **NF-40a** *(follow-up, before RTAP broad distribution)*: Swap to argon2id via WASM (`hash-wasm` or equivalent). Target <150 ms per hash at `m=19MiB, t=2, p=1` per OWASP 2023. `verifyPassword` must remain dual-path so legacy PBKDF2 hashes keep authenticating until each user's first successful sign-in re-hashes them.
- **NF-41**: All bearer tokens (verify, magic-link, password-reset, draft-URL, invitation) are cryptographically random ≥128 bits, single-use where applicable, and SHA-256 hashed at rest.
- **NF-42**: CSRF defense — `X-GB-Client: web` header required on state-changing endpoints (browsers can't set custom headers cross-origin without preflight; combined with `SameSite=Lax` cookies this stops drive-by CSRF).
- **NF-43**: Rate limiting on auth and publish endpoints (KV-backed counters, per IP + per email).
- **NF-44**: Content-Security-Policy headers on the editor origin.
- **NF-45**: Audit log captures login, logout, password change, publish, unpublish, delete, member changes, ownership transfer, admin impersonation, project transfer, logo upload/remove.

### 8.2 Privacy

- **NF-50**: PII stored: email, display name, IP + user-agent on active sessions, and the contents of feeds the user creates. No billing data, no marketing profile.
- **NF-51**: Email is never shared with third parties. No marketing without explicit opt-in.
- **NF-52**: Data export — `GET /api/me/export` returns a ZIP of all the user's projects, versions, profile, and audit log.
- **NF-53**: Hard-purge 30 days after account deletion (cron in `worker/cron/tasks.ts`).
- **NF-54**: Analytics are cookieless. The `event` table records `path`, `ref`, a per-tab sessionStorage id, and the country code from `CF-IPCountry`. No IP, no User-Agent, no user id, no cross-session linkage. `?ref=` is stripped from the URL on capture so it doesn't propagate into shared links.

### 8.3 Availability & performance

- **NF-60**: Published feed URLs served from Cloudflare's edge cache. Target p95 < 100 ms worldwide for a cached fetch.
- **NF-61**: Editor API p95 < 500 ms for non-publish endpoints.
- **NF-62**: Working-draft save is safe to retry (idempotent on version token).
- **NF-63**: Publication is atomic — consumers never see a partial ZIP; the D1 pointer flips only after the new R2 object is fully uploaded.

### 8.4 Observability

- **NF-70**: Cloudflare Workers Analytics + Logpush for the API.
- **NF-71** *(planned)*: Per-project usage metrics shown to the owner (DAU, projects created, publishes/week, feed download counts).
- **NF-72** *(planned)*: Error reporting (Sentry or Logpush sink) with PII redaction.
- **NF-73**: First-party page-view analytics. The frontend fires `POST /api/events/track` on every SPA route change (excluding `/admin/*`) via `fetch(..., { keepalive: true })`. `?ref=` is captured once per session into sessionStorage, then stripped from the URL via `history.replaceState`. The staff-only dashboard at `/admin/events` aggregates visits (distinct `session_id`) and page views grouped by `ref` over preset windows (7d / 30d / all / custom). See `worker/events/routes.ts` and `src/services/trackBeacon.ts`.

---

## 9. Decisions appendix

Captures the "why is it built that way?" decisions from initial review. These don't change; they're here so future maintainers can find the rationale without digging through git history.

| # | Question | Decision |
|---|---|---|
| 1 | Auth UX primary path | Both email+password and magic link ship in v1; user picks per login. |
| 2 | Google OAuth in v1 or later | v1.1, deferred. ~60% adoption-data signal exists but it's not a launch blocker. |
| 3 | Teams / organizations timing | v1. Many-to-many user↔org membership ships from day one to support consultants. |
| 4 | Free-tier limits | 20 projects, 50 versions/project, 50 MB/ZIP. Soft-warn → hard-limit via runtime flag. |
| 5 | Publication URL scheme | Subdomain `feeds.gtfsbuilder.net/<slug>/`. Cleaner cache + auth-cookie boundaries. |
| 6 | Database for working drafts | R2 with D1 pointer. Avoids D1's 2 MB row limit; keeps us on one platform. |
| 7 | Custom domains for published feeds | Not supported. Agencies `301` from their own domain if needed. |
| 8 | Catalog auto-submission | One-time opt-in per project, auto-update thereafter. |
| 9 | Anonymous → signed-in migration | Auto-import on sign-in; prompt only on collision or quota overflow. |
| 10 | Pricing intent | License to RTAP, free to RTAP members. Quota the same for everyone. |
| 11 | Captcha provider | Cloudflare Turnstile (Managed mode). Already on Cloudflare; no third-party tracking. |
| 12 | Per-org branding storage | Logo bytes in R2 (`gtfs-builder-feeds`); served public via FEEDS origin. Brand color is a hex column on `feed_project` (per project, not per org — consultants who manage three agencies want three colours). |
