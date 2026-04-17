# GTFS Builder — Backend Implementation Plan

Companion to `BACKEND_REQUIREMENTS.md`. This is the **how and when** — schema, endpoints, sequencing, and exit criteria for each phase. Read the requirements doc first for the **what and why**.

---

## 0. Approach

### Shipping strategy
Six phases, each independently shippable. Nothing goes live until Phase 3 (publication) — before that, all work happens behind a feature flag and server-backed projects coexist with the existing IndexedDB editor. That protects current users (the editor keeps working on `www.gtfsbuilder.net`) while we build.

Every phase ends with a concrete demo: a thing we can show a user and get feedback on. If a phase's demo isn't right, we pause and fix before moving on.

### Feature flag
One server-side flag (`BACKEND_ENABLED`, Worker env var) and one client-side flag (`VITE_BACKEND_ENABLED`) gate all new UI. Default off until Phase 3 ships.

### Dev/staging/prod
- **Local**: `wrangler dev` against a local D1 instance + local R2 miniflare.
- **Staging**: a second Worker (`gtfs-builder-staging`) on a staging domain (`staging.gtfsbuilder.net`) with its own D1 and R2 buckets. Deployed on every PR merge to `staging`.
- **Prod**: current Worker + new D1/R2 bindings. Deployed on merge to `main`.

### Testing
- **Schema**: migration scripts checked in to `worker/migrations/NNNN_*.sql`; run-forward only, tested against a clean D1 + a seeded D1 in CI.
- **API**: Vitest-based integration tests hitting `wrangler dev` with a test database. Aim for happy-path + auth-boundary + quota coverage on every endpoint.
- **Editor**: extend the existing `run-tests.ts` with new cases for save/restore/publish round-trips once Phase 2 lands.

---

## 1. Schema (final shape)

Defined once here so subsequent phases can reference table names without re-specifying. Tables are created across phases 1–5 — see the "Schema additions" lines in each phase.

```sql
-- auth & identity
user                    (id, email UNIQUE, display_name, status, staff, created_at, updated_at, deleted_at)
credential              (id, user_id, kind[password|google], password_hash, oauth_provider, oauth_subject, created_at)
session                 (id, token_hash, user_id, ip, user_agent, created_at, last_used_at, expires_at, revoked_at)
auth_token              (token_hash PK, user_id, kind[verify_email|magic_link|password_reset|invitation],
                         expires_at, consumed_at, metadata_json)

-- organizations
organization            (id, slug UNIQUE, name, created_at, deleted_at)
organization_membership (org_id, user_id, role[owner|admin|editor|viewer], created_at, PK(org_id,user_id))

-- projects & versions
feed_project            (id, slug, name, description, owner_type[user|org], owner_id,
                         working_state_r2_key, working_state_version, working_state_size,
                         working_state_updated_at, archived_at, deleted_at, created_at, updated_at,
                         UNIQUE(owner_type, owner_id, slug))
feed_version            (id, project_id, label, created_by_user_id,
                         state_r2_key, zip_r2_key, zip_size,
                         summary_json, validation_errors, validation_warnings, created_at)
draft_link              (token_hash PK, project_id, version_id, created_by_user_id,
                         expires_at, revoked_at, created_at)

-- publication
publication             (project_id PK, version_id, published_by_user_id, published_at, canonical_slug)
publication_history     (id, project_id, version_id, action[publish|unpublish|rollback], user_id, created_at)

-- distribution
project_catalog_submission (project_id, catalog[mobility_db|transit_land], external_feed_id,
                            opted_in_at, last_submitted_at, status, PK(project_id,catalog))
project_rt_feed         (id, project_id, kind[vehicle_positions|trip_updates|alerts], url, created_at)

-- ops
audit_event             (id, actor_user_id, subject_type, subject_id, action, metadata_json, ip, created_at)
```

All IDs are ULIDs (lexicographically sortable, URL-safe). Token values are stored as SHA-256 hashes; the cleartext token is emailed / delivered only once.

