# Docs Expansion — Claude Code Handoff

*Author: Mark Egge (via planning session 2026-05-18)*
*Target: Claude Code session run from the gtfsx.com repo*
*Status: ready for implementation*

---

## Goal

Split the current single-page `/docs` into per-panel standalone pages, fill the documentation gaps for currently-undocumented panels and features, and put a real screenshot in every page. Three objectives, in priority order:

1. **Genuinely useful user help docs.** The first job is to actually help a working transit planner do their job in GTFS·X. If a user is stuck on calendar exceptions or trying to figure out why a Flex zone won't export, they need to find the answer and move on. Every page is written for that user first; the test is "would this unblock me if I were stuck?" If a page reads like SEO bait or marketing copy and not like an answer to a real question, rewrite it.
2. **SEO surface.** Each editor feature ranks for its own intent. The combined `/docs` page targets none of the long-tail queries well. Doing (1) properly usually produces (2) as a byproduct — practitioner-direct answers to specific questions are exactly what search engines reward.
3. **Upgrade rationale.** The paid features (cost estimation, demographic coverage, Title VI, rider propensity, hosted publishing) need standalone pages that make the value obvious before a user is asked to pay. Currently several have zero documentation outside of bullet points on `/pricing`. Documentation written to (1) does this naturally; documentation written *for* upselling does not.

The order matters. If a page choice tradeoffs SEO or upgrade-prompt clarity against actually helping a stuck user, help the stuck user.

The existing `/docs` page is a fine *overview* and stays — it gets restructured into a hub index. The existing `/docs/quick-start/`, `/docs/deep-links/`, `/learn/gtfs/`, and `/learn/gtfs-flex/` pages are also fine and stay; they're referenced from this work but not modified.

---

## Current state inventory (as of 2026-05-18)

**Live and good:**

- `/about` — solid about page
- `/pricing` — current pricing (Pro $49/mo, Team $199/mo, Free, Enterprise custom)
- `/docs` — single long page, 10 numbered sections covering agency setup through coverage & demographic analysis
- `/docs/quick-start` — 7-step quick start guide
- `/docs/deep-links` — deep-link integration spec (Idea 4, fully shipped)
- `/learn/gtfs` — "What is GTFS?" primer
- `/learn/gtfs-flex` — "What is GTFS-Flex?" primer
- `/help` — help index
- `/community` — community forum

**Editor sidebar panels (from the running editor at `/`):**

- Agency
- Fares
- Calendars
- Routes
- Stops
- Transfers
- Flex Zones
- Costs
- Coverage
- Title VI

Plus editor footer: Timetable, Service Summary, Validation. Plus top bar: Save, Import, Export GTFS.

**Documentation gaps (this handoff addresses these):**

1. No per-panel pages — every sidebar item shares one URL.
2. `Title VI` panel is in the editor but absent from `/docs` (lumped into section 10 "Coverage & demographic analysis").
3. `Rider Propensity` is a Team-tier feature on `/pricing` but absent from `/docs` and from the editor sidebar I can see (may live under a different name — confirm).
4. `Transfers` panel is in the editor but absent from `/docs`.
5. `Service Summary` is in the editor footer but absent from `/docs`.
6. `Costs` panel has minimal coverage in `/docs/quick-start` ("Set a cost per revenue hour and deadhead factor…") and zero standalone documentation.
7. `Hosted publishing` (managed publishing service) is mentioned only on `/pricing` — the biggest doc gap, and the answer to the most-asked agency question.
8. `Rider mini-site` and `embed widgets` are mentioned only on `/pricing`.
9. `Account / cloud sync` — anonymous-vs-signed-in behavior is mentioned in `/about` but has no docs page.
10. `Keyboard shortcuts` are in `/docs/quick-start` but deserve their own permanent page.

---

## Target information architecture

A single hub at `/docs` linking to 20 sub-pages organized into five clusters. Slugs are recommended; adjust if the framework has different routing conventions.

