# Deploying the GTFS Builder backend

One-time setup for the Phase 1 + Phase 2 backend (auth + feed management). Run from `gtfs-builder/` with `wrangler` available (installed via `npm install`).

## 1. Provision Cloudflare resources

```bash
# D1 — holds users, sessions, projects, versions, audit.
wrangler d1 create gtfs-builder
# → copy the database_id printed and paste it into wrangler.jsonc
#    at d1_databases[0].database_id (replace REPLACE_WITH_D1_ID).

# KV — rate-limit counters.
wrangler kv namespace create KV
# → copy the id and paste it into wrangler.jsonc at
#   kv_namespaces[0].id (replace REPLACE_WITH_KV_ID).

# R2 — feed blobs (working states, version snapshots, ZIPs).
wrangler r2 bucket create gtfs-builder-feeds
```

Staging (optional but recommended — lets you rehearse migrations before prod):

```bash
wrangler d1 create gtfs-builder-staging
wrangler kv namespace create KV --preview
wrangler r2 bucket create gtfs-builder-feeds-staging
```

## 2. Apply database migrations

```bash
# Prod
wrangler d1 migrations apply gtfs-builder --remote
# Local dev (wrangler dev --local uses a local SQLite)
wrangler d1 migrations apply gtfs-builder --local
```

Wrangler picks up migrations from `worker/migrations/` (configured in `wrangler.jsonc`). Today that's `0001_auth.sql` and `0002_projects.sql`.

## 3. Set secrets

```bash
# Resend — transactional email for verify links, magic links, password resets.
wrangler secret put RESEND_API_KEY
# Paste your Resend API key when prompted.
```

`MOBILITY_DATABASE_REFRESH_TOKEN` is already set (from the existing catalog-search feature).

## 4. DNS / custom hostname for the feeds subdomain

Only needed once Phase 3 (publication) lands. You can skip this during Phase 1/2 rollout.

```bash
# Adds feeds.gtfsbuilder.net as a custom domain on the Worker.
# wrangler.jsonc already lists the route; this just creates the DNS record.
wrangler deploy --dry-run
# then: in the Cloudflare dashboard, confirm the DNS CNAME for 'feeds'.
```

## 5. Configure Resend sending domain

Point Resend at `gtfsbuilder.net` (or a subdomain like `mail.gtfsbuilder.net`). Add the SPF, DKIM, and DMARC records Resend generates to your DNS. Without this, verify / magic-link emails land in spam.

`AUTH_EMAIL_FROM` in `wrangler.jsonc` (`GTFS Builder <noreply@gtfsbuilder.net>`) must match a verified Resend sender.

## 6. Deploy

```bash
npm run build
wrangler deploy
```

## 7. Smoke-test checklist

After deploy, walk through this in an incognito window against `www.gtfsbuilder.net`:

- [ ] Sign up with a fresh email → receives verify email (check spam).
- [ ] Click the verify link → lands on `/?welcome=1`, logged in.
- [ ] Sign out, sign back in with password.
- [ ] Sign out, request magic link, click it from email → logged in.
- [ ] "Forgot password" → receives reset email → set new password → sessions revoked, login with new password works.
- [ ] Account settings → change display name. Change email (→ confirm from new inbox). Change password. Sign out of all devices.
- [ ] Create a project, edit, see it autosave. Reload — state restored from server.
- [ ] Save a version. Restore the version. Delete a version.
- [ ] Anonymous editor in another browser → sign in → local project imports.

If any step fails, check `wrangler tail` for structured logs. Each request has a `requestId` in its audit metadata to correlate user reports with logs.

## 8. Runtime flags

These are `vars` in `wrangler.jsonc` — edit and redeploy to change them:

| Var | Purpose |
|---|---|
| `BACKEND_ENABLED` | `false` hides the sign-in UI in the frontend. Use this as a kill switch pre-launch. |
| `HARD_LIMITS` | `true` flips quota behavior from soft-warn (20/50/50 MB) to hard-block. Intended for post-RTAP-licensing launch. |
| `APP_ORIGIN` | Base URL used in emailed links. Set to `https://www.gtfsbuilder.net` in prod, `http://localhost:5173` for local dev. |
| `FEEDS_ORIGIN` | Base URL for published feeds (Phase 3). `https://feeds.gtfsbuilder.net`. |

## 9. Operator runbook

| Task | Command |
|---|---|
| Tail live logs | `wrangler tail` |
| Run a one-off query | `wrangler d1 execute gtfs-builder --remote --command "SELECT ..."` |
| Disable a user | `wrangler d1 execute gtfs-builder --remote --command "UPDATE user SET status='disabled' WHERE email='...'"` |
| Revoke all a user's sessions | `wrangler d1 execute gtfs-builder --remote --command "UPDATE session SET revoked_at=unixepoch()*1000 WHERE user_id='...'"` |
| Count active users (30d) | `wrangler d1 execute gtfs-builder --remote --command "SELECT COUNT(DISTINCT user_id) FROM session WHERE last_used_at > (unixepoch()-2592000)*1000"` |