---

## 2. Phase 1 — Authentication (2–3 weeks)

**Goal:** a logged-in user can reach an authenticated `/api/me` endpoint. No projects yet.

### Schema additions
`user`, `credential`, `session`, `auth_token`.

### Backend deliverables
- Password hashing via `@noble/hashes`' Argon2id (WASM, works in Workers).
- Signup flow: `POST /auth/signup` → create pending user + email-verify `auth_token` → Resend email → `POST /auth/verify` activates.
- Password login: `POST /auth/login` → check credential → issue session cookie.
- Magic-link flow: `POST /auth/magic-link/request` → create `auth_token` → Resend email → `GET /auth/magic-link/consume?token=...` validates and redirects.
- Password reset: `POST /auth/password-reset/request` → email token → `POST /auth/password-reset/confirm` sets new hash, invalidates all sessions.
- Logout: `POST /auth/logout` (this session) + `POST /auth/logout-all` (all sessions for user).
- Session middleware: reads cookie, looks up session by `token_hash`, enforces idle + absolute timeouts (BE-14), refreshes `last_used_at`.
- Rate limiting on all `/auth/*` routes via KV counters keyed on IP + email.
- `GET /api/me` returns current user, or 401.

### Frontend deliverables
- `/login`, `/signup`, `/verify-email`, `/reset-password` routes (React Router — new dependency, minimal).
- Auth modal / page that offers: "Sign in with password" + "Email me a magic link" side-by-side.
- Top-bar account menu: avatar with initials, "Sign out", "Account settings."
- Account settings page: change name, change email (re-verify), change password, sign out of all devices, delete account.

### Secrets to set
`SESSION_SIGNING_KEY` (64 bytes random), `RESEND_API_KEY`, `AUTH_EMAIL_FROM` (e.g. `GTFS Builder <noreply@gtfsbuilder.net>`).

### Exit criteria
- Can sign up, verify email, log in with password, log in with magic link, reset password, log out. All rate-limited.
- `wrangler tail` shows no PII in logs (audit via a dummy run with test email).
- Lighthouse + WCAG pass on auth pages (forms labelled, errors announced).
- Vitest suite covers: happy path, expired token, reused token, mismatched password, rate limit hit, cross-device session usage.

### Demo
"I can create an account on staging, log in from another browser with a magic link, and reach `/api/me`."

---

## 3. Phase 2 — Personal Projects, Sync, and Versions (3–4 weeks)

**Goal:** a logged-in user can create a project, have it autosave to the server, snapshot versions, and restore versions. Still no publish.

### Schema additions
`feed_project`, `feed_version`. Still no `organization` — all projects are `owner_type='user'` in this phase.

### Backend deliverables
- R2 bucket `gtfs-builder-feeds` created (prod + staging). Object keys: `projects/<project_id>/working-state.json.gz`, `projects/<project_id>/versions/<version_id>/state.json.gz`, `projects/<project_id>/versions/<version_id>/gtfs.zip`.
- Project CRUD endpoints (see §8 of requirements doc). Slug uniqueness scoped to `(owner_type, owner_id)`.
- Working-state sync endpoint with optimistic-concurrency version token (BE-41/42). Implementation:
  - Client sends `If-Match: <working_state_version>` header.
  - Server compares to DB; if match, write gzipped blob to R2, increment version, return new token.
  - If mismatch, return 409 with the server's current version.
- Version snapshot endpoint (`POST /api/projects/:id/versions`) — reads current working state, computes summary (counts, date range, validation run, revenue hours from existing `src/services/`), renders a GTFS ZIP from the same state shape the editor uses for export today, writes both blobs, creates `feed_version` row.
- Version list / restore / delete endpoints.
- Quota enforcement on create/save (BE-52). Soft-warn response header (`X-Quota-Warning: 18/20`) plus a body field the frontend surfaces.
- Anonymous → signed-in migration: `POST /api/projects/import` accepts a ZIP of the IndexedDB state, creates a project per local-only feed, preserves slugs if available (collision → suffix).

