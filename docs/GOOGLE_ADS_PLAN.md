# GTFS·X — Google Ads: Combined Execution Plan

**Status:** Active. Supersedes `MARKETING_AD_PLAN.md` and `bundle-05-google-ads-campaign.md`.
**Last revised:** 2026-05-26.
**Replaces:** `docs/MARKETING_AD_PLAN.md` (planning sketch) and `Outreach Drafts/bundle-05-google-ads-campaign.md` (paste-and-launch config). Those two contradict each other in three places; this doc resolves the contradictions.

---

## 0. TL;DR

Launch in two phases:

**Phase 1 (next 2-3 weeks):** Small pilot at $5/day ($150/mo cap), 1 campaign / 2 ad groups, no Google-side conversion tracking. Honors the no-cookies analytics architecture by capturing `gclid` as a URL param and reconciling against backend conversion events. Goal: test ad copy, landing pages, and keyword intent at low cost. ~25 min of Ads UI setup, ~half a day of engineering work, a few decisions from Mark.

**Phase 2 (week 5 onward, gated on Phase 1 hitting 10+ conversions in week 4):** Expand to 4 campaigns, ship dedicated landing pages, ramp budget to $500-1,500/mo. *Offline Conversion Import is already shipped (bundle 7, 2026-05-26) — Smart Bidding has signal as soon as Mark completes the one-time OAuth setup in `worker/marketing/ads/README.md`.*

---

## 1. Reconciliations between the two source plans

| # | Where they disagree | Resolution | Why |
|---|---|---|---|
| 1 | **Conversion tracking.** MARKETING_AD_PLAN calls for gtag.js conversion pixel + GA4. Bundle 5 says that's blocked by the locked analytics architecture. | **Bundle 5 wins.** Use `gclid` URL-param capture + backend reconciliation. Offline Conversion Import shipped in bundle 7 (2026-05-26) — server-to-server uploader runs daily, replaces gtag.js entirely. | The no-cookies / no-3rd-party-JS analytics decision is locked (see memory `gtfsx-analytics-stack`). gtag.js sets cookies and is third-party JS. The bundle-5/bundle-7 path preserves the architecture and gives Smart Bidding a real conversion signal once enough data accumulates (~30 conversions/30 days). |
| 2 | **Campaign structure.** MARKETING_AD_PLAN wants 4 campaigns (Brand defense, Publishing, Planning tools, Verticals). Bundle 5 specifies 1 campaign / 2 ad groups (Editor + Flex). | **Phase 1 = bundle 5's structure. Phase 2 = MARKETING_AD_PLAN's 4-campaign structure.** | Four campaigns at $150/mo means $37.50/mo per campaign — well below Google's signal threshold. Start narrow, expand once volume justifies it. |
| 3 | **Budget.** MARKETING_AD_PLAN suggests $30-50/day. Bundle 5 specifies $5/day. | **Phase 1 = $5/day. Phase 2 = ramp to $15-50/day based on Phase 1 results.** | $5/day is what was budgeted in the 90-day marketing plan. $30/day before conversion tracking is in place is a guess; $5/day with manual reconciliation is a controlled experiment. |
| 4 | **Landing pages.** MARKETING_AD_PLAN says dedicated `/lp/<campaign-slug>/` pages are a Tier 1 block-launch item. Bundle 5 uses existing pages (`/` and `/learn/gtfs-flex/`). | **Phase 1 = existing pages (verified to exist). Phase 2 = dedicated `/lp/*` and `/for/*` pages.** | Engineering cost for new LPs ≈ 2-3 days. Not worth blocking a $150/mo pilot on. Phase 2 ramp is when LP-quality starts mattering for CPA. |

Search Console structured-data fix is **already shipped** (verified: `worker/marketing/ssr.ts` emits `SoftwareApplication` JSON-LD with test coverage). No action needed there beyond watching for re-validation to clear.

---

## 2. Phase 1 — Pilot launch ($150/mo, ~3-week test window)

### 2.1 What Mark needs to do (decisions + approvals, ~30 min total)