```
/docs                                  Hub: editor overview + organized links to all sub-pages

Foundations
/docs/quick-start                      [existing — leave alone]
/docs/keyboard-shortcuts               [new — extract from quick-start]
/docs/account-and-cloud-sync           [new]

Editor panels
/docs/agency-setup                     [split from /docs#1]
/docs/service-calendars                [split from /docs#2]
/docs/routes-and-shapes                [split from /docs#3]
/docs/stops                            [split from /docs#4]
/docs/transfers                        [new]
/docs/timetables-and-trips             [split from /docs#5]
/docs/fares                            [split from /docs#6]
/docs/flex-zones-and-booking-rules     [split from /docs#7]

Validation & I/O
/docs/validation                       [split from /docs#8]
/docs/import-and-export                [split from /docs#9]
/docs/service-summary                  [new]

Analysis tools (paid features — must read as both docs and as upgrade rationale)
/docs/cost-estimation                  [new]
/docs/demographic-coverage             [new — split from /docs#10]
/docs/title-vi-analysis                [new — split from /docs#10]
/docs/rider-propensity                 [new]

Publishing & distribution (paid)
/docs/hosted-publishing                [new — biggest single gap]
/docs/rider-mini-site                  [new]
/docs/embed-widgets                    [new]

Integrations (already done — leave alone)
/docs/deep-links                       [existing]
```