### Frontend deliverables
- "My feeds" landing page after login — list projects, create new, open, archive/delete, duplicate.
- Editor integration: when a server-backed project is opened, the Zustand store hydrates from server + IndexedDB cache. The existing autosave mechanism now fans out to both IndexedDB (immediate) and a debounced server save (5 s after last edit / on window blur).
- "Someone else edited this feed" modal when the server returns 409 (BE-42).
- Version history panel in the bottom panel: list versions with summary columns (route/stop/trip counts, date range, validation, size), "Save version" button with optional label, "Restore" and "Delete" actions.
- Sign-in banner on anonymous sessions: "Sign in to save your work across devices." On login, prompt to import local-only projects.

### Exit criteria
- Edit a feed on one device, see the change on another device after refresh.
- Save a labelled version, edit, restore, verify state matches.
- Close the browser mid-edit, reopen — editor recovers from last server save.
- Hit the 20-project limit — creation returns 200 with a warning in v1 (soft-warn), flipping the env var `HARD_LIMITS=true` makes it 409.
- Import an IndexedDB project and see it as a server-backed project.

### Demo
"From my laptop I edit a feed, version it, then open it on my phone and see the same state."

---

## 4. Phase 3 — Publication (2–3 weeks) — PUBLIC LAUNCH

**Goal:** flip `BACKEND_ENABLED=true`. Feeds published by users are live at `feeds.gtfsbuilder.net/<slug>/gtfs.zip`.

### Schema additions
`publication`, `publication_history`, `draft_link`.

### Infrastructure
- New custom domain `feeds.gtfsbuilder.net` bound to the same Worker via `wrangler.jsonc` `routes`.
- Worker routing: requests to `feeds.gtfsbuilder.net/*` go through a separate request path that never reads auth cookies — independent code path, independent cache keys.

### Backend deliverables
- Publish endpoint: re-runs validation on the target version; blocks on errors (configurable: ignore warnings, fail on any). On success, upserts `publication` pointing to the version, appends `publication_history`.
- `GET feeds.gtfsbuilder.net/<slug>/gtfs.zip` — looks up `publication` for slug, streams the ZIP from R2 via `ASSETS.fetch` pattern, sets `Cache-Control: public, max-age=3600, s-maxage=3600`, `ETag` from version ID, `Last-Modified` from `published_at`. 304 support.
- `GET feeds.gtfsbuilder.net/<slug>/feed_info.json` — sidecar with title, description, feed_start_date, feed_end_date, version_id, published_at, contact, distribution targets (set up for §6 in Phase 5).
- Draft link endpoints + `GET feeds.gtfsbuilder.net/<slug>/draft/<token>.zip`. Unguessable 192-bit tokens, hashed at rest. `X-Robots-Tag: noindex`.
- `robots.txt` on `feeds.` disallows `/draft/`.
- Cache invalidation on publish: issue a `cache.delete()` for the canonical URL on the Cloudflare cache API (works for edge cache within the colo; full global invalidation not needed for a 1-hour TTL).
- Unpublish: deletes `publication`, subsequent canonical fetch returns `410 Gone`.
- Rollback: syntactic sugar over publish (points at a prior version).

### Frontend deliverables
- Publish panel on a project: pick a version (default: most recent), see validation summary, "Publish" button (disabled if errors). Post-publish: shows the canonical URL, a copy button, "Share draft link" flow.
- Publication history: list of publish/unpublish/rollback events with timestamp + actor.
- Draft link UI: "Share for review" → generates link, lists active links with revoke button.

### Launch checklist
- [ ] DNS for `feeds.gtfsbuilder.net` cut over and propagating (use `wrangler`, not manual DNS).
- [ ] Cache headers verified with `curl -I`.
- [ ] `ETag`/`Last-Modified` round-trip with `If-None-Match` returns 304.
- [ ] Unpublished slug returns 404 (or 410 post-takedown), never 500.
- [ ] `BACKEND_ENABLED=true` and announce to early users.