1. **Confirm the Google Ads billing identity.** Pre-launch checklist needs this nailed down: `mark@eateggs.com` or `mark@gtfsx.com`, which payment method. I cannot guess this — tell me which account I should be operating in.
2. **Approve the campaign before I hit Publish.** I'll set everything up in Draft state and walk you through it via screen share / screenshots. Final "Publish" click is yours.
3. **Decide on the medium-term budget ceiling.** $150/mo for Phase 1 is set. What's the maximum monthly spend you're willing to commit if Phase 1 hits the ramp triggers in week 4? I need this for the Phase 2 plan. Reasonable bands: $500/mo (cautious), $1,500/mo (committed), $5,000/mo (aggressive).

### 2.2 What Claude Code needs to do (engineering — see handoff prompt at §6)

Pre-launch blockers:

1. **Capture `gclid` URL parameter on landing pages and store it in the user's session (server-side, no cookies).** When a visitor lands at `/?gclid=abc123` or `/learn/gtfs-flex/?gclid=abc123`, persist the gclid against their session.
2. **Stamp `gclid` onto conversion events in the backend DB.** The existing cookieless `event` table (see `worker/migrations/0007_events.sql`) already has the right shape — add a nullable `gclid` column and propagate it from the client beacon. The Phase 1 funnel metrics are `feed_exported` (primary), `paywall_view` (intent), and `editor_loaded` (engagement). Note: there is no `account_created` event today and we're deliberately not adding one — the analytics layer keeps session_id disconnected from user_id by design.
3. **Build a SQL view or simple admin page** that lists conversion events with `gclid IS NOT NULL`, grouped by week, so I (or Mark) can reconcile against Google Ads click reports.
4. **Sanity-check landing pages on mobile (≤400px width).** Bundle 5 sends mobile clicks to `gtfsx.com/` and `gtfsx.com/learn/gtfs-flex/`. Both must render without horizontal scroll and have tap-sized CTAs above the fold. Editor itself can stay desktop-first; marketing pages can't.

Nice-to-have-before-launch (not blockers):

5. **Add an above-the-fold "Free GTFS editor — no signup required" callout to `/` if it isn't already prominent.** Ad copy promises this; landing page must deliver in the first 5 seconds.
6. **Pricing page above-the-fold tweak:** move the "Most popular" badge to the Pro card (the network-effects bet from the May 2026 restructure). Add a short FAQ block below the fold.

The handoff prompt in §6 has these in paste-ready form.

### 2.3 What I can do for you (via Chrome MCP, ~25 min when you're ready)

Once Mark gives me the green light and confirms the billing account:

1. **Create the Google Ads campaign** following bundle 5 exactly: campaign name `GTFS·X — Search — US — Pilot`, $5/day, Maximize clicks with $2.50 max CPC, Search only, Display + Search Partners off, Final URL Expansion off, all auto-applied recommendations off.
2. **Set up Ad Group 1 (Editor)** with the 10 keywords (5 exact + 5 phrase), the responsive search ad (15 headlines + 4 descriptions, with headlines 1 and 2 pinned per bundle 5).
3. **Set up Ad Group 2 (Flex)** with the 8 keywords and corresponding RSA (12 headlines + 4 descriptions, with headlines 1 and 2 pinned).
4. **Add the ~28 campaign-level negative keywords.**
5. **Configure ad extensions:** 4 sitelinks, 8 callouts, 2 structured snippet sets (per bundle 5 tables).
6. **Run the pre-launch checklist from bundle 5** (16 items) and screenshot the campaign state for you to approve.
7. **PageSpeed Insights check** on `gtfsx.com/` and `gtfsx.com/learn/gtfs-flex/` to confirm Core Web Vitals are healthy before launch.
8. **Search Console re-validation status check** — confirm the structured-data fix has cleared (typically 3-7 days; it shipped a few days ago).

After launch:

9. **Daily 5-min health checks for week 1** (impressions, clicks, CTR, avg position, spend pacing). I report only when something needs attention.
10. **Weekly reconciliation** — pull search-terms report, pause keywords with <0.5% CTR at 50+ impressions, add negatives for irrelevant search terms, reconcile gclid-stamped backend conversions against Google Ads clicks.
11. **Week 4 retrospective.** Reconciled conversion count vs. ramp triggers, recommendation on Phase 2.

