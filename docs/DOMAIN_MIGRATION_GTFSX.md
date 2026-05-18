# Domain + brand migration — `gtfsstudio.net` → `gtfsx.com` (GTFS·X rebrand)

> **Status (2026-05-18 14:10 UTC): editor cut over.** Prod + staging editor (`gtfsx.com`, `www.gtfsx.com`, `staging.gtfsx.com`) live. All legacy 301 chains verified single-hop. **Outstanding:** feeds subdomain certs still provisioning at CF (5–60 min normal); user actions left for CF Workers Builds Variables (`VITE_MAPBOX_TOKEN`) and Stripe webhook re-registration. See checklist below.

Started 2026-05-18. Working runbook — update the checkboxes as steps complete.

## Decisions

| Decision | Choice |
|---|---|
| Brand name | "GTFS·X" (middle dot, U+00B7). Was "GTFS Studio". Spoken: "G-T-F-S X". |
| Canonical domain | `gtfsx.com` (was `gtfsstudio.net`). |
| Cutover style | Parallel — `gtfsstudio.net`, `gtfsstudio.com`, and `gtfsbuilder.net` stay bound to the Worker indefinitely and 301 to the matching `gtfsx.com` host. Preserves `feeds.gtfsstudio.net/<slug>/gtfs.zip` URLs already polled by downstream consumers (which themselves are the post-rebrand replacements for the original `feeds.gtfsbuilder.net` URLs). |
| Email sending domain | `gtfsx.com`. Subdomain `mail.gtfsx.com` optional. |
| Stripe webhooks | Add new endpoint on the new domain. Keep the old endpoint running until cutover is verified, then remove. |
| Tagline | Unchanged — "GTFS Builder and Editor". |

## Subdomain plan

| Purpose | Previous (canonical) | New (canonical) |
|---|---|---|
| Editor (apex + www) | `gtfsstudio.net`, `www.gtfsstudio.net` | `gtfsx.com`, `www.gtfsx.com` |
| Public feeds + embeds | `feeds.gtfsstudio.net` | `feeds.gtfsx.com` |
| Staging editor | `staging.gtfsstudio.net` | `staging.gtfsx.com` |
| Staging feeds | `staging-feeds.gtfsstudio.net` | `staging-feeds.gtfsx.com` |

Legacy hostnames still bound (all 301 to the matching `gtfsx.com` host with path + query preserved):

- `gtfsstudio.net`, `www.gtfsstudio.net`, `feeds.gtfsstudio.net`, `staging.gtfsstudio.net`, `staging-feeds.gtfsstudio.net`
- `gtfsstudio.com`, `www.gtfsstudio.com`, `staging.gtfsstudio.com`
- `gtfsbuilder.net`, `www.gtfsbuilder.net`, `feeds.gtfsbuilder.net`, `staging.gtfsbuilder.net`, `staging-feeds.gtfsbuilder.net`

---

## Execution order

Same shape as the prior `gtfsbuilder.net` → `gtfsstudio.net` runbook (`DOMAIN_MIGRATION.md`).

### Phase 1 — Buy + bind the domain (user) ✅

- [x] `gtfsx.com` registered and the DNS zone is active in Cloudflare (per user 2026-05-18).
- [x] Confirm zone shows "Active" in Cloudflare dashboard.

### Phase 2 — Prep code changes (Claude) — this branch

