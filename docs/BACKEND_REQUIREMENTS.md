# GTFS Builder — Backend Requirements (Draft)

## 0. Purpose & Scope

Today GTFS Builder is a pure browser app: everything lives in IndexedDB, and the only server-side code is a small Cloudflare Worker that proxies tiles and the Mobility Database catalog. This document proposes the feature set for a backend that adds:

1. **User accounts** — identity, sessions, password/passwordless auth, account recovery.
2. **Feed management** — server-side storage of feed projects so users can work across devices, recover from data loss, and organize multiple feeds.
3. **Feed publication** — publish a feed to a stable public URL, share unlisted draft URLs for review, and optionally register the canonical URL with public GTFS catalogs.

This is a **feature-set doc**, not an implementation plan. §11 captures the decisions made during review — refer there for the rationale behind anything that looks under-specified above.

**Commercial model:** This product is intended to be licensed to the **Rural Transit Assistance Program (RTAP)**, which will provide free access to its member agencies. Every user gets the same quota (see BE-52), enforced as hard limits. No in-app billing in v1.

---

## 1. Architecture Recommendation

### Stay on Cloudflare
The existing site is deployed as a Worker-with-static-assets on `gtfsbuilder.net`, with R2 for tiles. Extending the same Worker keeps the stack simple, deploys through the same `wrangler` pipeline, and avoids a second origin.

| Concern | Proposed Service |
|---|---|
| Relational data (users, feeds, versions, publications) | **Cloudflare D1** (SQLite) |
| Feed ZIP blobs (per-version) | **Cloudflare R2** (new bucket, e.g. `gtfs-builder-feeds`) |
| Session tokens / rate-limit counters | **Cloudflare KV** (or a `sessions` table in D1) |
| Transactional email (verify, magic link, password reset) | **Resend** (already used in sibling projects) |
| Background jobs (nightly re-validate, catalog re-register) | **Cron Triggers** on the same Worker |
| Secrets (`RESEND_API_KEY`, session signing key, OAuth client secrets) | `wrangler secret put` |

Alternatives considered — a separate Node/Postgres backend, Supabase/Clerk/Auth0 — all add another origin, another bill, and another deploy surface. D1 + R2 is sufficient for the expected data shape (mostly small rows; the bulk of bytes are versioned ZIPs in R2). If we later outgrow D1 we can migrate without breaking the app contract.

### Public URL layout
```
www.gtfsbuilder.net/                        # editor SPA (unchanged)
www.gtfsbuilder.net/api/...                 # authenticated API
www.gtfsbuilder.net/auth/...                # login, signup, callback, magic-link landing

feeds.gtfsbuilder.net/<slug>/gtfs.zip           # canonical published feed
feeds.gtfsbuilder.net/<slug>/feed_info.json     # sidecar metadata (BE-74, BE-85)
feeds.gtfsbuilder.net/<slug>/draft/<token>.zip  # unlisted draft URL
```

The `feeds.` subdomain lets us cache published feeds aggressively and keeps auth cookies scoped to the editor origin so they never leak on public feed fetches.

---

## 2. Data Model (Entities)

| Entity | Purpose |
|---|---|
| `user` | One row per person. Email is the primary identifier. |
| `credential` | Auth material attached to a user: password hash, OAuth identity, or magic-link secret. A user may have multiple. |
| `session` | Active login. HTTP-only cookie on the editor domain. |
| `organization` *(see §7)* | Shared workspace for a team. |
| `organization_membership` | Many-to-many join: a user belongs to any number of orgs with a role per org. **Critical for consultants** who work across multiple agency orgs simultaneously. |
| `feed_project` | The editing artifact — one "feed" the user is working on. Owned by a user or organization. Has a slug, name, description, and a current working draft. |
| `project_membership` *(optional, v2)* | Fine-grained access: grant a specific user access to one project inside an org without seeing the org's other projects. Useful when a consultant should only see the one feed they're hired to work on. |
| `feed_version` | Immutable snapshot of a feed project's contents at a point in time. Stored as a GTFS ZIP in R2 plus a metadata row, along with a **version summary** (see BE-46). |
| `publication` | Says "version X of project Y is live at this URL." At most one published version per project at any moment. |
| `audit_event` | Append-only log of significant actions (login, publish, delete) for later debugging and user-visible history. |