### Exit criteria
- A published feed is ingestable by OpenTripPlanner (smoke-test against a known feed).
- Publish → edit → republish → consumer polls, gets new `ETag`, downloads new ZIP, validates.
- Draft link works, revoked draft link returns 404, expired draft link returns 410.

### Demo
"Here's a link — paste it into OTP or transit.land and it ingests."

---

## 5. Phase 4 — Organizations (2 weeks)

**Goal:** teams and consultants can share and collaborate on feed projects.

### Schema additions
`organization`, `organization_membership`. Migration on `feed_project` already has `owner_type` so no change there.

### Backend deliverables
- Org CRUD, membership management, invitation flow (uses the same `auth_token` table with kind=`invitation`).
- Invitation email via Resend, includes role + org name, link consumes the token.
- Role-based access middleware: every `/api/projects/:id/*` resolves the project's owner and the current user's role in that owner context. Returns 403 if insufficient.
- Owner-transfer endpoint (owner demotes self after setting another owner).

### Frontend deliverables
- Workspace switcher in the top bar (BE-97): dropdown listing "My personal feeds" + each org. Selection persists in localStorage and as a URL param (`?workspace=org:abc123`).
- Org settings page: name, members + roles, pending invitations, delete org.
- Invitation acceptance page: shows who invited, the org, the role; accept or decline.
- Project-create modal updated with "Owner: Personal | Agency X | Agency Y" selector.

### Exit criteria
- As user A, create org, invite user B as editor, have B log in and edit a shared project.
- As B, leave the org. A's project state unaffected; B no longer has access.
- A consultant user is member of two orgs; switcher shows both; projects are correctly scoped.

### Demo
"I invite Mark's colleague to the Streamline org, she joins, and we both see the same project list."

---

## 6. Phase 5 — Distribution Integrations (1–2 weeks)

**Goal:** published feeds are registered in the catalogs and surface the Google/Apple links.

### Schema additions
`project_catalog_submission`, `project_rt_feed`.

### Backend deliverables
- Mobility DB submission: first publish with opt-in box checked posts to their API (using the already-configured `MOBILITY_DATABASE_REFRESH_TOKEN`). Stores `external_feed_id`. Subsequent publishes call the update endpoint.
- transit.land submission: same pattern; API differs but interface is abstracted behind a `CatalogClient` interface for a clean addition of future catalogs.
- `project_rt_feed` CRUD endpoints.
- ID-stability check on publish (BE-88): diff the about-to-publish version's entity IDs against the currently-published version; if any previously-published `trip_id`/`stop_id`/`route_id`/`agency_id` is missing or changed, attach a warning to the publish response. User can acknowledge and proceed.
- `feed_info.json` enriched with catalog status + RT feed URLs (BE-85, BE-89).

### Frontend deliverables
- Publish panel checklist (BE-84): Mobility DB (auto-submitted ✓), transit.land (auto-submitted ✓), "Apply to Google Transit Partners" (external link + mark-done toggle), "Apply to Apple Maps Transit" (external link + mark-done toggle), "Listed on Transit app" (manual toggle).
- RT feed URL editor: form to register RT feed URLs per kind.
- ID-stability warning dialog: "This publish will break the following IDs referenced by your GTFS-RT feed at `<url>`. Proceed anyway?"

### Exit criteria
- First publish of a real feed appears in MobilityData's catalog within their normal turnaround.
- Remove a `stop_id` and try to publish with an RT feed registered — warning fires.
- Links to Google/Apple application forms open correctly.

### Demo
"I published a test feed, it's in the Mobility DB catalog, and I got a warning when I tried to break IDs."

---

## 7. Phase 6 — Polish & Observability (1–2 weeks)

**Goal:** things stop quietly falling over.

