# Backend Status Snapshot

**As of 2026-05-15 (post-launch).** Live operational picture of the backend and embeds. This is the doc you should re-read first when you come back after a break — and the doc you should update when you change deployed state.

The high-level overview is in [`REQUIREMENTS.md`](./REQUIREMENTS.md). The reference spec is in [`BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md). Provisioning instructions are in [`DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md). Embeds spec is in [`EMBEDS_REQUIREMENTS.md`](./EMBEDS_REQUIREMENTS.md).

---

## TL;DR

- **Branch**: `main` is the source of truth.
- **🚀 Production launched 2026-05-15.** Backend re-enabled (`BACKEND_ENABLED=true`, `VITE_BACKEND_ENABLED=true`) and Stripe live-mode billing turned on (`BILLING_ENABLED=true`) in a single coordinated deploy. Live worker at https://www.gtfsstudio.net (version `11a80739-48b6-492e-800a-105902d73b25`). Public feeds + embeds at https://feeds.gtfsstudio.net. Live Stripe Price IDs + portal config + webhook all wired (per the earlier prod-launch testing plan). The 4 grandfathered prod users were preserved through the flip; `mark@eateggs.com` is staff + enterprise.
- **Two SPA hot-fixes shipped immediately after the flip** (both surfaced during smoke test):
  - `+ Create organization…` in the user menu now routes Free/Pro users to `/upgrade?feature=org_workspace` (plan picker, not auto-checkout) instead of opening the inline create form. Server-side gating was already correct; this closes the UX hole that let Free users create empty orgs.
  - `PaywallOverlay` reworked: `bg-white` card on `bg-cream/85` wash (was `bg-cream`-on-`bg-cream`, invisible), `items-start` instead of `items-center`, `h-full overflow-hidden` so the wash + card no longer extend off-screen.
- **Snapshots rename (2026-05-15, post-launch).** What we used to call "versions" (point-in-time saves of editor state) are now uniformly **snapshots** — UI tab "Snapshots", API routes `/api/projects/:id/snapshots[...]`, DB table `feed_snapshot` (FK columns `snapshot_id` on `draft_link` / `publication` / `publication_history`), R2 path `projects/{id}/snapshots/{id}/...`, audit actions `project.create_snapshot` / `restore_snapshot` / `delete_snapshot` (legacy `*_version` strings still render in the audit log via a backward-compat lookup in `auditFormat.ts`), feature key `snapshot_history`. Done now to avoid terminology collision with GTFS spec's own `feed_version` field. Migration `0012_rename_version_to_snapshot.sql` applied on both staging and prod.
- **Staging is also live and ahead of prod.** Editor at https://staging.gtfsstudio.net (worker version `25b35648-9cd2-436b-8c23-20726f7d1a9e`). Public feeds + embeds at https://staging-feeds.gtfsstudio.net. One published demo feed: `bozeman-demo`. Use as the rehearsal env for any future migration.
- **NF-40a (argon2id)** remains the only spec-level technical debt that should land before broad RTAP distribution. Tracked in `BACKEND_REQUIREMENTS.md` §8.1.
- **Analytics.** Cookieless page-view tracking is live: `POST /api/events/track` writes to the `event` table; `/admin/events` aggregates visits + page views grouped by inbound `?ref=` tag. No PII recorded. Now firing on prod since the launch flip.
- **Domain rebrand (2026-05-15).** Product renamed GTFS Builder → GTFS Studio; primary domain moved gtfsbuilder.net → gtfsstudio.net. All five legacy hostnames (apex, www, feeds, staging, staging-feeds) remain bound to the Worker and 301 to their gtfsstudio.net equivalents (path + query preserved). Internal Cloudflare resource identifiers (Worker names `gtfs-builder` / `gtfs-builder-staging`, D1 db names, R2 bucket names) intentionally kept as-is. Runbook: `docs/DOMAIN_MIGRATION.md`. Phase 12 cleanup (remove legacy routes + redirect block) is deferred until traffic on the old domain decays — months from now.