- [x] `wrangler.jsonc` — add `gtfsx.com` routes (prod + staging), promote to canonical, update `APP_ORIGIN`, `FEEDS_ORIGIN`, `AUTH_EMAIL_FROM` on both blocks.
- [x] `worker/index.ts` — redirect `gtfsstudio.net`/`gtfsstudio.com`/`gtfsbuilder.net` → corresponding `gtfsx.com` host.
- [x] `scripts/setup-stripe.ts` — webhook URLs + `RETURN_URL_BASE` + support email.
- [x] `scripts/dev-seed-user.ts` — dev origin.
- [x] `worker/email/index.ts` — sender footer + brand name.
- [x] `worker/embeds/{landing,route,stop,systemMap}.ts` — "Powered by …" footer link in 4 embed templates.
- [x] `worker/forum/{seo,notify,dispatcher}.ts` — community brand name and fallback origin.
- [x] `worker/publication/feeds.ts`, `worker/legacy/imports.ts`, `worker/import/routes.ts` — fallback origins and User-Agent.
- [x] `src/components/layout/AppBrand.tsx` — swap logo + wordmark text.
- [x] `src/components/auth/{LoginPage,SignupPage}.tsx` — "from gtfsx.com" copy + subtitle.
- [x] `src/components/{billing/PricingPage,billing/WelcomePlanPage,embed/EmbedPanel,publication/PublishPanel}.tsx`, `src/services/orgsApi.ts` — example URLs + contact emails.
- [x] `src/components/community/{CommunityRoot,ProfileEditor}.tsx`, `src/components/help/HelpPage.tsx` — brand + logo.
- [x] `public/{about,docs,docs/quick-start,docs/deep-links,embed-demo,learn/gtfs,learn/gtfs-flex,privacy-policy}/index.html`, `index.html` — marketing pages + title/OG meta + canonical URLs.
- [x] `public/favicon.svg` + new `public/gtfsx-*.svg` brand assets dropped in alongside the legacy `gtfs-studio-logo.svg` (deprecated; still served for legacy deep-link buttons until ecosystem partners update).
- [x] `README.md`, `docs/*.md` (except `DOMAIN_MIGRATION.md` which stays as historical record).
- [ ] `tiles/cors.json` — R2 CORS allowed origins. Reviewed; needs no change if it already lists `*` or both old + new.

### Phase 3 — Cloudflare custom domains (Claude) ✅

- [x] Ran `wrangler deploy --env staging` on the `gtfsx-rebrand` branch (2026-05-18). Wrangler bound `staging.gtfsx.com` and `staging-feeds.gtfsx.com` as custom domains on the `gtfs-builder-staging` worker.
- [x] `staging.gtfsx.com` cert provisioned within ~1 min and returns the SPA (HTTP 200, title "GTFS·X – GTFS Builder and Editor").
- [x] Production custom domains bound after deleting pre-existing apex/www A records that were blocking the `custom_domain: true` binding. Gotcha: when a Cloudflare-registered domain has auto-created parking A records, wrangler refuses to take them over with `code 100117`. Fix is to delete the records in CF DNS, then `wrangler triggers deploy --env=""` to re-bind. The CFB-driven push uploaded the new worker script and updated env vars but silently skipped the triggers step — verify trigger bindings post-deploy with `wrangler deployments view` (now `wrangler versions view`).
- [ ] `feeds.gtfsx.com` + `staging-feeds.gtfsx.com` cert provisioning in progress (CF typically 5–60 min on a fresh hostname). Editor + apex/www working; feeds subdomains pending cert.

### Phase 4 — Resend sending domain (user) ✅

- [x] `gtfsx.com` added to Resend and verified (user, 2026-05-18).
- [ ] (Optional) Configure aliases for `noreply@gtfsx.com`, `support@gtfsx.com`, `sales@gtfsx.com`, `mark@gtfsx.com` — Resend doesn't require an actual inbox to send.
- [ ] Keep the existing `gtfsstudio.net` Resend domain verified for the transition period. No emails are sent from `@gtfsstudio.net` after deploy (AUTH_EMAIL_FROM has flipped), but keeping it verified avoids ambiguity if we need to roll back.

### Phase 5 — Stripe (user) ⏳

