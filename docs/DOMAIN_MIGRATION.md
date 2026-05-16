# Domain migration — `gtfsbuilder.net` → `gtfsstudio.net`

> **Status (as of 2026-05-15): ✅ Complete except Phase 12.**
> Phases 1–10 shipped on 2026-05-15 and are verified live (legacy hostnames 301 to gtfsstudio.net with paths preserved — `curl -I https://feeds.gtfsbuilder.net/<slug>/gtfs.zip` returns 301). Phase 11 (catalog notifications) is moot — no feeds were ever submitted to Mobility DB or transit.land under either domain (both integrations remain stubbed; see `BACKEND_STATUS.md` outstanding work). Phase 12 (cleanup of legacy bindings + redirect block) is intentionally deferred until traffic on `gtfsbuilder.net` decays — months out. This doc is preserved as the cleanup checklist for that future cleanup.

Started 2026-05-14. Working runbook — update the checkboxes as steps complete.

## Decisions

| Decision | Choice |
|---|---|
| Brand name | "GTFS Studio" (renamed from "GTFS Builder") |
| Cutover style | Parallel — old domain stays bound to the Worker indefinitely and 301s to the new domain. Preserves `feeds.gtfsbuilder.net/<slug>/gtfs.zip` URLs already polled by external consumers. |
| Email sending domain | `gtfsstudio.net` (subdomain `mail.gtfsstudio.net` optional; not required) |
| Stripe webhooks | Add a new endpoint on the new domain; keep the old endpoint running until cutover is verified, then remove. |

## Subdomain plan

| Purpose | Old | New |
|---|---|---|
| Editor (apex + www) | `gtfsbuilder.net`, `www.gtfsbuilder.net` | `gtfsstudio.net`, `www.gtfsstudio.net` |
| Public feeds + embeds | `feeds.gtfsbuilder.net` | `feeds.gtfsstudio.net` |
| Staging editor | `staging.gtfsbuilder.net` | `staging.gtfsstudio.net` |
| Staging feeds | `staging-feeds.gtfsbuilder.net` | `staging-feeds.gtfsstudio.net` |

---

## Execution order

The phases are sequenced so the new domain is fully validated on staging before any production traffic flips. Each phase is gated on the previous one.

### Phase 1 — Buy + bind the domain (user, ~5 min) ✅

- [x] Register `gtfsstudio.net` (Cloudflare Registrar is easiest — DNS zone is auto-attached).
- [x] If using an external registrar, add the zone to Cloudflare manually.
- [x] Confirm the zone shows "Active" in Cloudflare dashboard.

### Phase 2 — Prep code changes (Claude, ~10 min, can run in parallel with Phase 1) ✅

Branch: `domain-migration-gtfsstudio`.

- [x] `wrangler.jsonc` — `routes[]` (prod + staging), `APP_ORIGIN`, `FEEDS_ORIGIN`, `AUTH_EMAIL_FROM` on both blocks.
- [x] `scripts/setup-stripe.ts` — webhook URLs + `RETURN_URL_BASE` + support email.
- [x] `worker/email/index.ts` — sender footer copy.
- [x] `worker/embeds/{landing,route,stop,systemMap}.ts` — "Powered by …" footer link in 4 embed templates.
- [x] `worker/publication/feeds.ts`, `worker/legacy/imports.ts`, `worker/index.ts` — any fallback origin strings.
- [x] `src/components/auth/{LoginPage,SignupPage}.tsx` — "from gtfsstudio.net" copy.
- [x] `src/components/{billing/PricingPage,billing/WelcomePlanPage,embed/EmbedPanel,publication/PublishPanel}.tsx`, `src/services/orgsApi.ts` — example URLs / contact emails.
- [x] `public/{about,docs,embed-demo,learn/gtfs,learn/gtfs-flex}/index.html`, `index.html` — marketing pages + title/OG meta.
- [x] `tiles/cors.json` — R2 CORS allowed origins.
- [x] `README.md`, all `docs/*.md` including this one and `architecture.svg`.
- [x] `scripts/dev-seed-user.ts` — dev user email domain if used.

