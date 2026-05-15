# Domain migration — `gtfsstudio.net` → `gtfsstudio.net`

Started 2026-05-14. Working runbook — update the checkboxes as steps complete.

## Decisions

| Decision | Choice |
|---|---|
| Brand name | _TBD: keep "GTFS Studio" or rename to "GTFS Studio"_ |
| Cutover style | Parallel — old domain stays bound to the Worker indefinitely and 301s to the new domain. Preserves `feeds.gtfsstudio.net/<slug>/gtfs.zip` URLs already polled by external consumers. |
| Email sending domain | `gtfsstudio.net` (subdomain `mail.gtfsstudio.net` optional; not required) |
| Stripe webhooks | Add a new endpoint on the new domain; keep the old endpoint running until cutover is verified, then remove. |

## Subdomain plan

| Purpose | Old | New |
|---|---|---|
| Editor (apex + www) | `gtfsstudio.net`, `www.gtfsstudio.net` | `gtfsstudio.net`, `www.gtfsstudio.net` |
| Public feeds + embeds | `feeds.gtfsstudio.net` | `feeds.gtfsstudio.net` |
| Staging editor | `staging.gtfsstudio.net` | `staging.gtfsstudio.net` |
| Staging feeds | `staging-feeds.gtfsstudio.net` | `staging-feeds.gtfsstudio.net` |

---

## Execution order

The phases are sequenced so the new domain is fully validated on staging before any production traffic flips. Each phase is gated on the previous one.

### Phase 1 — Buy + bind the domain (user, ~5 min)

- [ ] Register `gtfsstudio.net` (Cloudflare Registrar is easiest — DNS zone is auto-attached).
- [ ] If using an external registrar, add the zone to Cloudflare manually.
- [ ] Confirm the zone shows "Active" in Cloudflare dashboard.

### Phase 2 — Prep code changes (Claude, ~10 min, can run in parallel with Phase 1)

Branch: `domain-migration-gtfsstudio`.

- [ ] `wrangler.jsonc` — `routes[]` (prod + staging), `APP_ORIGIN`, `FEEDS_ORIGIN`, `AUTH_EMAIL_FROM` on both blocks.
- [ ] `scripts/setup-stripe.ts` — webhook URLs (lines 26–27) + `RETURN_URL_BASE` (line 29) + support email (line 95).
- [ ] `worker/email/index.ts` — sender footer copy (line 43).
- [ ] `worker/embeds/{landing,route,stop,systemMap}.ts` — "Powered by …" footer link in 4 embed templates.
- [ ] `worker/publication/feeds.ts`, `worker/legacy/imports.ts`, `worker/index.ts` — any fallback origin strings.
- [ ] `src/components/auth/{LoginPage,SignupPage}.tsx` — "from gtfsstudio.net" copy.
- [ ] `src/components/{billing/PricingPage,billing/WelcomePlanPage,embed/EmbedPanel,publication/PublishPanel}.tsx`, `src/services/orgsApi.ts` — example URLs / contact emails.
- [ ] `public/{about,docs,embed-demo,learn/gtfs,learn/gtfs-flex}/index.html`, `index.html` — marketing pages + title/OG meta.
- [ ] `tiles/cors.json` — R2 CORS allowed origins.
- [ ] `README.md`, all `docs/*.md` including this one and `architecture.svg`.
- [ ] `scripts/dev-seed-user.ts` — dev user email domain if used.

### Phase 3 — Cloudflare custom domains (Claude, ~5 min + cert wait)

After Phase 1 zone is active and Phase 2 branch is ready:

- [ ] Run `wrangler deploy --env staging` against the branch. Wrangler binds the staging custom domains and Cloudflare provisions edge certs (5–60 min).
- [ ] Confirm `https://staging.gtfsstudio.net` returns the SPA (may show "deploying" page until cert lands).
- [ ] Production custom domains will bind when we tag for prod in Phase 9.

### Phase 4 — Resend sending domain (user, ~10 min + DNS propagation)