### 2.4 Phase 1 ramp triggers (decision point at week 4)

- **≥10 `feed_exported` events with non-null gclid in week 4** → ramp. Proceed to Phase 2.
- **2-9 such events** → hold at $150/mo, iterate on ad copy and landing-page hooks for another 4 weeks.
- **<2 events** → pause. Diagnose: are clicks happening but bouncing (landing-page problem) or no clicks at all (keyword / ad-copy problem)? Different fixes.

---

## 3. Phase 2 — Scale ($500-1,500/mo, only if Phase 1 hits ramp triggers)

### 3.1 What Mark needs to do (decisions, ~1 hour total)

These are the open questions from `MARKETING_AD_PLAN.md` §7. They were premature at Phase 1; they become real at Phase 2:

1. **Vertical priority.** Of microtransit / university shuttles / paratransit / consultants, which one ships first? Drives which `/for/<vertical>/` page Claude Code builds first.
2. **Case study consent.** Comfortable approaching Streamline (Bozeman) for a written-up case study? Cold ad traffic at higher spend needs social proof.
3. **Demo CTA.** Add a "Book a 15-min demo" path for Agency-tier ad traffic, or stay self-serve only?
4. **Conversion target CPA.** What's the realistic Pro sign-up CPA you're willing to pay? My recommended starting range based on the marketing plan: $60-80 for Pro (first-year LTV of $588 covers it), $200-400 for Agency ($2,499/yr LTV). Confirm or revise.

### 3.2 What Claude Code needs to do (engineering, ~1-2 weeks of work)

1. **Offline Conversion Import integration. ✅ Shipped 2026-05-26 (bundle 7).** Backend daily job at 09:00 UTC uploads `feed_exported` and `paywall_view` events (with their stored `gclid` values) to Google Ads via `uploadClickConversions`. No cookies, no client-side pixel. Idempotent via `event.oci_uploaded_at`; 90-day gclid cutoff; per-row partial-failure handling with a 3-attempt retry cap. Code lives in `worker/marketing/ads/oci.ts`; admin status at `/admin/events/oci-status`. **Action required before it actually runs:** Mark completes the one-time OAuth setup in `worker/marketing/ads/README.md` and sets the seven `GOOGLE_ADS_*` Worker secrets. Until then the cron logs `[oci] skipped — env not configured` and exits cleanly. The **bid-strategy switch** (Maximize Clicks → Maximize Conversions) is *not* part of this work — Mark makes that call in the Google Ads UI once ≥30 conversions accumulate in a 30-day window. If LTV-weighted bidding becomes worth the architectural cost, a separate decision is needed about linking session_id → user_id (currently disconnected by design — see §4).
2. **Dedicated landing pages:**
   - `/lp/publish-gtfs/` — Pro-tier intent, hosting + canonical URL story
   - `/lp/transit-planning-tools/` — Agency-tier intent, Remix-alternative framing
   - `/lp/gtfs-editor-for-agencies/` — generic agency-buyer intent