### Phase 3 — Cloudflare custom domains (Claude, ~5 min + cert wait) ✅

After Phase 1 zone is active and Phase 2 branch is ready:

- [x] Run `wrangler deploy --env staging` against the branch. Wrangler binds the staging custom domains and Cloudflare provisions edge certs (5–60 min).
- [x] Confirm `https://staging.gtfsstudio.net` returns the SPA (may show "deploying" page until cert lands).
- [x] Production custom domains will bind when we tag for prod in Phase 9.

### Phase 4 — Resend sending domain (user, ~10 min + DNS propagation) ✅

- [x] In [Resend Dashboard](https://resend.com/domains), click **Add Domain** and enter `gtfsstudio.net`.
- [x] Add the SPF, DKIM, and MX records Resend prints into the Cloudflare DNS zone for `gtfsstudio.net`. Records are typically:
  - `TXT` at the apex for SPF: `v=spf1 include:_spf.resend.com ~all`
  - `TXT` at `resend._domainkey` for DKIM (long value Resend provides)
  - Optional `MX` and DMARC
- [x] Wait until Resend marks the domain as **Verified** (usually < 5 min on Cloudflare DNS).
- [x] (Optional) Configure an inbox or alias for `noreply@gtfsstudio.net` and `sales@gtfsstudio.net` — Resend doesn't require an actual mailbox to send.

### Phase 5 — Stripe (user, ~5 min) ✅ staging / ⏳ live pending production launch

- [x] Staging webhook registered: `https://staging.gtfsstudio.net/api/billing/webhooks/stripe` (via `setup-stripe.ts`, default test-mode webhook URL).
- [ ] Prod webhook will register at `https://www.gtfsstudio.net/api/billing/webhooks/stripe` when `setup-stripe.ts --live` runs as part of the production launch.
- [x] Staging signing secret stored as `STRIPE_WEBHOOK_SIGNING_SECRET` worker secret.
- [ ] Prod signing secret will be stored at production launch time.
- [x] No old webhooks to leave active — there were never any `gtfsbuilder.net` webhooks (Stripe was wired up after the rebrand).
- [ ] (Optional, deferrable) Update **Branding** in Stripe Dashboard.

### Phase 6 — Cloudflare Turnstile (user, ~2 min) ✅

- [x] In Cloudflare Dashboard → **Turnstile**, edit the existing site.
- [x] Add hostnames: `gtfsstudio.net`, `www.gtfsstudio.net`, `staging.gtfsstudio.net`.
- [x] Leave the old `gtfsbuilder.net` hostnames in the list (transition period).
- [x] No new secret needed — same site key works across all hostnames.

### Phase 7 — Mapbox (user, ~2 min) ✅

- [x] In [Mapbox Account → Access Tokens](https://account.mapbox.com/access-tokens/), click the public token (`pk.eyJ1...`).
- [x] Under **URL allowlist**, add: `https://gtfsstudio.net/*`, `https://*.gtfsstudio.net/*`.
- [x] Leave the old `gtfsbuilder.net` entries (transition period).
- [x] Save.

### Phase 8 — Staging verification (Claude + user) ✅

Once Phases 3–7 are done:

- [x] Open `https://staging.gtfsstudio.net` in a fresh incognito window.
- [x] Sign up with a real email → Turnstile widget renders → verify-email arrives from the new sending domain → click link → land in editor.
- [x] Run the full `DEPLOY_BACKEND.md` §7 smoke test against the new domain.
- [x] Hit `https://staging.gtfsstudio.net/?ref=migration-test`, check `/admin/events` shows the new ref.
- [x] Stripe test-mode checkout → confirm the new webhook fires and updates `subscription` row in D1.
- [x] On the old domain (`https://staging.gtfsbuilder.net`) — 301 to `https://staging.gtfsstudio.net` once Phase 10 shipped.

### Phase 9 — Production cutover (Claude) ✅

- [x] Merge `domain-migration-gtfsstudio` → `main` via fast-forward.
- [x] Tag `prod-YYYY-MM-DD` to trigger the prod deploy workflow.
- [x] Confirm `https://www.gtfsstudio.net` serves the SPA (cert provisioning may take a few minutes after the deploy completes).
- [x] Production has `BACKEND_ENABLED=false` already, so the editor renders the anonymous-only fallback — same behaviour as before the migration. Re-enabling the backend on prod is a separate, later decision (tracked in `BACKEND_STATUS.md`).

### Phase 10 — 301 redirect old → new (Claude) ✅

Bundled **atomically with Phase 9** — redirect ships in the same commit as the prod cutover so old-domain consumers never see a broken state.

- [x] Added old-domain routes (`gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`, `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`) back to `wrangler.jsonc` so the Worker keeps the bindings.
- [x] Added a 301 redirect at the top of `worker/index.ts`'s `fetch` handler: when `url.hostname === 'gtfsbuilder.net'` or ends in `.gtfsbuilder.net`, swap the suffix to `gtfsstudio.net` and 301. Path + query preserved.
- [x] Verified on staging post-deploy (2026-05-15): `curl -I https://staging.gtfsbuilder.net` → `301`, location `https://staging.gtfsstudio.net/`.
- [x] Verified on prod post-deploy (2026-05-15): `curl -I https://feeds.gtfsbuilder.net/bozeman-demo/gtfs.zip` → `301`, location `https://feeds.gtfsstudio.net/bozeman-demo/gtfs.zip`.

### Phase 11 — Catalog notifications (user, async) — ⏭️ N/A in practice

- [N/A] Notify Mobility Database — verified 2026-05-15: `project_catalog_submission` table on prod has 2 rows, both `status='pending'` with `last_submitted_at=null`. Submission integration remains stubbed (see `BACKEND_STATUS.md` outstanding work), so no external catalog has metadata pointing at the old domain.
- [N/A] Notify transit.land — same.
- [ ] Update any external links you control: landing pages, social profiles, README badges, agency partner sites. (User-side; Claude can't track.)

### Phase 12 — Cleanup (Claude + user, deferred — months later) ⏳

When confident no traffic is hitting the old domain:

- [ ] Remove old-domain custom domain bindings from Cloudflare (`gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`, `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`).
- [ ] Remove the 301 block from `worker/index.ts`.
- [ ] Remove old `gtfsbuilder.net` hostnames from Turnstile + Mapbox allowlists.
- [ ] Remove any old Stripe webhook endpoints (none exist today — Stripe was wired up after the rebrand).
- [ ] Eventually: don't renew `gtfsbuilder.net` domain.

---

## Rollback plan

If something goes wrong between Phase 9 and Phase 10:

1. The old domain is still bound to the Worker and serving traffic normally — there's no irreversible change yet.
2. Revert the `domain-migration-gtfsstudio` merge on `main`, tag a new `prod-…` to re-deploy the old config.
3. The new-domain bindings can be left in place harmlessly.

If something goes wrong after Phase 10 (redirect is live):

1. Comment out the 301 block in `worker/index.ts` and re-deploy. Old domain serves the SPA again.
2. No data is at risk — D1 + R2 are domain-agnostic.

---

## Reference: hostname → service mapping after cutover

| Hostname | Bound to | Behavior |
|---|---|---|
| `gtfsstudio.net` / `www.` | `gtfs-builder` Worker | SPA (kill switch may still be on) |
| `feeds.gtfsstudio.net` | `gtfs-builder` Worker | Public feeds + embeds |
| `staging.gtfsstudio.net` | `gtfs-builder-staging` Worker | SPA |
| `staging-feeds.gtfsstudio.net` | `gtfs-builder-staging` Worker | Public feeds + embeds |
| `gtfsbuilder.net` and all subdomains | `gtfs-builder` / `gtfs-builder-staging` Worker | 301 → corresponding `gtfsstudio.net` host |