### Deliverables
- **Audit log UI**: per-project action log in a side panel (BE-21, NF-45). Shows publishes, member changes, deletes.
- **Data export** (NF-52): "Download all my data" → ZIP of all projects + versions + JSON profile + audit.
- **Account deletion flow** (BE-5): soft-delete, 30-day grace, hard purge via scheduled Worker cron.
- **Hard-limit mode** (BE-52): flip the env var, verify behavior.
- **Metrics**: usage dashboard for us — DAU, projects created, publishes/week, feed download counts (per-project metric shown to owners in the project panel).
- **Sentry wiring** (NF-72) or Logpush → BigQuery or similar for searchable logs.
- **Abuse handling**: admin view to disable a user, revoke all sessions, take down their publications, freeze new signups by IP.
- **Docs**: user-facing docs on the `docs/` site covering account, versioning, publishing, distribution, troubleshooting.

### Exit criteria
- We can answer "is the service healthy?" and "how many feeds were published this week?" in under 30 seconds.
- A user can export and then delete their account, and nothing referencing them remains after the purge cron runs.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| D1 row size or DB-size limits bite unexpectedly | Already designed around this (R2 for blobs). Monitor D1 DB size weekly; at 70% capacity plan migration. |
| Working-state sync conflicts confuse users | Version token (BE-42) + clear "another device edited this" modal. Never silently lose changes; always offer "keep mine / reload theirs". |
| Magic-link emails caught by spam filters | Use a dedicated sending domain with SPF/DKIM/DMARC, warm it up, monitor Resend's deliverability dashboard. Fall back to password login if a user reports the issue. |
| Argon2id in a Worker is too slow | `@noble/hashes` benchmarks ~100 ms per hash at reasonable params. Acceptable; alternative is bcrypt (similar cost) or delegate to a separate service (overkill). |
| R2 + D1 consistency on publish | Two-phase: write R2 object first, flip D1 pointer second. The ZIP URL reads the D1 pointer on every request, so there's no window where the pointer refers to a missing object. |
| Someone publishes a feed with PII (personal addresses, phone numbers in stop descriptions) | Publish flow includes a validation rule: warn on free-text fields that look like PII patterns. Terms of service require the publisher to have rights. |
| RTAP changes licensing terms | Quota enforcement is a runtime config, not hardcoded. `plan` field on user/org is part of the schema even if everyone is on the same plan at launch. |
| Anonymous → signed-in import clobbers existing project | Collision detection in BE-43: on slug or id collision, prompt, never auto-overwrite. |
| Scheduled-publish gets out of sync if missed | Not in v1 scope (BE-77 is stretch). When we add it, cron trigger runs every minute with a grace window. |

---

## 9. Rough Effort (solo developer)

Assumes continuous focus; reality is probably 1.5–2× these numbers given mixed priorities.

| Phase | Time |
|---|---|
| 1. Auth | 2–3 weeks |
| 2. Projects + sync + versions | 3–4 weeks |
| 3. Publication (launch) | 2–3 weeks |
| 4. Orgs | 2 weeks |
| 5. Distribution | 1–2 weeks |
| 6. Polish | 1–2 weeks |
| **Total to "done"** | **11–16 weeks** |
| **Public launch point** | End of Phase 3 (~7–10 weeks) |

After Phase 3 we're live. Phases 4–6 can stretch across months if RTAP timing allows; the existing users aren't waiting on them.

---

## 10. Immediate Next Steps

If we agree on this plan:

1. Create `worker/migrations/` directory and the first migration file (Phase 1 schema).
2. Add D1 binding + KV binding to `wrangler.jsonc` — separate staging and prod databases.
3. Add `@noble/hashes`, `resend`, and a small router lib (`itty-router` or hono) to dependencies.
4. Scaffold `worker/auth/` with session middleware and empty route handlers.
5. Set secrets: `SESSION_SIGNING_KEY`, `RESEND_API_KEY`, `AUTH_EMAIL_FROM`.
6. First PR: migration + session middleware + `POST /auth/signup` + `GET /api/me`. Small, end-to-end, demonstrates the shape.

After that PR lands and we're happy with the shape, the rest of Phase 1 fills in the gaps.