The hub `/docs` becomes a landing page with five clusters, one-line description per page. Drop the long-form sections from `/docs` once the split-out pages exist (don't keep two sources of truth).

---

## Conventions

**Voice.** Match the existing `/about`, `/learn/gtfs`, `/learn/gtfs-flex`, and `/docs/quick-start` pages: practitioner-direct, no marketing fluff, plain English, sentence case headings. Speak to a transit planner or small-agency staff member who knows what GTFS is but hasn't used GTFS·X yet. Acknowledge limitations honestly (e.g., "we don't yet support X — for that, use Y") rather than pretending the gaps don't exist.

**Per-page structure.** Default skeleton, adapt as needed:

```
# {Page Title — also the H1, also targets the primary search query}

{1-2 sentence intro: what this is, why it matters}

## What it is
{1-3 paragraphs of conceptual framing}

## When to use it
{Concrete use cases / agency profiles}

## How to use it in GTFS·X
{Step-by-step with screenshots interleaved}

## {Optional} Edge cases & gotchas
{What surprises new users; tier limits; spec ambiguities}

## {Optional} Methodology / spec references
{For analysis pages: cite the underlying data sources and methods}

## See also
{2-4 cross-links to related docs pages}
```

**Anchor IDs.** Use `kebab-case` slugs that match the section header text. The editor's in-app "?" / "Help" icons will deep-link to specific anchors (e.g., `/docs/title-vi-analysis#race-and-ethnicity-thresholds`). Pick stable IDs — once shipped, don't rename.

**Length target.** 400–1,200 words per page. Quick-reference pages (keyboard shortcuts) shorter; deep methodology pages (Title VI) longer.

**Internal linking.** Every page links to (a) the `/docs` hub in the breadcrumb, (b) the editor itself at `/demo` (the demo feed loads pre-populated, so users can follow along), and (c) at least one related docs page in a "See also" footer. The editor does not currently support panel-specific deep links, so links into the editor go to `/demo` and the page text tells the user which panel to open.

**External links.** Cite `gtfs.org` for spec references, `mobilitydata.org` for the canonical GTFS validator, `transitwiki.org` for community context. Don't link competitor products from inside docs (those belong on the marketing-side `/compare/*` pages, not docs).

**No marketing CTAs inside docs.** Docs pages don't ask the user to "upgrade" or "sign up" — they document the feature. Tier limits get mentioned matter-of-factly ("Title VI analysis is included with the Team plan; see pricing"). The upgrade prompt happens *in the editor*, not in the docs.

**Tier labels.** Use these badges (or equivalent) near the H1 to mark tier-gated features:

- `Free` — no badge (default)
- `Pro` — small badge
- `Team` — small badge
- `Enterprise` — small badge

Pages: Cost estimation = Pro. Demographic coverage = Pro. Title VI = Team. Rider propensity = Team. Hosted publishing = Pro. Rider mini-site / Embed widgets = Pro (per `/pricing` they're bundled with hosted publishing).

---

## Screenshots — specifications and capture process

**Capture environment.**

- Browser: Chrome (latest), no extensions visible.
- Viewport: **1440 × 900** logical pixels. Capture at 2× DPI for retina-sharp output; downscale on render.
- Theme: whatever the default editor theme is (don't toggle to a dark/light variant unless the docs page is specifically about theming).
- Demo feed: **always use the canonical demo at `https://gtfsx.com/demo`**. Opening that URL loads the editor with the demo feed pre-loaded. Every screenshot in the docs uses this feed so visual continuity holds.

**File format and storage.**

- Format: PNG, 24-bit color, lossless. Convert to WebP at render time if the framework supports it.
- Naming: `{page-slug}-{descriptor}.png` — kebab-case. Examples: `routes-and-shapes-drawing-mode.png`, `title-vi-analysis-results-panel.png`.
- Storage: assets directory adjacent to the docs source. **[Mark: confirm the docs framework's convention — likely `public/assets/docs/` or `static/docs/`.]**
- Max width on render: 1200 px. Add `loading="lazy"` to images below the fold.

**What to capture, per page.**

- One **hero screenshot** at the top of each page showing the relevant panel in its default state with the demo feed loaded.
- Inline screenshots for each major step in the "How to use it" section. Aim for one screenshot per 100–200 words of body text.
- For analysis pages (Cost, Coverage, Title VI, Propensity), capture the *result* output as a screenshot — agencies want to see what they get before paying.

**Annotations.**

- For first-time concepts, add red boxes or arrows pointing at the UI element being described. Use **a single accent color** (the GTFS·X coral `#E8734A` works well against the editor's neutral palette) so callouts read consistently.
- For overview shots, no annotation.
- Tool: Skitch, Annotate, CleanShot X, or built into the screenshot pipeline.

**Who captures.**

- Claude Code: if the repo has Playwright or Puppeteer wired up, Claude Code can script captures programmatically. This is the preferred path for consistency. Otherwise:
- Mark: captures manually and commits to the assets directory using the file-naming convention above.

**Placeholder behavior.**

- If a screenshot isn't yet captured, the markdown should still reference it with an `![Alt text](path/to/image.png)` line and an HTML comment noting the capture spec for whoever fills it in: `<!-- CAPTURE: Routes panel, snap-to-road mode, Streamline feed loaded, viewport 1440x900 -->`.
- Don't ship a docs page with broken image links. If the screenshot isn't ready, ship the page with a placeholder graphic, an explicit "screenshot coming soon" caption, and the capture spec in a comment.

---

## Per-page briefs

Each brief is the minimum spec for Claude Code to draft the page. Mark reviews drafts before merge; treat these as starting points, not contracts.

### `/docs` (rewritten as hub)

**Purpose:** organized index of all docs pages. Replaces the existing long-form `/docs` page.

**Structure:** brief intro paragraph + five clusters (Foundations, Editor panels, Validation & I/O, Analysis tools, Publishing & distribution) with each cluster as a heading and pages listed below it with one-line descriptions.

**Don't:** keep any of the long-form content from the current `/docs`. That content moves entirely to the split-out pages. Once shipped, the current `/docs` URL serves the new hub layout.

**Length:** ~250 words intro + the structured link index.

---

### Foundations

#### `/docs/keyboard-shortcuts`

**Primary query:** "GTFS·X keyboard shortcuts," "gtfs editor keyboard shortcuts"

**Cover:** complete shortcut reference table, organized by editor area (global, timetable, map drawing). Extract and expand the table currently at the bottom of `/docs/quick-start`.

**Length:** 300–500 words plus reference table.

#### `/docs/account-and-cloud-sync`

**Primary query:** "GTFS·X account," "GTFS·X save feed"

**Cover:** the anonymous-vs-signed-in model (this is a *load-bearing* differentiator — see Marketing Plan). Specifically:
- Anonymous editing puts everything in browser local storage. No account needed to edit, validate, or export a GTFS ZIP.
- When an anonymous user is signed into an account and clicks **Save**, the local-storage work transfers to the cloud at that moment. Document this explicitly — it's the single answer to "where did my work go?" and "what does Save actually do?"
- Once a feed is in the cloud, it syncs across devices on the same account.
- Per-tier feed limits (Free = 3 saved feeds, Pro = 10, Team = unlimited per `/pricing`).
- What an anonymous user loses by *not* signing in: cross-device sync, cross-browser sync, work persistence if they clear browser data.
- Account deletion / data export (confirm what's offered from the codebase).

**Length:** 500–800 words.

**Why this matters:** anonymous editing is the moat vs. Spare. This page makes the model explicit so users (and procurement reviewers at agencies) can understand it without testing. It's also the place that answers the most-common "I lost my work" support question — make sure the local-storage-on-clear-data warning is visible enough that it doesn't get missed.

---

### Editor panels (splits from current `/docs`)

For each of these, lift the corresponding section from the current `/docs` page as the starting point, then expand. Aim for 600–1,000 words each. One hero screenshot of the panel + 2–4 inline screenshots showing key workflows.

#### `/docs/agency-setup`
Lift from `/docs#1`. Cover `agency.txt` fields, multi-agency feeds (joint operators), timezone gotchas (one timezone per agency, not per feed), required vs. optional fields per spec.

#### `/docs/service-calendars`
Lift from `/docs#2`. Cover `calendar.txt` and `calendar_dates.txt`, the day-of-week toggles, holiday handling, the US federal holiday bulk-add tool, edge cases (a calendar_dates-only service with no weekly pattern, useful for one-off events).

#### `/docs/routes-and-shapes`
Lift from `/docs#3`. Cover the route-before-stops design rationale, snap-to-road vs. freehand, the Mapbox Map Matching API behavior, multiple shape variants per route (typical: one per direction), shape simplification, route type selection (bus / rail / ferry / etc.) and the GTFS extended route types.

#### `/docs/stops`
Lift from `/docs#4`. Cover the snap-to-route default with curbside offset, freehand stop placement (park & ride, transfer centers), duplicate detection, stop reordering, wheelchair boarding, parent station relationships.

#### `/docs/transfers` *(new — currently no docs)*
**Primary query:** "GTFS transfers.txt editor," "transit timed transfer GTFS"

**Cover:** `transfers.txt` semantics (recommended / timed / not possible / minimum time), how to define a transfer pair in the editor, common modeling situations (cross-platform rail transfer, bus-to-bus at a hub, mode-change transfer), interaction with trip planners (Google Maps uses transfers.txt for routing decisions).

**Length:** 500–800 words.

#### `/docs/timetables-and-trips`
Lift from `/docs#5`. Cover the timetable grid (rows = trips, columns = stops), auto-interpolation from route geometry, "Duplicate trip with offset" for repeating service, the frequency editor for headway-based service (`frequencies.txt`), service pattern assignment, direction toggle. Probably the most-screenshotted page — agencies struggle most with timetables.

#### `/docs/fares`
Lift from `/docs#6`. Cover the flat-fare default, zone-based fares (defining fare zones on the map, assigning stops, the zone-to-zone fare matrix), `fare_attributes.txt` records (regular / reduced / senior / student), the persistent reminder if no fare data is defined.

**Research task:** check the codebase to determine whether GTFS-Fares-v2 (`fare_products.txt`, `fare_leg_rules.txt`, `fare_transfer_rules.txt`) is supported. If yes, document the v2 workflow alongside the v1; if no, note that v1 is supported today and v2 is on the roadmap (or not — confirm). The spec is bifurcated here and users land on this page asking both questions.

#### `/docs/flex-zones-and-booking-rules`
Lift from `/docs#7`. Cover everything from the current `/learn/gtfs-flex` *plus* the editor-specific workflow: drawing polygon zones, configuring pickup/drop-off windows, the booking rule structure, the three zone-creation methods (draw on map, stop group, auto-generate from fixed routes), continuous pickup/drop-off for corridor service, the per-zone fare assignment, travel-time estimation parameters, export behavior (which files get generated). The deepest page in this set — easily 1,200–1,500 words. Link out to `/learn/gtfs-flex` for the conceptual primer.

---

### Validation & I/O

#### `/docs/validation`
Lift from `/docs#8`. Cover the continuous validation model (errors and warnings appear inline as you edit), the errors-block-export rule, the warnings-allow-export-but-flagged rule, jumping from a validation message to the affected entity, the summary panel. Show a screenshot with at least one example error and one example warning. Mention the underlying validator (canonical MobilityData GTFS Validator) and what version is bundled.

#### `/docs/import-and-export`
Lift from `/docs#9`. Cover the export behavior (standards-compliant ZIP, optional files only if data exists), import behavior (required files parsed, non-standard files preserved on round-trip, import summary with flags), the 100 MB import size limit (matches the deep-link endpoint), supported input formats (ZIP only, or also raw text files? — confirm).

#### `/docs/service-summary` *(new)*
**Primary query:** "GTFS service summary," "transit feed statistics"

**Cover:** what the Service Summary panel surfaces — total revenue hours, revenue miles, trip count per route, span of service, frequency profile. When to use it (sanity-checking a feed, prepping NTD reporting figures, comparing a proposed service against the existing). Screenshot of the panel with the demo feed loaded.

**Length:** 400–600 words.

---

### Analysis tools (paid)

These pages must serve double duty: documentation for paying users, and upgrade rationale for free users who hit the paywall. Keep the tone documentary (not sales), but make sure a free user reading the page understands the value clearly.

#### `/docs/cost-estimation` `[Pro]`
**Primary query:** "transit cost estimation tool," "estimate transit operating cost GTFS"

**Cover:** what inputs the tool reads from the GTFS feed (revenue hours, revenue miles, trip counts), what assumptions it makes (default cost per revenue hour, deadhead factor — and how to override them), what outputs it produces (per-route and system-wide daily and annual estimates), a worked example using the demo feed, methodology references (NTD operating expense per VRH/VRM is the standard anchor; cite a specific NTD year).

**Screenshots:** Costs panel, cost configuration dialog, results output.

**Length:** 800–1,200 words.

#### `/docs/demographic-coverage` `[Pro]`
**Primary query:** "transit demographic analysis," "population served by transit GTFS"

**Cover:** what ACS variables are surfaced (population, households, jobs at minimum — confirm full list), the buffer configuration (1/4 mile, 1/2 mile default), what "population served within X miles of stops/routes" means precisely (cumulative count, not unique persons; methodology caveats), worked example using the demo feed. Useful both as a docs page and as a target for searchers looking up federal grant application support.

**Screenshots:** Coverage panel, buffer config, choropleth/result output.

**Length:** 600–900 words.

#### `/docs/title-vi-analysis` `[Team]`
**Primary query:** "Title VI transit analysis," "Title VI methodology rural transit," "transit Title VI compliance"

**This page needs to be written from scratch** — there isn't a complete existing methodology document to lift from. That makes this the most research-heavy page in the pass; budget the time accordingly.

**Cover:**
- The regulatory context: FTA Circular 4702.1B (Title VI Requirements and Guidelines for FTA Recipients), the difference between disparate impact (DI) and disproportionate burden (DB) analyses, when each applies, the 80-percent / four-fifths threshold convention, the policy-setting requirements that trigger formal Title VI analysis.
- What the GTFS·X tool actually computes: population-weighted demographic comparison of areas served vs. not served by the agency's transit network, using ACS data. Document the exact inputs, the buffer methodology, the demographic variables compared, the statistical comparison, the way thresholds are applied.
- What the tool produces: format of the output (tables, maps, narrative — describe what's there), whether the output is FTA-submission-ready as-is or whether it's input to an agency's own Title VI program update.
- Worked example using the `/demo` feed: show the analysis end-to-end with real numbers.
- Methodology references: cite the FTA circular, cite ACS data conventions, cite any academic or industry sources GTFS·X's methodology draws from.

**Claude Code: read whatever Title VI implementation lives in the codebase before drafting**, so the page accurately reflects what the tool does rather than what it should do. If anything in the implementation is unclear or under-specified, flag it for Mark in a comment block at the bottom of the page rather than guessing.

**Caveat to include:** Title VI compliance isn't a tool output — it's an agency policy and program. The GTFS·X analysis is *input* to a Title VI program update, not a substitute for the program. The page should be explicit so a small-agency planner doesn't assume running the tool checks the compliance box.

**Screenshots:** Title VI panel, configuration dialog, results table, exportable report.

**Length:** 1,200–1,800 words (longer than other analysis pages because the regulatory context needs to be done right).

#### `/docs/rider-propensity` `[Team]`
**Primary query:** "transit ridership propensity model," "GTFS demand estimation"

**Important — it's a map layer, not a panel.** Rider propensity is toggled on/off from the basemap control on the map (not from the editor sidebar). The docs page needs to explain *where to find it* up front; many users will look in the sidebar first and not see it.

**Cover:** where to find it (basemap control toggle), what the heatmap shows (relative likelihood, not absolute ridership), the underlying methodology (Claude Code: research what GTFS·X actually uses — likely a demographic-input regression model; if implementation details aren't clear from the code, leave a placeholder for Mark to fill in), how to interpret it overlaid on routes/stops, how to use it for service planning ("compare scenarios, identify underserved demand pockets"), worked example using the `/demo` feed.

**Caveat to include:** propensity models are not forecasts. The page should be explicit — agencies routinely misuse propensity output, and the page should head off that misuse before the user makes a budget decision on top of it.

**Screenshots:** basemap control with propensity toggle highlighted, heatmap overlaid on the demo feed map, before/after comparison if useful.

**Length:** 600–1,000 words.

---

### Publishing & distribution (paid)

#### `/docs/hosted-publishing` `[Pro]`
**Primary query:** "GTFS feed hosting," "publish GTFS feed Google Maps"

**This is the highest-priority new page in the pass.** It answers the most-asked agency question and lands the hosted-publishing CTA from the agency cold email (Marketing Plan Idea 2).

**Cover:**
- What managed publishing is: GTFS·X hosts the feed at a stable URL `feeds.gtfsx.com/<slug>/gtfs.zip`.
- How updates work: when the user saves a published feed, how soon does the URL update? Is there a draft preview workflow (per `/about`, yes — "draft preview links for stakeholder review") — document that workflow end-to-end.
- What's included: the stable URL, the rider-facing mini-site, the embed widgets, draft preview links. Cross-link the mini-site and embed-widgets docs pages.
- What's NOT included: Google Transit Partners registration, Apple Transit submission, NTD P-50 form filing, Mobility Database registration. The agency does these once they have a stable URL; GTFS·X provides the URL but doesn't submit on behalf.
- The URL format and slug rules: how slugs get generated, can the user customize, what happens to the URL if the slug changes (redirect? broken link?).
- (No SLA / uptime claims in v1 of the docs — leave that conversation for sales rather than docs.)

**Screenshots:** Publishing config dialog, published feed URL example, draft preview link example.

**Length:** 1,000–1,500 words.

#### `/docs/rider-mini-site` `[Pro]`
**Primary query:** "transit agency website GTFS," "embeddable transit schedule"

**Research task first.** Claude Code should locate and evaluate the current mini-site that gets published for the demo feed (likely at `feeds.gtfsx.com/<demo-slug>/` or similar — find it from the hosted-publishing flow when published) before writing this page. Document what's actually shipped today.

**Cover:** what the auto-generated rider-facing mini-site contains (route list, schedules, maps — confirm from the live demo), the URL pattern, how branding works (the Pro custom brand color, the Team org logo per `/pricing`), what's customizable and what's not, whether custom domains are supported (confirm from code; if so, document the setup; if not, note it).

**Screenshots:** the live mini-site for the demo feed, branding configuration in the editor, the route detail page, the schedule view.

**Length:** 500–800 words.

#### `/docs/embed-widgets` `[Pro]`
**Primary query:** "embed transit schedule website," "transit widget for website"

**Research task first.** There's an existing demo site that showcases the rider embeds. Claude Code should locate it (likely linked from the published feed mini-site for the demo feed, or referenced in the codebase / `feeds.gtfsx.com` deployment) and evaluate what's actually published today before writing this page. Mark's note: the current demo isn't great and needs improvement. Two outcomes from that evaluation:

1. The docs page reflects what *currently* exists, honestly. If the embeds are limited or rough, the page documents what they do today without overselling.
2. A separate punch list of recommended embed improvements goes at the bottom of the page (in an HTML comment, not user-visible) so Mark has a starting point for the product work that should follow.

**Cover (based on what Claude Code finds):** what widgets are available (route timetable, system map, "next departures at this stop," whatever else is shipped), how to embed (iframe code, JavaScript snippet — copy real working code from the existing demo), customization options (color, size, content scope), browser / CMS compatibility notes, common gotchas (CORS, responsive behavior, mobile rendering).

**Screenshots:** the current embed gallery, real embed code from the demo, widgets rendered in a sample page (use the existing demo site if it's presentable, or stand up a minimal example page in screenshot capture if it isn't).

**Length:** 500–800 words — could be shorter if the current shipped surface is small.

---

## Sequencing and priority

If Claude Code can do everything in one pass, the order below doesn't strictly matter. If the work needs to be staged, this is the priority:

**Tier 1 (week 1 — fix the most urgent gaps):**
1. `/docs/hosted-publishing` — biggest single gap, highest-stakes for the marketing plan's Idea 2 cold-email CTAs.
2. `/docs/title-vi-analysis` — existing methodology memo makes this fast, and it ranks for compliance-driven queries (high-intent, low-competition).
3. `/docs` hub rewrite — required to surface everything else.

**Tier 2 (week 2 — paid-feature documentation):**
4. `/docs/cost-estimation`
5. `/docs/demographic-coverage`
6. `/docs/rider-propensity`
7. `/docs/rider-mini-site`
8. `/docs/embed-widgets`
9. `/docs/account-and-cloud-sync`

**Tier 3 (week 3 — editor panel splits):**
10. `/docs/agency-setup`
11. `/docs/service-calendars`
12. `/docs/routes-and-shapes`
13. `/docs/stops`
14. `/docs/transfers`
15. `/docs/timetables-and-trips`
16. `/docs/fares`
17. `/docs/flex-zones-and-booking-rules`

**Tier 4 (week 4 — validation, I/O, cross-cutting):**
18. `/docs/validation`
19. `/docs/import-and-export`
20. `/docs/service-summary`
21. `/docs/keyboard-shortcuts`

The split-out pages in Tier 3 are partly mechanical (lift from existing `/docs` sections), so they're fast even though there are many of them. The new pages in Tiers 1–2 are where the writing thinking lives.

---

## Acceptance criteria

**Per page:**

- H1 matches the page title and the primary search query
- One hero screenshot (or labeled placeholder with capture spec) at the top
- At least one additional screenshot for each major step in the "How to use it" section
- "See also" footer with ≥2 cross-links to related docs pages
- Tier badge near the H1 if the feature is paid
- All internal links use canonical URLs (`/docs/page-slug`, not `./page-slug` or `https://www.gtfsx.com/docs/page-slug`)
- Meta description set (≤155 characters, includes the primary search query naturally)
- All anchor IDs are stable kebab-case slugs that match the section header text
- No broken image links (placeholder graphic acceptable if the real screenshot isn't ready, with capture spec in HTML comment)

**Global:**

- `/docs` hub rewritten and linking to all new pages
- Current `/docs` long-form content fully migrated to split-out pages (no duplicated source of truth)
- Nav (header / footer / sidebar — wherever the framework puts it) updated so all 20 pages are discoverable
- `sitemap.xml` regenerated to include the new URLs
- In-editor "?" / Help icons in each sidebar panel deep-link to the matching `/docs/{panel-name}` page (this may be a separate engineering ticket — flag it for Mark if so)
- 301 redirects from any `/docs#N` anchors that are referenced externally to the new split URLs (if any external pages link to `/docs#7-gtfs-flex-zones--booking-rules`, redirect to `/docs/flex-zones-and-booking-rules`)

---

## Implementation notes for Claude Code

**[Mark fills these in based on the repo:]**

- Docs framework: _____ (Next.js MDX? Astro? Hugo? Plain HTML?)
- Docs source files live in: _____ (e.g., `content/docs/*.mdx`)
- Screenshot assets live in: _____ (e.g., `public/assets/docs/`)
- Navigation config lives in: _____ (e.g., `config/docs-nav.ts`)
- Build / preview command: _____ (e.g., `npm run dev`)
- Existing screenshot capture tooling: _____ (Playwright? Puppeteer? None?)
- Demo feed slug: _____ (which feed to use for screenshots — Streamline Bozeman? one of the workspace `demo_feeds/`?)

**General Claude Code guidance:**

- Make small, atomic commits per page so review is page-by-page.
- Don't modify the existing `/docs/quick-start`, `/docs/deep-links`, `/learn/*` pages — they're fine as is.
- The `/docs` hub rewrite is the destructive change — make it after all the split-out pages exist, so users browsing during the migration window don't hit empty pages.
- If a per-page brief above conflicts with the existing `/docs` section content (e.g., the existing section already covers something the brief doesn't mention), preserve the existing content and add to it; don't drop information in the split.
- Run a link checker before completing the pass (`linkinator` or similar) to catch any broken internal references.

---

## Resolved before this draft (2026-05-18)

- **Demo feed:** always use `https://gtfsx.com/demo` (loads editor with demo feed pre-populated).
- **Rider propensity:** it's a basemap layer toggle, not a sidebar panel. Page brief updated accordingly.
- **Panel-specific deep-links:** editor doesn't support these. Page briefs link to `/demo` and tell the user which panel to open.
- **SLA / uptime:** no claims in v1 of the docs.
- **Local-storage → cloud transfer:** happens when a signed-in user clicks Save. Documented explicitly in `/docs/account-and-cloud-sync`.
- **Title VI methodology memo:** no complete existing document. `/docs/title-vi-analysis` is written from scratch (most research-heavy page in the pass).

## Open questions for Mark (resolve before / during implementation)

1. Docs framework and file conventions (the placeholder list under "Implementation notes").
2. `fare_products.txt` / GTFS-Fares-v2 support: Claude Code determines from codebase, flags any ambiguity for Mark.
3. Rider mini-site custom domain support: Claude Code determines from codebase.
4. Rider embeds current state: Claude Code locates the existing demo, evaluates it, drafts the docs honestly. Punch list of recommended embed improvements goes in an HTML comment at the bottom of `/docs/embed-widgets` for Mark's follow-up.
5. Account deletion / data export — what's offered today? Claude Code from codebase.

---

## Quality bar

The North Star for this work is **"a stuck user finds the answer and moves on."** Concretely, for any page in the pass, ask: if a transit planner or small-agency staff member lands here from a Google search or from the in-editor Help link, can they get unstuck within five minutes of reading? If the answer for any page is no, that page isn't done.

Three failure modes to avoid:
- **Marketing copy.** If a page reads like a pitch ("Unlock powerful insights with…"), rewrite it. Docs aren't a sales surface.
- **Man-page minimalism.** If a page is just a field reference with no "when to use this" or "what could go wrong," it doesn't unblock anyone. Add the connective tissue.
- **Speculative content.** Don't document features that don't exist. If a feature is roadmapped but not shipped, leave it out or note explicitly that it's not yet available.

The voice that works is the one already in `/about` and `/learn/gtfs` — practitioner-direct, honest about limitations, useful to someone with a job to finish.
