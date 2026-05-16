# Deploying the GTFS Studio backend

One-time provisioning + redeploy runbook. Run from `gtfs-studio/` with `wrangler` available (installed via `npm install`). For "what's currently deployed where," see [`BACKEND_STATUS.md`](./BACKEND_STATUS.md).

The deploy gotchas (API token scopes, the `--env=""` quirk, etc.) live in `BACKEND_STATUS.md` so they stay close to the live operational picture. This file covers the steps in order.

---

## 1. Provision Cloudflare resources (one-time)

```bash
# D1 — users, sessions, projects, versions, publications, audit.
wrangler d1 create gtfs-builder
# → paste the printed database_id into wrangler.jsonc
#   at d1_databases[0].database_id (top-level block).

# KV — auth + publish rate-limit counters.
wrangler kv namespace create KV
# → paste the printed id into wrangler.jsonc kv_namespaces[0].id.

# R2 — feed blobs (working states, version snapshots, ZIPs) AND org logos.
wrangler r2 bucket create gtfs-builder-feeds
# (gtfs-builder-tiles already exists for the demand-dot PMTiles archive.)
```

Staging (recommended — rehearse migrations against a separate D1 + R2):

```bash
wrangler d1 create gtfs-builder-staging
wrangler kv namespace create KV --preview
wrangler r2 bucket create gtfs-builder-feeds-staging
# Paste IDs into wrangler.jsonc env.staging block.
```

## 2. Apply database migrations

Migrations live in `worker/migrations/`:

| File | Adds |
|---|---|
| `0001_auth.sql` | `user`, `credential`, `session`, `auth_token`, `audit_event`. |
| `0002_projects.sql` | `organization`, `organization_membership`, `feed_project`, `feed_snapshot` (originally `feed_version`; renamed in 0012), `draft_link`. |
| `0003_distribution.sql` | `publication`, `publication_history`, `project_catalog_submission`, `project_rt_feed`. |
| `0004_branding.sql` | `feed_project.brand_primary_color`. |
| `0005_org_branding.sql` | `organization.brand_logo_r2_key` / `_content_type` / `_updated_at`. |
| `0006_billing.sql` | `user.plan` / `_status` / `_renewal_at` and matching columns on `organization`; `subscription` table; Stripe customer ids. |
| `0007_events.sql` | `event` table for cookieless page-view analytics (no PII). |
| `0008_forum.sql` | Forum: `forum_thread`, `forum_post`, `forum_post_upvote`, `forum_subscription`, `forum_user_state`. |
| `0009_consolidate_consultant.sql` | Migrate `plan='consultant'`/`'consultant_firm'` rows into `'pro'`/`'team'` after dropping the Consultant SKU. |
| `0010_forum_images.sql` | Forum image attachments: `forum_image`. |
| `0011_forum_categories_and_search.sql` | Forum categories + FTS5 `forum_search` virtual table. |
| `0012_rename_version_to_snapshot.sql` | Rename `feed_version` → `feed_snapshot`; rename `version_id` → `snapshot_id` on `draft_link` / `publication` / `publication_history`. |

Apply:

```bash
# Prod
wrangler d1 migrations apply gtfs-builder --remote
# Staging
wrangler d1 migrations apply gtfs-builder-staging --remote --env staging
# Local dev
wrangler d1 migrations apply gtfs-builder --local
```

If the standard `migrations apply` errors on token scopes, fall back to applying the SQL via `execute --file`, then mark the migration as applied (see `BACKEND_STATUS.md` "Deploy gotchas").

## 3. Set secrets

```bash
# Resend — transactional email for verify links, magic links, password resets.
wrangler secret put RESEND_API_KEY
wrangler secret put RESEND_API_KEY --env staging

# Cloudflare Turnstile — captcha gate on /auth/signup.
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put TURNSTILE_SECRET_KEY --env staging
```

`MOBILITY_DATABASE_REFRESH_TOKEN` is already set on both environments (from the existing catalog-search feature).

## 4. Configure Resend sending domain

Point Resend at `gtfsstudio.net` (or a subdomain like `mail.gtfsstudio.net`). Add the SPF / DKIM / DMARC records Resend generates to your DNS. Without this, verify and magic-link emails land in spam.

`AUTH_EMAIL_FROM` in `wrangler.jsonc` must match a verified Resend sender:

- prod: `GTFS Studio <noreply@gtfsstudio.net>`
- staging: `GTFS Studio Staging <staging@gtfsstudio.net>`

## 5. Configure Turnstile

In the Cloudflare dashboard → **Turnstile** → **Add Site**:

- Hostnames: `staging.gtfsstudio.net`, `gtfsstudio.net`, `www.gtfsstudio.net` (one widget covers all environments).
- Mode: **Managed**.
- Copy the **site key** into `.env`'s `VITE_TURNSTILE_SITE_KEY` (public; baked into the SPA bundle).
- Copy the **secret key** into the Worker secret `TURNSTILE_SECRET_KEY` (step 3 above).