---

## 3. User Accounts & Authentication

### 3.1 Sign-up & identity
- **BE-1**: Users sign up with an email address and a display name.
- **BE-2**: Email addresses are normalized (lowercase, trimmed) and unique per user.
- **BE-3**: A new account is inactive until the email is verified (click a link emailed via Resend).
- **BE-4**: Users can update display name, email (with re-verification), and delete their account.
- **BE-5**: Account deletion is a soft-delete for 30 days (grace period), then a hard purge of PII and owned feed versions that have no other dependents.

### 3.2 Authentication methods
**v1 ships with both email+password and magic link** — the user picks per login. Magic link removes the "forgot password" problem for casual users; password is faster for daily users. Google OAuth follows in v1.1 based on adoption data (~60% of signup-ready users click "Sign in with Google" when offered).

- **BE-10**: Email + password login. Passwords hashed with Argon2id (or bcrypt, cost≥12).
- **BE-11**: Magic-link login. Email a single-use, short-lived (15 min), rotating token; one click logs the user in on the device that requested it.
- **BE-12**: "Forgot password" flow emails a reset token (single-use, 1-hour expiry).
- **BE-13**: Sessions are HTTP-only, `Secure`, `SameSite=Lax` cookies scoped to `gtfsbuilder.net`.
- **BE-14**: Session idle timeout (default 30 days), absolute timeout (default 90 days). "Log out of all devices" invalidates all sessions for a user.
- **BE-15**: Rate-limit auth endpoints per IP and per email (e.g. 10 attempts / 10 min).
- **BE-16** *(v1.1)*: Google OAuth as an alternate sign-in. Accounts keyed by verified email — a user who previously signed up with email+password can add Google later and log in either way. Microsoft OAuth deferred until an RTAP member agency requests it.

### 3.3 Authorization & roles
- **BE-20**: A user can read/write only feed projects they own personally or where their org role grants access (see §7 for role matrix).
- **BE-21**: A `staff` flag on the `user` table gives us (the operators) support access — used only for debugging, gated behind an explicit "impersonate" audit entry visible to the user whose account was accessed.
- **BE-22**: No public read of editor state. Published feeds are public by design; drafts are public-but-unlisted via unguessable tokens.

---

## 4. Feed Project Management

### 4.1 CRUD
- **BE-30**: Create a feed project. Name required; slug auto-generated from name but editable (unique per owner, lowercased-ASCII-dashes).
- **BE-31**: List a user's feed projects with last-edited time, publication status, and version count.
- **BE-32**: Open a feed project in the editor — loads the current working draft into the existing IndexedDB-backed editor state.
- **BE-33**: Rename / edit description / change slug. Changing slug after publication keeps the old slug as a permanent redirect.
- **BE-34**: Archive a feed project (hidden from default list, still restorable). Delete a feed project (soft-delete 30 days → hard purge).
- **BE-35**: Duplicate a feed project ("Start new feed from this one") — copies the current working state but not the publication/version history.

### 4.2 Editor sync
The editor currently autosaves to IndexedDB. We add server sync on top, not instead.