- [ ] Run `uv run scripts/setup-stripe.ts` (staging) — registers staging webhook at `https://staging.gtfsx.com/api/billing/webhooks/stripe`.
- [ ] Run `uv run scripts/setup-stripe.ts --live` (prod) — registers prod webhook at `https://www.gtfsx.com/api/billing/webhooks/stripe` and updates portal return URL.
- [ ] Store new staging signing secret as `STRIPE_WEBHOOK_SIGNING_SECRET` worker secret on the staging env.
- [ ] Store new prod signing secret as `STRIPE_WEBHOOK_SIGNING_SECRET` worker secret on the prod env.
- [ ] Leave the old `gtfsstudio.net` Stripe webhook active during the transition; Stripe will keep retrying both endpoints. Delete in Phase 12.
- [ ] (Optional) Update **Branding** in Stripe Dashboard to reference `gtfsx.com`.

### Phase 6 — Cloudflare Turnstile (user) ✅

- [x] `gtfsx.com`, `www.gtfsx.com`, `staging.gtfsx.com` added to the Turnstile site hostname list (user, 2026-05-18). Same site key works across all hostnames.

### Phase 7 — Mapbox (user) ✅

- [x] New `pk.` token (`pk.eyJ1IjoibWFya2VnZ2UiLCJhIjoiY21wYjlrdnhlMDRuZjJzb21mMXQwZTJlaSJ9...`) created with default public scopes and URL allowlist `https://gtfsx.com/*` + `https://*.gtfsx.com/*` (user, 2026-05-18). Token wired into `.env`, `wrangler.jsonc` prod + staging, and verified working on staging.gtfsx.com (Mapbox basemap renders).
- [ ] Update `VITE_MAPBOX_TOKEN` in CF Workers Builds → Settings → Variables (build-env value used when CF rebuilds the SPA) — same `pk.` value as `.env`.

### Phase 8 — Staging verification (Claude + user) ✅ (partial)

- [x] `https://staging.gtfsx.com` returns the SPA with new brand (GTFS·X lockup, coral wordmark, "GTFS Builder and Editor" tagline). Mapbox basemap renders on the new token. Verified in Chrome 2026-05-18.
- [x] Legacy 301 redirects verified — single-hop, path + query preserved:
      ```
      $ curl -sI https://staging.gtfsstudio.net/some/path?x=1   → 301 → https://staging.gtfsx.com/some/path?x=1
      $ curl -sI https://staging.gtfsstudio.com/foo             → 301 → https://staging.gtfsx.com/foo
      $ curl -sI https://staging-feeds.gtfsstudio.net/...zip    → 301 → https://staging-feeds.gtfsx.com/...zip
      $ curl -sI https://staging-feeds.gtfsbuilder.net/...zip   → 301 → https://staging-feeds.gtfsx.com/...zip  (single-hop collapse works)
      ```
- [ ] `staging-feeds.gtfsx.com` cert provisioning pending — embed iframe verification on the embed-demo page is blocked until cert lands.
- [ ] Sign-up / Turnstile / verify-email flow on staging (deferred — Stripe webhook not yet pointed at staging.gtfsx.com).
- [ ] Stripe test-mode checkout on staging (deferred until Phase 5 done).

### Phase 9 — Production cutover (Claude) ✅

- [x] Merged `gtfsx-rebrand` → `main` via fast-forward (commit `8faa6fc`, 2026-05-18) and pushed.
- [x] CF Workers Builds auto-deployed `gtfs-builder` (prod) per WORKFLOW.md — push to `main` triggers the build, no tag needed. Initial build at 13:59 UTC uploaded the new worker script + env vars but the trigger bindings step silently no-op'd because of the pre-existing DNS records (see Phase 3 gotcha).
- [x] After clearing DNS records, `wrangler triggers deploy --env=""` bound all 11 prod routes (3 × gtfsx.com canonical + 8 × legacy redirect targets).
- [x] CFB's first build also used the stale `VITE_MAPBOX_TOKEN` from the CFB Variables dashboard — the deployed SPA had the previous prod token baked in and Mapbox 401'd on gtfsx.com. Fixed with a local `npm run build && wrangler deploy --env=""` that picked up the new token from `.env`. **CFB Variables dashboard still has the stale value — update it (see outstanding work below) or the next push to main will regress.**
- [x] `https://www.gtfsx.com` serves the SPA with the new brand. Verified in Chrome: GTFS·X coral lockup in header, Mapbox basemap renders, no console errors.