- [ ] In [Resend Dashboard](https://resend.com/domains), click **Add Domain** and enter `gtfsstudio.net`.
- [ ] Add the SPF, DKIM, and MX records Resend prints into the Cloudflare DNS zone for `gtfsstudio.net`. Records are typically:
  - `TXT` at the apex for SPF: `v=spf1 include:_spf.resend.com ~all`
  - `TXT` at `resend._domainkey` for DKIM (long value Resend provides)
  - Optional `MX` and DMARC
- [ ] Wait until Resend marks the domain as **Verified** (usually < 5 min on Cloudflare DNS).
- [ ] (Optional) Configure an inbox or alias for `noreply@gtfsstudio.net` and `sales@gtfsstudio.net` — Resend doesn't require an actual mailbox to send.

### Phase 5 — Stripe (user, ~5 min)

- [ ] In Stripe Dashboard → **Developers → Webhooks**, click **Add endpoint**.
  - Staging: `https://staging.gtfsstudio.net/api/billing/webhooks/stripe`
  - Prod: `https://www.gtfsstudio.net/api/billing/webhooks/stripe`
  - Same event subscriptions as the existing endpoints (Stripe shows them under the old endpoint's settings — copy the list).
- [ ] Copy the new **signing secret** for each. Set them as Worker secrets:
  ```bash
  wrangler secret put STRIPE_WEBHOOK_SIGNING_SECRET --env staging
  wrangler secret put STRIPE_WEBHOOK_SIGNING_SECRET            # prod
  ```
- [ ] Leave the old webhook endpoints active — they keep Stripe happy until the 301 redirect is in place.
- [ ] (Optional, deferrable) Update **Branding** in Stripe Dashboard if the product name is changing.

### Phase 6 — Cloudflare Turnstile (user, ~2 min)

- [ ] In Cloudflare Dashboard → **Turnstile**, edit the existing site.
- [ ] Add hostnames: `gtfsstudio.net`, `www.gtfsstudio.net`, `staging.gtfsstudio.net`.
- [ ] Leave the old hostnames in the list (transition period).
- [ ] No new secret needed — same site key works across all hostnames.

### Phase 7 — Mapbox (user, ~2 min)

- [ ] In [Mapbox Account → Access Tokens](https://account.mapbox.com/access-tokens/), click the public token (`pk.eyJ1...`).
- [ ] Under **URL allowlist**, add: `https://gtfsstudio.net/*`, `https://*.gtfsstudio.net/*`.
- [ ] Leave the old `gtfsstudio.net` entries (transition period).
- [ ] Save.

### Phase 8 — Staging verification (Claude + user)

Once Phases 3–7 are done:

- [ ] Open `https://staging.gtfsstudio.net` in a fresh incognito window.
- [ ] Sign up with a real email → Turnstile widget renders → verify-email arrives from the new sending domain → click link → land in editor.
- [ ] Run the full `DEPLOY_BACKEND.md` §7 smoke test against the new domain.
- [ ] Hit `https://staging.gtfsstudio.net/?ref=migration-test`, check `/admin/events` shows the new ref.
- [ ] Stripe test-mode checkout → confirm the new webhook fires and updates `subscription` row in D1.
- [ ] On the old domain (`https://staging.gtfsbuilder.net`) — should 301 to `https://staging.gtfsstudio.net` once Phase 10 ships.

### Phase 9 — Production cutover (Claude)

- [ ] Merge `domain-migration-gtfsstudio` → `main` via fast-forward.
- [ ] Tag `prod-YYYY-MM-DD` to trigger the prod deploy workflow.
- [ ] Confirm `https://www.gtfsstudio.net` serves the SPA (cert provisioning may take a few minutes after the deploy completes).
- [ ] Production has `BACKEND_ENABLED=false` already, so the editor renders the anonymous-only fallback — same behaviour as before the migration. Re-enabling the backend on prod is a separate, later decision (tracked in `BACKEND_STATUS.md`).

### Phase 10 — 301 redirect old → new (Claude)

Bundled **atomically with Phase 9** — redirect ships in the same commit as the prod cutover so old-domain consumers never see a broken state.

- [x] Added old-domain routes (`gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`, `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`) back to `wrangler.jsonc` so the Worker keeps the bindings.
- [x] Added a 301 redirect at the top of `worker/index.ts`'s `fetch` handler: when `url.hostname === 'gtfsbuilder.net'` or ends in `.gtfsbuilder.net`, swap the suffix to `gtfsstudio.net` and 301. Path + query preserved.
- [ ] Verify on staging post-deploy: `curl -I https://staging.gtfsbuilder.net` → `301`, location `https://staging.gtfsstudio.net/`.
- [ ] Verify on prod post-deploy: `curl -I https://feeds.gtfsbuilder.net/bozeman-demo/gtfs.zip` → `301`, location `https://feeds.gtfsstudio.net/bozeman-demo/gtfs.zip`.

### Phase 11 — Catalog notifications (user, async)

- [ ] Notify Mobility Database if any feeds were submitted with old-domain URLs (the 301 keeps things working, but their catalog metadata still references the old origin).
- [ ] Notify transit.land similarly.
- [ ] Update any external links you control: landing pages, social profiles, README badges, agency partner sites.

### Phase 12 — Cleanup (Claude + user, deferred — months later)

When confident no traffic is hitting the old domain:

- [ ] Remove old-domain custom domain bindings from Cloudflare.
- [ ] Remove the 301 block from `worker/index.ts`.
- [ ] Remove old hostnames from Turnstile + Mapbox allowlists.
- [ ] Remove the old Stripe webhook endpoint.
- [ ] Eventually: don't renew `gtfsstudio.net` domain.

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
| `gtfsstudio.net` and all subdomains | `gtfs-builder` / `gtfs-builder-staging` Worker | 301 → corresponding `gtfsstudio.net` host |