- **BE-40**: When a logged-in user opens a server-backed project, the editor loads the server's current working state and continues to autosave locally.
- **BE-41**: Local changes are pushed to the server on a debounce (e.g. 5 s after last edit, or on window blur), as a single "save working draft" call that replaces the server's working state.
- **BE-42**: Last-writer-wins with a version token. If the user's session has stale working state (e.g. edited on another device), the server rejects the save and the editor prompts: "This feed was edited elsewhere — reload or keep my changes?"
- **BE-43**: Anonymous use continues to work (IndexedDB only). A banner invites sign-in. **On sign-in, any local-only IndexedDB projects are automatically imported to the server** and the local copy becomes a cache of the server version. If import would exceed the account quota (BE-52), the user is prompted to pick which projects to keep. If a local project was also opened as a server-backed project in the same browser (collision by slug or id), prompt rather than overwrite.
- **BE-44**: Explicit "Save version" creates a named, immutable `feed_version` snapshot. Users can label it (e.g. "March 2026 service change").
- **BE-45**: Version history view: list versions with timestamp, label, author, size, validation summary. Restore any version back into the working draft.
- **BE-46**: Each version stores a **summary** computed at snapshot time: route count, stop count, trip count, service-day count, `feed_start_date`/`feed_end_date`, total revenue hours (we already compute this for costs), ZIP size, validation error/warning counts, and which GTFS files are populated. Shown inline in the version history so the user can scan "what changed between v12 and v13" without opening each version.
- **BE-47**: Per-version `summary.json` sidecar available at `feeds.gtfsbuilder.net/<slug>/versions/<vid>/summary.json` (authenticated; owner/org-member only). Same data, reusable for future dashboarding.

### 4.3 Storage format
- **BE-50**: Working drafts and version JSON live in **R2**, with a pointer row (path, size, hash, content-type, created-at) in D1. D1 stays small and fast; R2 handles arbitrarily large feed state. Working-draft blobs are gzipped before upload (GTFS JSON compresses ~10–20×).
- **BE-51**: Each version stores **two** R2 objects: the internal JSON store state (for restore/edit) and the rendered GTFS ZIP (for publish/draft serving without re-render). Both are immutable once written.
- **BE-52**: **Quota per account (user or org): 20 projects, 50 versions per project, 50 MB per ZIP.** Launch behavior: **soft-warn** ("You're at 18/20 projects — archive old ones or delete versions to free space."). Under the RTAP licensing model these become **hard limits** — hitting a limit blocks creation until space is freed. The transition from soft to hard is a config change, not a code change.

---

## 5. Publication

### 5.1 Draft URL (for review / stakeholder sign-off)
- **BE-60**: One click on any saved version: "Get review link." Generates `feeds.gtfsbuilder.net/<slug>/draft/<token>.zip` with an unguessable token.
- **BE-61**: Draft URLs are unlisted (no directory listing, no indexing — `X-Robots-Tag: noindex`, `robots.txt` disallows `/draft/`).
- **BE-62**: Draft URLs can be revoked. Default expiry: 30 days, renewable.
- **BE-63**: A draft URL points to a specific `feed_version`, so the bytes never change once the link is shared.
- **BE-64**: Drafts serve with `Cache-Control: private, max-age=300` and a `Content-Disposition` filename like `<slug>-draft-2026-04-17.zip`.

### 5.2 Canonical publication
- **BE-70**: "Publish" promotes a specific version to the canonical URL: `feeds.gtfsbuilder.net/<slug>/gtfs.zip`.
- **BE-71**: Publication blocks on validation: warnings allowed, errors not. (Same validator the editor already runs.)
- **BE-72**: Published URL is stable across republishes; only the bytes change.
- **BE-73**: Cache headers tuned for GTFS consumers: `Cache-Control: public, max-age=3600, s-maxage=3600`, correct `ETag`, `Last-Modified`. Publishing invalidates the edge cache.
- **BE-74**: `feeds.gtfsbuilder.net/<slug>/feed_info.json` returns a small JSON sidecar (title, description, feed_start_date, feed_end_date, current version id, published_at, owner-contact) — useful for dashboards and for us.
- **BE-75**: Unpublish (takedown) — returns `410 Gone`. Republish restores.
- **BE-76**: Publication history view: show every time this project has been published, with rollback ("Publish this old version again").
- **BE-77** *(stretch)*: Scheduled publish — "go live on 2026-06-01 at 02:00 UTC." Cron trigger flips the pointer.