3. **Vertical landing pages** (build in priority order from Mark's §3.1 decision):
   - `/for/microtransit/` — GTFS-Flex authoring story
   - `/for/university-shuttles/` — small-ops, annual schedule changes
   - `/for/paratransit/` — rural / RTAP angle
   - `/for/consultants/` — Agency tier, cross-org membership
4. **`/publish/mobility-database/`** — workflow page explaining canonical hosting + Mobility Database submission. Single most direct Pro-tier differentiator from "just export a ZIP."
5. **`/compare/cost/`** — ROI table (and optional calculator) comparing Agency at $3.6k/yr to Remix ($20k+), Optibus ($25k+), Trillium ($5-10k+). Honest about what each does that the others don't.
6. **Case study page** for Streamline (gated on Mark getting consent).
7. **Mobile UX pass** on `/compare/*` pages (Phase 1 only covered `/` and `/learn/gtfs-flex/`).

### 3.3 What I can do for you (via Chrome, ~1 hour per campaign expansion)

1. **Expand to the 4-campaign structure** from MARKETING_AD_PLAN §4:
   - Brand Defense (exact: "gtfs·x", "gtfsx", "gtfs builder", any rebranding aliases)
   - GTFS Publishing (intent, points at `/lp/publish-gtfs/`)
   - Planning Tools / Competitive (Remix alternative, points at `/lp/transit-planning-tools/`)
   - Verticals (per-vertical ad groups, each pointing at its `/for/<vertical>/` page)
2. **Switch bidding to Target CPA** once each campaign has ~30 conversions accumulated (Google's Smart Bidding minimum).
3. **G2 / Capterra listing setup** if Mark wants — seeds `aggregateRating` for the SoftwareApplication JSON-LD. Worth doing once there are a few real customers willing to leave reviews.
4. **Ongoing weekly cadence:** search-term cleanup, negative-keyword expansion, ad-copy A/B variants, landing-page recommendation based on Search Terms + which `/for/<vertical>/` pages convert.

### 3.4 Tier 3 — Nice to have, not blocking Phase 2

- Blog / "GTFS guides" section for organic + retargeting
- Live demo CTA — Mark decision in §3.1
- Microsoft Clarity or PostHog session recording — **note: same architecture constraint applies.** These set cookies and are third-party JS. If you want session recording, it has to be self-hosted (PostHog supports this) and configured to not set cookies, or skipped.

---

## 4. The locked architecture constraint, restated

This is worth pinning at the top of any future Ads discussion: **GTFS·X uses Cloudflare zone-level analytics + backend DB event logging. No cookies, no third-party JavaScript analytics.** This is a deliberate decision (memory: `gtfsx-analytics-stack`).

What it rules out:
- Google Ads conversion pixel (gtag.js)
- GA4 (Enhanced Measurement, conversion events)
- Microsoft Clarity, Hotjar, FullStory (session recording with cookies)
- Facebook Pixel, LinkedIn Insight Tag (paid social retargeting)
- Standard Smart Bidding signal source

What still works:
- `gclid` URL-param capture (Google adds this automatically with auto-tagging on)
- Backend event logging stamped with `gclid`
- Google Ads Offline Conversion Import API (server-to-server, no cookies)
- Cloudflare zone analytics for traffic
- Self-hosted, cookieless PostHog if session recording becomes worth the engineering cost

If at some point the business case for paid social becomes strong enough, the cookieless constraint has to be revisited as a deliberate decision — not silently violated by adding a pixel.

---

## 5. Timeline at a glance

| Week | Phase 1 | Owner |
|---|---|---|
| This week | Mark confirms billing account + approves Phase 1 plan | Mark |
| This week | Claude Code: gclid capture + conversion stamping + admin view | Claude Code |
| This week | Claude Code: mobile sanity check on `/` and `/learn/gtfs-flex/` | Claude Code |
| Next week | I set up Google Ads campaign in Draft state | Me (Chrome) |
| Next week | Mark reviews screenshots, approves Publish | Mark |
| Weeks 1-4 of campaign | I monitor + report weekly | Me (Chrome) |
| Week 4 | Ramp / hold / pause decision | Mark + me |
| **Week 5+** | **Phase 2 (if ramp triggered)** | |
| Week 5 | Mark answers §3.1 questions | Mark |
| Weeks 5-6 | Claude Code: offline conversion import + first dedicated LP | Claude Code |
| Weeks 7-8 | I expand to 4-campaign structure | Me (Chrome) |
| Weeks 7-10 | Claude Code: vertical LPs + mobility DB page + ROI page | Claude Code |
| Week 10+ | Switch to Target CPA bidding, iterate | Me (Chrome) |

---

## 6. Claude Code handoff prompt (Phase 1 engineering)

The full handoff is at `/Users/clippy2/proj/gtfsx/handoffs/bundle-06-gclid-capture.md` (written 2026-05-26). The short version below is a paste-ready prompt; the file has the full spec including the migration SQL, the existing `?ref=` pattern this mirrors, and the test plan.

```
Bundle 6 — Google Ads gclid capture + conversion stamping

Context: GTFS·X is launching a $150/mo Google Ads pilot. Per the locked
analytics architecture (no cookies, no 3rd-party JS), the standard Google
Ads conversion pixel is off the table. Instead, we capture the `gclid`
URL parameter that Google appends to ad clicks (when auto-tagging is on),
persist it server-side, and stamp it onto backend conversion events for
weekly manual reconciliation against Google Ads click reports. Later
(Phase 2), a nightly job will push these reconciled conversions back to
Google via the Offline Conversion Import API.

Scope of this bundle:

1. Landing-page gclid capture
   - On any page request where `?gclid=<value>` is present, persist the
     value against the user's session (server-side; we already have a
     session mechanism — do not introduce a new cookie).
   - The two pages that Phase 1 ads point at are `/` and
     `/learn/gtfs-flex/`, but make this generic — every marketing page
     should capture gclid if present.
   - If the user already has a stored gclid, prefer first-touch (don't
     overwrite). Add a comment explaining the choice.

2. Conversion event stamping
   - Funnel events live in the single `event` table (see migrations 0007
     and 0013). The relevant kinds are `feed_exported`, `paywall_view`,
     `editor_loaded`. There is intentionally no `account_created` event
     and we're not adding one (session-anonymous by design).
   - Add a nullable `gclid TEXT` column to the `event` table. Partial
     index on (ts) WHERE gclid IS NOT NULL. Migration is reversible.
   - At write time, populate `gclid` from the client-forwarded value
     (mirrors how the existing `ref` field works).

3. Reconciliation view
   - Add an authenticated admin route — `/admin/ads-attribution` is fine
     — that lists conversion events with `gclid IS NOT NULL`, grouped
     by ISO week, with columns: event_type, count, sample_gclid_values
     (LIMIT 5). Plain HTML table is fine; no fancy charting.

4. Mobile sanity check on Phase 1 landing pages
   - Audit `/` and `/learn/gtfs-flex/` at viewport widths of 320, 375,
     and 414 pixels. Required: no horizontal scroll, tap targets ≥44px,
     primary CTA visible above the fold without scrolling. Editor
     pages and `/docs/*` are out of scope for this bundle.
   - Document what you found and what you fixed in the PR description.

Non-goals (out of scope for this bundle; Phase 2 work):
- Offline Conversion Import API integration
- New dedicated `/lp/*` landing pages
- New `/for/*` vertical pages
- GA4 or any client-side analytics integration

Acceptance criteria:
- A test that visits `/?gclid=test_123`, creates an account, exports a
  feed, and verifies the conversion event row has `gclid = 'test_123'`.
- A test that verifies the same gclid persists across navigation to
  `/learn/gtfs-flex/` and then back to `/` (first-touch wins).
- Admin page renders correctly with at least one fixture conversion.
- Mobile audit notes in PR description with before/after screenshots.

Reference: /Users/clippy2/proj/gtfsx/docs/GOOGLE_ADS_PLAN.md §2.2
```

---

## 7. What changed from the source docs

For posterity / future-me debugging this plan:

- **`MARKETING_AD_PLAN.md` Tier 1 item 1 (GA4 + gtag.js):** Removed entirely. Replaced with gclid-based attribution. Architecture violation otherwise.
- **`MARKETING_AD_PLAN.md` §5 (GA4 property + manual conversion events via gtag):** Removed. Same reason. Backend event logging already exists; we just need to stamp gclid onto it.
- **`MARKETING_AD_PLAN.md` Tier 1 item 2 (dedicated `/lp/*` landing pages as block-launch items):** Demoted to Phase 2. Bundle 5 ships against existing pages.
- **`MARKETING_AD_PLAN.md` Tier 1 item 3 (pricing page rewrite as block-launch):** Demoted to nice-to-have within Phase 1. The badge swap + FAQ block is worth doing, but it isn't blocking a $150/mo pilot.
- **`MARKETING_AD_PLAN.md` §4 campaign structure (4 campaigns):** Moved to Phase 2.
- **`MARKETING_AD_PLAN.md` §4 budget shape ($30-50/day):** Moved to Phase 2.
- **`MARKETING_AD_PLAN.md` §6 launch sequence:** Replaced by §5 of this doc.
- **Bundle 5:** Kept intact for Phase 1. Treat it as the operational reference for what to paste into Google Ads.