## 6. Build + deploy

```bash
npm run build
# Source CLOUDFLARE_API_TOKEN from ~/proj/.env if needed.
npx wrangler deploy --env=""        # prod (top-level block)
npx wrangler deploy --env staging   # staging
```

The empty `--env=""` flag explicitly targets the top-level (prod) block; without it wrangler warns about ambiguity since multiple environments are declared.

## 7. Smoke-test checklist

In an incognito window against the deployed origin:

- [ ] Sign up with a fresh email → Turnstile widget appears, captures a token, signup succeeds, verify email arrives (check spam).
- [ ] Click the verify link → lands on `/?welcome=1`, logged in.
- [ ] Sign out, sign back in with password.
- [ ] Sign out, request magic link, click it from email → logged in.
- [ ] "Forgot password" → receives reset email → set new password → sessions revoked → login with new password works.
- [ ] Account settings → change display name. Change email (→ confirm from new inbox). Change password. Sign out of all devices.
- [ ] Create a project (personal), edit, click Save → see it persisted. Reload — state restored from server.
- [ ] Save a version. Restore. Delete a version.
- [ ] Create an org. Switch workspace via the account menu. Create a project under the org. Move it back to personal via the kebab → Move to….
- [ ] Org settings → upload a brand logo → reload, confirm it renders next to the org name.
- [ ] Publish a version. Visit `feeds.<host>/<slug>/gtfs.zip` (200), `feeds.<host>/<slug>` (mini-site), `feeds.<host>/<slug>/embed/route/<id>` (per-route embed), `feeds.<host>/<slug>/embed/system-map`, `feeds.<host>/<slug>/embed/stop/<stop_id>`.
- [ ] Anonymous editor in another browser → sign in → local IndexedDB feeds offered for import.
- [ ] Visit any non-`/admin` page with `?ref=smoke-test` appended → page loads and the `ref` query param disappears from the address bar. As a staff user, open `/admin/events` and confirm a row with `ref=smoke-test` appears under "Last 7 days".

If any step fails, `wrangler tail` shows structured logs. Each request has a `requestId` in audit metadata to correlate user reports.

## 8. Runtime flags

`vars` in `wrangler.jsonc` (edit + redeploy to change):

| Var | Purpose |
|---|---|
| `BACKEND_ENABLED` | `"false"` hides the sign-in / save / `/feeds*` UI in the frontend. Kill switch — pair with `VITE_BACKEND_ENABLED=false` in the SPA build. |
| `HARD_LIMITS` | `"true"` flips quota behaviour from soft-warn (20 projects / 50 versions / 50 MB ZIP) to hard reject. For post-RTAP-licensing launch. |
| `APP_ORIGIN` | Base URL used in emailed links. `https://www.gtfsstudio.net` in prod; `http://localhost:5173` in dev. |
| `FEEDS_ORIGIN` | Base URL for published feeds + embeds. `https://feeds.gtfsstudio.net` in prod. |
| `MAPBOX_TOKEN` | Public publishable Mapbox token used by the embed renderer (same value as `VITE_MAPBOX_TOKEN`; not a secret). |

## 9. Operator runbook

| Task | Command |
|---|---|
| Tail live logs | `wrangler tail [<env>]` (NB: pass the worker name, not `--env`, e.g. `wrangler tail gtfs-builder-staging`). |
| Run a one-off query | `unset CLOUDFLARE_API_TOKEN; wrangler d1 execute gtfs-builder --remote --command "SELECT ..."` |
| Disable a user | `wrangler d1 execute gtfs-builder --remote --command "UPDATE user SET status='disabled' WHERE email='...'"` |
| Revoke all of a user's sessions | `wrangler d1 execute gtfs-builder --remote --command "UPDATE session SET revoked_at=unixepoch()*1000 WHERE user_id='...'"` |
| Count active users (30d) | `wrangler d1 execute gtfs-builder --remote --command "SELECT COUNT(DISTINCT user_id) FROM session WHERE last_used_at > (unixepoch()-2592000)*1000"` |
| Promote a user to staff | `wrangler d1 execute gtfs-builder --remote --command "UPDATE user SET staff=1 WHERE email='...'"` |
| Reset rate limits during testing | `scripts/reset-rate-limits.sh [staging|prod|local]` |
| Inspect raw page-view events | `wrangler d1 execute gtfs-builder --remote --command "SELECT ts, path, ref, country FROM event ORDER BY ts DESC LIMIT 20"` |
| Purge old events (manual cleanup) | `wrangler d1 execute gtfs-builder --remote --command "DELETE FROM event WHERE ts < (unixepoch()-15552000)*1000"` (older than 180 days) |