### 5.3 Custom domains
**Not supported.** All published feeds live on `feeds.gtfsbuilder.net/<slug>/...`. If an agency wants their own domain later, they can `301` from it to our URL. Dropping custom-domain support removes a whole class of cert-management, CNAME-verification, and tenant-isolation work.

---

## 6. Distribution Integrations

### 6.1 Mobility Database
We already read from MobilityData's catalog (see `worker/index.ts`). For outbound registration:

- **BE-80**: **One-time opt-in per project.** When the project is first published, the user checks a box: "Register this feed with the Mobility Database." From then on, subsequent publishes update the same catalog entry automatically — no re-prompt.
- **BE-81**: On first submission we POST to MobilityData's API (falling back to generating a contribution PR if the API isn't available). Store the returned `feed_id` on the project.
- **BE-82**: Surface catalog link and submission status in the publication panel. Let the user opt back out (stops future automatic updates; doesn't remove the existing entry).

### 6.2 transit.land
- **BE-83**: Same pattern — one-time opt-in per project, reuse feed handle on subsequent publishes.

### 6.3 Google Maps / Apple Maps / Transit app
These platforms don't have open registration APIs — they require partner applications. We don't automate, but we make the step unforgettable:

- **BE-84**: Publication panel shows a checklist of distribution targets: Mobility DB (auto-submitted), transit.land (auto-submitted), Google Transit Partners (link to application form), Apple Maps Transit (link to application form), Transit app (link; auto-picked up from Mobility DB in most cases). Each item has a status and a "mark as done" toggle that the user maintains.
- **BE-85**: `feed_info.json` (BE-74) includes a list of where the feed is known to be distributed. Updateable by the user.

### 6.4 Generic GTFS consumers
- **BE-86**: Serve valid HTTP `HEAD`, correct `ETag`/`Last-Modified`, and stable `gtfs.zip` filename so any trip-planner ingestor (OTP, Transitland, Google, Apple) can poll cheaply.

### 6.5 GTFS-Realtime coordination
We do **not** host or generate GTFS-RT feeds in v1 (different infrastructure pattern — live protobuf streams, not bytes-on-disk). But many agencies have an existing RT feed that references the static feed by ID, so we need to avoid breaking it:

- **BE-87**: A project can record one or more external GTFS-RT feed URLs (trip-updates, vehicle-positions, service-alerts). These are metadata only — we don't proxy them.
- **BE-88**: On publish, if the project has a registered RT feed, run an **ID-stability check** comparing the about-to-publish version against the currently-published version: any removed or renamed `trip_id`, `stop_id`, `route_id`, or `agency_id` triggers a warning — "This change will break your GTFS-RT feed. Re-check after publishing." Not a hard block — the user may know their RT producer already handles the change.
- **BE-89**: Registered RT URLs are included in `feed_info.json` and forwarded to Mobility DB / transit.land so downstream consumers can discover them.

---

## 7. Collaboration (v1)

Agencies rarely have a single person owning the feed, and the consultant workflow (one person serving multiple agencies) is a primary use case. The organization/membership model ships in v1.

- **BE-90**: An `organization` has members with roles: `owner`, `admin`, `editor`, `viewer`. Membership is a many-to-many relationship — **one user can belong to many organizations, and vice versa**. This is explicitly designed to support consultants who work with multiple agencies simultaneously.
- **BE-91**: A feed project is owned by a user **or** an organization; if the latter, all members have access per their org role.
- **BE-92**: Invite flow: owner/admin enters email + role, we send an invite link. Invitee accepts (signs up if needed) and joins the org with the specified role.
- **BE-93**: Role definitions: `owner` (full control incl. billing/delete org), `admin` (manage members + projects, no billing), `editor` (edit all projects, publish), `viewer` (read-only — good for auditors, stakeholders, or a client who wants to see their consultant's work-in-progress).
- **BE-94**: Leaving an org is user-initiated; removing a member is owner/admin-only. The last owner cannot leave or demote themselves until they transfer ownership.
- **BE-95**: *(v2)* **Per-project membership** (`project_membership`) for finer-grained access — grant a user access to one project in an org without adding them to the org itself. Use case: a consultant retained to update only one of an agency's three feeds. Role on the project overrides inherited org role.
- **BE-96**: No real-time multi-cursor editing in v1 — last-writer-wins (BE-42) is sufficient, with the version-token warning.
- **BE-97**: "Switch workspace" affordance in the top bar: users with membership in multiple orgs (consultants, multi-agency staff) see a dropdown of orgs + "My personal feeds." Feed lists are scoped to the active workspace.

---

## 8. Public / Authenticated API Surface

All JSON, cookie-auth for the editor, optional API tokens for programmatic use.

| Method & Path | Purpose |
|---|---|
| `POST /auth/signup` | Start signup; sends verify email |
| `POST /auth/verify` | Consume email-verify token |
| `POST /auth/login` | Password login |
| `POST /auth/magic-link/request` | Request magic link |
| `GET  /auth/magic-link/consume` | Consume magic-link token (redirect on success) |
| `POST /auth/logout` | End current session |
| `POST /auth/password-reset/request` | Start password reset |
| `POST /auth/password-reset/confirm` | Consume reset token, set new password |
| `GET  /api/me` | Current user, memberships, and usage against quota |
| `GET  /api/orgs` | Orgs this user belongs to |
| `POST /api/orgs` | Create an org |
| `PATCH /api/orgs/:id` | Rename / transfer ownership |
| `GET  /api/orgs/:id/members` | List members + roles |
| `POST /api/orgs/:id/invitations` | Invite user by email + role |
| `PATCH /api/orgs/:id/members/:uid` | Change member role |
| `DELETE /api/orgs/:id/members/:uid` | Remove member (or self-leave) |
| `GET  /api/projects?scope=personal\|org:<id>` | List projects in a workspace |
| `POST /api/projects` | Create project (body specifies owner: self or `org:<id>`) |
| `GET  /api/projects/:id` | Get project + current working state |
| `PATCH /api/projects/:id` | Update name/slug/description; archive/unarchive |
| `DELETE /api/projects/:id` | Soft-delete |
| `PUT  /api/projects/:id/working-state` | Replace working draft (version-token guarded) |
| `POST /api/projects/:id/versions` | Snapshot current working state as a version |
| `GET  /api/projects/:id/versions` | List versions with per-version summary (BE-46) |
| `POST /api/projects/:id/versions/:vid/restore` | Restore a version as working draft |
| `POST /api/projects/:id/draft-links` | Create draft-URL token for a version |
| `DELETE /api/draft-links/:token` | Revoke draft link |
| `POST /api/projects/:id/publish` | Publish a version canonically (validation-gated) |
| `POST /api/projects/:id/unpublish` | Take down the canonical feed |
| `POST /api/projects/:id/catalog-submissions` | Submit to Mobility DB / transit.land (one-time opt-in) |
| `PUT  /api/projects/:id/rt-feeds` | Register/update external GTFS-RT feed URLs (BE-87) |
| `GET  /api/projects/:id/audit` | Action log for this project |

Public feed URLs (no auth):
- `GET feeds.gtfsbuilder.net/:slug/gtfs.zip`
- `GET feeds.gtfsbuilder.net/:slug/feed_info.json`
- `GET feeds.gtfsbuilder.net/:slug/draft/:token.zip`

---

## 9. Non-Functional Requirements

### 9.1 Security
- **NF-40**: Passwords Argon2id-hashed; never logged.
- **NF-41**: All auth tokens (verify, magic-link, password-reset, draft-URL) are cryptographically random (≥128 bits), single-use where applicable, and hashed at rest (so a DB leak doesn't expose live tokens).
- **NF-42**: CSRF protection on all state-changing endpoints (double-submit cookie or SameSite=Strict on a dedicated CSRF cookie).
- **NF-43**: Rate limiting on auth and publish endpoints (KV-backed counters).
- **NF-44**: Content-Security-Policy headers on the editor origin.
- **NF-45**: Audit log captures: login, logout, password change, publish, unpublish, delete, admin impersonation.

### 9.2 Privacy
- **NF-50**: PII stored: email, display name, IP + user-agent on active sessions (for security review), and the content of feeds the user creates. No billing info (§0), no marketing profile, nothing else by default.
- **NF-51**: Email is never shared with third parties. We don't send marketing without explicit opt-in.
- **NF-52**: Data export: user can download all their data as a ZIP (all projects + versions + JSON of their profile/audit log).
- **NF-53**: Data deletion: hard-purge 30 days after account deletion (BE-5).

### 9.3 Availability & performance
- **NF-60**: Published feed URLs served from Cloudflare's edge cache. Target: p95 < 100 ms worldwide for a cached fetch.
- **NF-61**: Editor API p95 < 500 ms for non-publish endpoints (D1 + single-region R2 latency).
- **NF-62**: Working-draft save is safe to retry (idempotent on version token).
- **NF-63**: Publication is atomic — consumers never see a partial ZIP; the pointer flips only after the new object is fully uploaded.

### 9.4 Observability
- **NF-70**: Cloudflare Workers Analytics + Logpush for the API.
- **NF-71**: Basic product metrics: DAU, projects created, publishes per week, feed download counts per project (shown to the owner).
- **NF-72**: Error reporting (Sentry or Cloudflare's built-in tail/logpush) with PII redaction.

---

## 10. Out of Scope

- Real-time collaborative editing (multi-cursor).
- GTFS-Realtime feed generation or hosting (we coordinate with existing RT feeds only — see §6.5).
- In-app billing. Commercial model is RTAP licensing (§0).
- Custom domains for published feeds (§5.3).
- Feed diffs / visual compare between versions. *(Per-version summary stats — BE-46 — give you "what changed" at a glance without building full diffs.)*
- Public "directory" of feeds hosted on the site (would require moderation).

---

## 11. Decisions (resolved during review)

| # | Question | Decision |
|---|---|---|
| 1 | Auth UX primary path | **Both email+password and magic link** ship in v1; user picks per login (BE-10, BE-11). |
| 2 | Google OAuth in v1 or later | **v1.1** — after launch, based on adoption data showing ~60% would click it (BE-16). |
| 3 | Teams / organizations timing | **v1.** Many-to-many user↔org membership ships from day one to support consultants across agencies (§7). |
| 4 | Free-tier limits | **20 projects, 50 versions/project, 50 MB/ZIP.** Soft-warn at launch; hard limits under RTAP licensing (BE-52). |
| 5 | Publication URL scheme | **Subdomain:** `feeds.gtfsbuilder.net/<slug>/gtfs.zip`. Cleaner cache and auth-cookie boundaries (§1). |
| 6 | Database for working drafts | **R2 with D1 pointer.** D1 for metadata; R2 for all JSON blobs and ZIPs, gzipped. Avoids D1's 2 MB row limit and keeps us on one platform (BE-50, BE-51). |
| 7 | Custom domains for published feeds | **Not supported.** Agencies can `301` from their own domain if needed (§5.3). |
| 8 | Catalog auto-submission | **One-time opt-in per project**, auto-update thereafter (BE-80, BE-83). |
| 9 | Anonymous → signed-in migration | **Auto-import** local IndexedDB projects on sign-in; prompt only on collision or quota overflow (BE-43). |
| 10 | Pricing intent | **License to RTAP**, free to RTAP members. No in-app billing. Quota is the same for everyone and enforced as hard limits (§0, BE-52). |

Anything new that comes up during implementation lands here as a follow-up — this section is the changelog of "why is it built that way?"