### Phase 10 — 301 redirect old → new (Claude) ✅ (bundled with Phase 2)

Same atomic pattern as the prior migration — the redirect block is part of `worker/index.ts` and ships in the same commit as the new routes.

- [x] Worker now redirects `gtfsstudio.net`, `gtfsstudio.com`, and `gtfsbuilder.net` (and every subdomain of each) → matching `gtfsx.com` host.
- [x] Verified on prod post-deploy (2026-05-18):
      ```
      $ curl -sI 'https://www.gtfsstudio.net/foo?x=1'              → 301 → https://www.gtfsx.com/foo?x=1
      $ curl -sI 'https://feeds.gtfsstudio.net/bozeman-demo/gtfs.zip' → 301 → https://feeds.gtfsx.com/bozeman-demo/gtfs.zip
      $ curl -sI 'https://www.gtfsstudio.com/?ref=test'           → 301 → https://www.gtfsx.com/?ref=test
      $ curl -sI 'https://feeds.gtfsbuilder.net/bozeman-demo/gtfs.zip' → 301 → https://feeds.gtfsx.com/bozeman-demo/gtfs.zip  (single-hop collapse: oldest legacy → newest canonical)
      ```
- [x] Verified on staging (same chains, all single-hop).

### Phase 11 — Catalog notifications (user, async) — likely N/A

- [ ] No feeds were ever submitted to Mobility Database or transit.land under any prior brand (`gtfsbuilder.net` / `gtfsstudio.net`) — both integrations remain stubbed. Same applies here; no action needed unless a feed has been submitted in the interim.
- [ ] Update any external links you control: social profiles, README badges, agency partner sites.

### Phase 12 — Cleanup (Claude + user, deferred — months later) ⏳

When confident no traffic is hitting the old domains:

- [ ] Remove `gtfsstudio.net`/`gtfsstudio.com`/`gtfsbuilder.net` custom domain bindings from Cloudflare.
- [ ] Remove the redirect block from `worker/index.ts`.
- [ ] Remove old hostnames from Turnstile + Mapbox allowlists.
- [ ] Remove old Stripe webhook endpoints.
- [ ] Eventually: don't renew the old domains. (Or keep `gtfsstudio.com` / `gtfsbuilder.net` indefinitely for brand protection — cheap.)

---

## Rollback plan

If something goes wrong between Phase 9 and the redirect verification:

1. Revert the `gtfsx-rebrand` merge on `main`; tag a new `prod-…` to re-deploy the prior config. The old domains are still serving traffic.
2. The new `gtfsx.com` bindings can be left in place harmlessly.

If something goes wrong after the redirect is live:

1. Comment out the redirect block in `worker/index.ts` and re-deploy. Old domain serves the SPA directly again.
2. No data is at risk — D1 + R2 are domain-agnostic.

---

## Reference: hostname → service mapping after cutover

| Hostname | Bound to | Behavior |
|---|---|---|
| `gtfsx.com` / `www.gtfsx.com` | `gtfs-builder` Worker | SPA |
| `feeds.gtfsx.com` | `gtfs-builder` Worker | Public feeds + embeds |
| `staging.gtfsx.com` | `gtfs-builder-staging` Worker | SPA |
| `staging-feeds.gtfsx.com` | `gtfs-builder-staging` Worker | Public feeds + embeds |
| `gtfsstudio.net` (+ subdomains) | `gtfs-builder` / staging Worker | 301 → corresponding `gtfsx.com` host |
| `gtfsstudio.com` (+ subdomains) | `gtfs-builder` / staging Worker | 301 → corresponding `gtfsx.com` host |
| `gtfsbuilder.net` (+ subdomains) | `gtfs-builder` / staging Worker | 301 → corresponding `gtfsx.com` host |