---

## Environments

### Local dev

- Vite at http://localhost:5173, Worker at http://127.0.0.1:8787 via `wrangler dev --local`.
- Vite proxies `/auth`, `/api`, `/_import`, `/_demand-tiles` to the Worker.
- Local D1 + KV + R2 are miniflare-backed (no network).
- `.env` has `VITE_BACKEND_ENABLED=true`, `VITE_TURNSTILE_SITE_KEY`, `VITE_MAPBOX_TOKEN`. `.dev.vars` has `RESEND_API_KEY` + overridden `APP_ORIGIN` / `FEEDS_ORIGIN`. Both gitignored.
- `scripts/dev-seed-user.ts` creates a pre-verified user in the local D1 for quick login without email.

### Staging — LIVE

- Worker: `gtfs-builder-staging` (current version `25b35648-9cd2-436b-8c23-20726f7d1a9e`).
- Custom domains: `staging.gtfsstudio.net`, `staging-feeds.gtfsstudio.net`.
- D1: `gtfs-builder-staging` (id `f62aa5db-329f-4a78-bf35-4b96f79d4392`). Migrations 0001–0012 applied.
- KV: id `ceb1f063c83a4bec9306e66288a51dc8`.
- R2: `gtfs-builder-feeds-staging` (feed blobs + org logos).
- Secrets: `RESEND_API_KEY`, `TURNSTILE_SECRET_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`, `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SIGNING_SECRET` (test).
- Vars: `BACKEND_ENABLED=true`, `BILLING_ENABLED=true`, `HARD_LIMITS=false`, `MAPBOX_TOKEN=…`, plus Stripe **test-mode** Price IDs (`STRIPE_PRICE_PRO_*`, `STRIPE_PRICE_TEAM_*`) and `STRIPE_PORTAL_CONFIG_ID`.
- Cron: `0 3 * * *` (account-deletion reaper + weekly metrics rollup).
- First admin: `mark@eateggs.com` (staff=1). Two demo orgs (`flex-builder-demo-org`, `demo-org`) and one published demo feed (`bozeman-demo`).
- Redeploy: `npm run build && wrangler deploy --env staging` (with `CLOUDFLARE_API_TOKEN` set from `~/proj/.env`).

### Production — LIVE (re-enabled 2026-05-15)

- Worker `gtfs-builder` (current version `11a80739-48b6-492e-800a-105902d73b25`). SPA renders the full editor + auth + billing UI.
- Resources:
  - D1: `gtfs-builder` (id `cfb27d4e-6ba8-488e-95f9-674cc0560cbe`). Migrations 0001–0012 applied.
  - KV: id `da2476e5027346988e380474fa6deef5`.
  - R2: `gtfs-builder-feeds` (and `gtfs-builder-forum-images`).
  - Secrets: `RESEND_API_KEY`, `MOBILITY_DATABASE_REFRESH_TOKEN`, `TURNSTILE_SECRET_KEY`, `STRIPE_SECRET_KEY` (live, `sk_live_…`), `STRIPE_WEBHOOK_SIGNING_SECRET` (live).
  - Vars: `BACKEND_ENABLED=true`, `BILLING_ENABLED=true`, `HARD_LIMITS=false`, plus Stripe **live-mode** Price IDs (`STRIPE_PRICE_PRO_MONTHLY/_ANNUAL`, `STRIPE_PRICE_TEAM_MONTHLY/_ANNUAL`) and `STRIPE_PORTAL_CONFIG_ID="bpc_1TXTFdJHDvzBbFH9qciNWCsV"`.
  - Custom domains bound: `gtfsstudio.net`, `www.gtfsstudio.net`, `feeds.gtfsstudio.net` (+ legacy `gtfsbuilder.net`/`www.`/`feeds.` and `gtfsstudio.com`/`www.` redirecting). SSL certs provisioned.
- Live Stripe webhook endpoint: `we_1TXTFeJHDvzBbFH9o7SviqI4` → `https://www.gtfsstudio.net/api/billing/webhooks/stripe`. Signature verification confirmed end-to-end during Phase 2 of the launch testing plan.
- 4 grandfathered user accounts in prod D1 (`mark@eateggs.com` plan=enterprise/staff=1, plus `mark+test@eateggs.com` and 2 strangers — all plan=free, status=active). 0 published feeds at launch.
- Pre-launch backup of prod D1 lives in `backups/prod-d1-20260515-150154/` (gitignored; 26 tables, 120 KB).
- **Rollback playbook (still valid):** `BILLING_ENABLED=false` alone disables paid checkout/portal but leaves auth + editor up. `BACKEND_ENABLED=false` (with rebuild) hides the entire backend UI. Both are wrangler.jsonc edits + redeploy.

---

## Deploy gotchas

These tripped past deploys; capturing here so the next person doesn't have to retrace:

- **API token scopes.** `CLOUDFLARE_API_TOKEN` (in `~/proj/.env`) needs **Workers KV Storage : Edit** + **Zone : Workers Routes : Edit** for the `gtfsstudio.net` zone. The OAuth token from `wrangler login` is fine for everything except the binding-attach step on first deploy. If a future deploy fails with `code: 10023 (kv bindings require kv write perms)` or `code: 10000 (Authentication error)` on `/zones/.../workers/routes`, re-check the API token at https://dash.cloudflare.com/profile/api-tokens.
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

### Re-enable production checklist — ✅ done 2026-05-15

Kept here as a historical artifact. The full launch testing plan + post-deploy hot-fixes are captured in the TL;DR. Items that surfaced as gotchas during the actual launch (worth knowing if you ever do this again):
- The original `RESEND_API_KEY` on the prod Worker was scoped to the legacy `gtfsbuilder.net` sending domain; the first signup attempt failed with "The associated domain with your API key is not verified." Fix: regenerate a full-access (or `gtfsstudio.net`-scoped) Resend API key and re-`wrangler secret put`.
- Server-side feature gating *was* correctly wired via `requireOwnerFeature` everywhere — but the SPA's `+ Create organization…` button was unconditionally visible, letting Free users create empty Free orgs that they then couldn't do anything with. Fixed with a one-line UserMenu gate (`/upgrade?feature=org_workspace` for Free/Pro).
- `PaywallOverlay` had `bg-cream` cards on a `bg-cream/85` wash → invisible. Switched cards to `bg-white`, `items-start`, `h-full overflow-hidden`. Snapshots tab + Embed panel were the visible victims.

### Phase 7 (embeds) follow-ups

Tracked in `EMBEDS_REQUIREMENTS.md` §3 — main outstanding pieces are the `widgets.js` declarative loader (7c), the headless JSON API (7e), localization, free-text alerts, per-widget impression counts, and the GTFS-RT integration (7f stretch).

### Cross-cutting

- **Worker tests post-rename: 183 passing, 10 failing (all pre-existing infrastructure issues, not rename-related).**
  - 6 in `auth.signup.test.ts` — `setupEmailCapture` spies on `globalThis.fetch` but Resend calls escape the spy (`Resend send failed: 401 unauthorized`); pre-dates the rename.
  - 2 in `projects.snapshots.test.ts` + 2 in `projects.sync.test.ts` — tests assert `Content-Encoding: gzip` on responses but the worker correctly decompresses server-side; assertions are stale.
  - The rename touched `seedUser` to default to `plan='team'` (so paid features are exercised by default; pass `plan:'free'` explicitly when testing paywalls), and added a one-liner in per-file `createOrg` helpers to bump new orgs to `'team'` (since the API path for org upgrade goes through Stripe Checkout, which tests bypass).
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
