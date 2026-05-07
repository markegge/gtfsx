# GTFS Builder — Embeddable Maps & Schedules (Draft)

## 0. Purpose & Scope

Once an agency has published a feed via GTFS Builder (see `BACKEND_REQUIREMENTS.md` §5), they need a way to **show that schedule on their own website** without re-keying it. Today, small agencies typically link to a PDF schedule and a static route map image; the schedule on the agency website drifts out of sync with the GTFS feed because they're maintained in different places.

This document defines a feature set that lets a published GTFS feed power **embeddable, always-fresh route maps and schedule tables** on the agency's existing website (WordPress, Squarespace, Wix, custom CMS, etc.) — and a hosted "mini-site" of the same content at `feeds.gtfsbuilder.net/<slug>/` for agencies that don't want to embed.

**Status:** Phase 7 in the backend roadmap (post-launch). Phases 1–6 cover account/feed/publish; this builds on top of the canonical published feed.

**Out of scope (this doc):** native mobile apps, fare purchasing, real-time vehicle tracking UI we host ourselves (we coordinate with GTFS-RT but don't render it in v1 — see EM-90).

---

## 1. Why This Matters (research findings)

We surveyed five small-agency websites (Streamline / Bozeman MT, Mountain Line / Missoula MT, Mountain Express / Crested Butte CO, Skagit Transit / WA, Park City Transit / UT) to ground these requirements. Common patterns:

| Pattern | Observed at | Problem it creates |
|---|---|---|
| Schedules ship as PDF only | Streamline, Mountain Line, Mountain Express | Drifts out of sync with GTFS feed; not screen-readable; bad on mobile; impossible to deep-link to "Route 4 Saturday." |
| Route map is a static image (or absent) | Streamline (image of system map), Mountain Line (no map on routes page) | No way to see "where does Route 4 go relative to my address?" without leaving the agency site. |
| Service variants (weekday/weekend/seasonal) live in separate PDFs | All five | Riders open the wrong one. Effective dates buried in filenames. |
| Detours and holiday adjustments live on a separate "Rider Alerts" page | Streamline, Mountain Line | The rider looking at the schedule doesn't see "this Friday is a Sunday schedule" without navigating elsewhere. |
| Trip planning offloaded to third-party app (Transit, Google) | Park City, Skagit, Streamline | Agencies lose visitors to third-party UI; one-click flow becomes "open the app, search again." |
| Real-time bus location only in app, not on the website | Streamline, Mountain Line, Mountain Express | Riders without the app are out of luck; the website never feels "live." |
| Best-in-class small-agency reference | Skagit Transit | Has an integrated realtime map + trip planner + system map directly on the site — but they paid a vendor for it. We can give that capability to every agency for free. |

**Net:** the gap is not "we need a fancier trip planner." It's that the canonical schedule (the GTFS feed) and the rider-facing website are maintained separately, so the website is always wrong. Embedding fixes that at the source.

---

## 2. Architecture Recommendation

### Hosted mini-site + embeddable widgets, both backed by the same canonical feed

```
feeds.gtfsbuilder.net/<slug>/                         # agency mini-site (public, indexed)
feeds.gtfsbuilder.net/<slug>/route/<route_id>         # one route's full page
feeds.gtfsbuilder.net/<slug>/stop/<stop_id>           # one stop's "departures from here"
feeds.gtfsbuilder.net/<slug>/embed/system-map         # iframe-friendly system map
feeds.gtfsbuilder.net/<slug>/embed/route/<route_id>   # iframe: one route's map + schedule
feeds.gtfsbuilder.net/<slug>/embed/schedule/<route_id>  # iframe: schedule table only
feeds.gtfsbuilder.net/<slug>/embed/stop/<stop_id>     # iframe: departures from this stop
feeds.gtfsbuilder.net/<slug>/widgets.js               # tiny loader for declarative web-component embeds
```

The hosted mini-site at `feeds.gtfsbuilder.net/<slug>/` is the same renderer as the embeds, just chrome-on. An agency that doesn't have a website at all can link to (or 301 from their domain to) the mini-site and be done.

### Implementation
- **Server-side rendered** (Workers + a small templating layer). HTML works without JS, hydrates for interactivity. Critical for SEO (riders Google "Route 4 schedule"), accessibility, and mobile-on-flaky-connection.
- **Same Worker as the rest of the platform**, served from `feeds.gtfsbuilder.net` (the auth-cookie-free origin already provisioned in BE Phase 3). New code path inside the existing Hono router.
- **Cached at the edge** (Cache-Control + ETag tied to feed version) — re-publishing invalidates the cache (BE-73).
- **Map tiles** served from existing PMTiles infrastructure where possible; fall back to Mapbox tokens we provision per-agency-mini-site (rate-controlled).
- **No third-party JS dependencies on the agency's page.** The widgets.js loader is ours; the iframe is ours; nothing leaks the rider's browsing back to anyone.

---

## 3. Data Model Additions

The published feed (BE-70) is the source of truth. Embeds are read-only views. New tables/fields:

| Entity | Purpose |
|---|---|
| `feed_branding` | Per-project branding overrides — primary color, logo URL, font, header text, favicon. One row per project. Owner-edit only. |
| `feed_route_branding` | *(optional)* Per-route overrides — display name, color (some GTFS feeds set route_color, but agencies often want display-only overrides without re-publishing), public description. |
| `embed_view_count` | Per-(project,embed_kind,date) rollup of impressions. Aggregated daily, no per-rider tracking. |
| `feed_locale` | Languages the agency wants the mini-site rendered in (subset of feed_info's `feed_lang`). At least `en`; agencies serving Spanish-speaking populations add `es`. |

The `publication` row already pins the canonical version; embeds always read from that version unless the request explicitly pins to an older one (EM-22).

---

## 4. Mini-Site (hosted at `feeds.gtfsbuilder.net/<slug>/`)

### 4.1 Landing page
- **EM-1**: System overview at `feeds.gtfsbuilder.net/<slug>/`. Shows agency name, contact, system-wide map, list of all routes (route_short_name + route_long_name + color swatch), list of any active service alerts, current effective date range from feed_info. Mobile-first responsive layout.
- **EM-2**: System map: interactive (pan/zoom), shows all route shapes in their `route_color`, all stops as small dots, agency basemap (light Mapbox style by default).
- **EM-3**: Service-day banner: "Today is Monday — weekday schedule in effect" / "Today is Memorial Day — Sunday schedule in effect" computed live from `calendar` + `calendar_dates`. Always present, always correct.
- **EM-4**: Effective date strip: "Schedule effective March 9, 2026 – June 15, 2026" pulled from feed_info. If we're inside the last 14 days of validity, surface a warning.
- **EM-5**: "Find next bus" — a stop search that resolves to the stop page (EM-15). Uses the `stops.txt` index, no third-party autocomplete.

### 4.2 Per-route page (`/route/<route_id>`)
- **EM-10**: Route header: short name + long name + color, agency, headway summary ("Every 30 minutes weekdays").
- **EM-11**: Route map: route's shape + all stops served by this route. Stops are clickable → stop page.
- **EM-12**: Schedule tables, one per direction × service period. Tables follow the standard "stop names down the side, trip times across the top" layout. Times are HH:MM in the agency's locale. After-midnight times (GTFS 25:30) display as "1:30 AM ⁺¹" (or equivalent in non-English locales).
- **EM-13**: Service-period selector: "Weekday" / "Saturday" / "Sunday" / any seasonal calendar variants — tabs at the top of the schedule region. Default = today's service.
- **EM-14**: Active alerts banner if any alert references this route (initially user-managed text in the editor; later via GTFS-RT alerts feed if registered per BE-89).

### 4.3 Per-stop page (`/stop/<stop_id>`)
- **EM-15**: Stop header: stop name, stop code, accessibility (`wheelchair_boarding`), lat/lon, amenity flags from `stops.txt`.
- **EM-16**: "Departures from this stop today": chronological list of upcoming departures across all routes serving the stop, derived from `stop_times` + the active service. No real-time in v1 (see EM-90).
- **EM-17**: Map showing this stop pinned, with surrounding street context. Walking-distance route shapes drawn lightly.
- **EM-18**: "All routes that serve this stop" — list with link to per-route page.

### 4.4 SEO & sharing
- **EM-20**: Server-rendered HTML, semantic markup (`<table>` for schedules, `<h1>`/`<h2>` hierarchy, `<nav>`).
- **EM-21**: Open Graph + Twitter card meta on every page so a tweeted "/route/4" link gets a preview with route color and headway.
- **EM-22**: Canonical URLs always reference the project slug, not version IDs. Pinned-version views available via `?version=<id>` query param (used internally by embeds that want stability across republishes).
- **EM-23**: `sitemap.xml` per agency mini-site; `robots.txt` allows crawling. A republish bumps `<lastmod>` per page so search engines re-crawl.
- **EM-24**: Structured data: `schema.org/BusOrRoute` JSON-LD on per-route pages, `schema.org/BusStop` on per-stop pages. Helps Google surface "next bus from X" in rich results.

---

## 5. Embeddable Widgets (for the agency's existing website)

Three integration patterns, in increasing order of polish:

### 5.1 Iframe (zero JS on the host page)
- **EM-30**: `<iframe src="https://feeds.gtfsbuilder.net/<slug>/embed/route/4" width="100%" height="600">` works on any CMS that allows raw HTML, including WordPress, Squarespace, Wix, and most agency-built sites.
- **EM-31**: Iframes auto-resize to content height via `postMessage` heartbeat (the iframe sends its `scrollHeight`; a tiny `widgets.js` loader on the host listens and adjusts the iframe). If the loader isn't present (raw iframe), the iframe falls back to a sensible default height with internal scroll.
- **EM-32**: All embed routes accept the same query params: `?theme=light|dark|auto`, `?accent=#hex`, `?lang=en|es|...`, `?service=weekday|saturday|sunday|today`, `?version=<id>` (pin), `?compact=1` (mobile-first dense layout).
- **EM-33**: `Content-Security-Policy: frame-ancestors *` on embed responses (publicly embeddable). The hosted mini-site uses `frame-ancestors 'none'` to prevent clickjacking of the canonical view.
- **EM-34**: `X-Robots-Tag: noindex` on embed routes (we don't want embeds outranking the host page in search).

### 5.2 Web component / declarative loader
- **EM-40**: One-line install: `<script src="https://feeds.gtfsbuilder.net/<slug>/widgets.js" defer></script>`.
- **EM-41**: Custom elements: `<gtfs-route-map route="4">`, `<gtfs-schedule route="4" service="weekday">`, `<gtfs-system-map>`, `<gtfs-departures stop="ABC123">`, `<gtfs-alerts>`. Each renders the same content as the equivalent iframe, but as in-page DOM (no iframe, no resize hack).
- **EM-42**: Shadow DOM scopes our styles so the host page's CSS can't leak in and break the layout.
- **EM-43**: Attributes mirror the iframe query params: `theme`, `accent`, `lang`, `service`, `version`, `compact`.
- **EM-44**: Total widgets.js size budget: **<25 KB gzipped**. No React, no framework — vanilla web components. Map tiles + Mapbox GL load only when a `<gtfs-route-map>` actually mounts, code-split.

### 5.3 Headless API
- **EM-50**: Public read-only JSON API for agencies that want to roll their own UI: `GET https://feeds.gtfsbuilder.net/<slug>/api/routes`, `/api/routes/<id>`, `/api/stops/<id>/departures?service=today`, `/api/alerts`. Cached aggressively at the edge.
- **EM-51**: API responses pin to the current canonical version unless `?version=<id>` is passed.
- **EM-52**: `Access-Control-Allow-Origin: *` on the API endpoints — they're public.
- **EM-53**: Rate limiting per-IP (KV-backed) with generous headroom; a typical agency embed will hit cache anyway.

---

## 6. Customization & Branding

### 6.1 Branding controls (in the editor)
- **EM-60**: New "Branding" panel in the GTFS Builder editor: agency logo (upload to R2, recommended ≤200×60), primary color (hex or color picker), header text override, favicon, custom CSS variables exposed as advanced. Saved per-project; takes effect immediately on the mini-site and on all embeds for that feed.
- **EM-61**: Per-route display name override (some agencies have "Route 4 — Downtown Loop" in GTFS but want the embed to read "Downtown Loop" only). Doesn't change the published feed; only affects embed/mini-site rendering.
- **EM-62**: Header CTA: optional 1–2 buttons (e.g. "Plan a trip in Transit app" linking out, "Contact dispatch") on the mini-site header. URLs validated; no JavaScript injection.

### 6.2 Localization
- **EM-65**: Mini-site and embeds support `?lang=` query param. Languages we ship UI strings for: English + Spanish at launch (Streamline already publishes Spanish PDFs — clear demand). Other languages added on request.
- **EM-66**: Route names and stop names come from the GTFS feed; if the feed has `translations.txt` (GTFS-Translations spec), the embed uses translated names for the requested language.
- **EM-67**: Detect a host page's `lang` attribute via a `data-lang="auto"` on the web component and pick that language by default; fall back to feed_info's `feed_lang`.

### 6.3 Themes
- **EM-70**: Three built-in themes: `light` (default), `dark`, `auto` (follows host's `prefers-color-scheme`). The agency's primary color is layered on top — so an agency with a teal brand color gets teal accents in both light and dark.

---

## 7. Service-Day Logic & Detours

This is the part that PDF schedules get wrong most often.

- **EM-80**: "Today's service" calculated server-side in the agency's timezone (from `agency.txt`), using `calendar` for regular weekly patterns and `calendar_dates` for exceptions. Re-evaluated per request; cached for ≤60 seconds.
- **EM-81**: Holiday adjustments: if a `calendar_dates` row removes regular service and adds an alternate `service_id`, the embed says "Memorial Day — Sunday schedule in effect today" and shows that schedule by default.
- **EM-82**: Detours / temporary changes: free-text alerts entered in the editor (or pulled from a registered GTFS-RT alerts feed per BE-89) appear at the top of relevant route/stop pages, not on a separate "Alerts" page.
- **EM-83**: When a feed is within 14 days of `feed_end_date`, embed shows a "Schedule expires Mar 8 — agency, please publish a new version" inline note (visible to logged-in members of the owning org only — public riders see no warning, just the schedule).

---

## 8. Performance & Accessibility

### 8.1 Performance
- **EM-100**: Mini-site landing page **First Contentful Paint < 1.2 s on a slow 4G connection**. Critical CSS inlined, no render-blocking JS.
- **EM-101**: Map tiles lazy-loaded — the route map doesn't render until it's in viewport.
- **EM-102**: Schedule tables paginated only if a single direction has >120 trips; otherwise render fully (small agencies rarely cross that bar).
- **EM-103**: Edge-cached aggressively. `Cache-Control: public, max-age=300, s-maxage=3600`. Republish busts via `cache.delete()` on the relevant URLs.

### 8.2 Accessibility
- **EM-110**: WCAG 2.1 AA target. Audited with axe-core in CI on every PR.
- **EM-111**: Schedule tables use `<th scope="row">` for stop names and `<th scope="col">` for trip headers; readable by screen readers as a 2-D table.
- **EM-112**: Map controls keyboard-navigable; all interactive elements focus-visible. Map content has a "View as list" toggle for users who can't use the map.
- **EM-113**: Color-only signaling never conveys meaning alone (alerts get an icon + text, not just red).
- **EM-114**: Minimum 4.5:1 contrast on text by default; we lint the agency's chosen primary color against background and warn if contrast is too low.
- **EM-115**: Screen-reader announcement when the active schedule changes ("Now showing Saturday schedule"). `aria-live="polite"` on the schedule region.

---

## 9. Privacy

- **EM-120**: No third-party analytics on the mini-site or embeds. We collect aggregate impression counts (project + embed kind + day) server-side for the agency's own dashboard, no per-rider tracking, no cookies on the rider's browser.
- **EM-121**: Embeds set `Permissions-Policy: interest-cohort=()` and `Referrer-Policy: strict-origin-when-cross-origin`.
- **EM-122**: When an agency embeds on their own site, **rider IPs hit our edge for tile + page fetches**. We log them in standard CF logs (retained per CF defaults, not exported to anywhere with PII). We document this in a one-pager an agency can link from their privacy policy.
- **EM-123**: Map tile attribution renders inline (Mapbox / OpenStreetMap), so we satisfy attribution requirements without the agency needing to add it.

---

## 10. Operator Surfaces

### 10.1 Agency-side (in the GTFS Builder editor)
- **EM-130**: New "Embed" tab on a published project. Shows: copy-pasteable iframe snippet, copy-pasteable web-component snippet, link to the mini-site, list of available widget types with live previews.
- **EM-131**: Per-widget impression counts: "System map: 4,210 views in the last 30 days" — drawn from `embed_view_count`. Helps agencies justify the tool internally.
- **EM-132**: "Test this embed" preview frame inside the editor — same renderer, lets an agency see exactly what their riders will see before they paste it on their site.

### 10.2 Platform-side (admin)
- **EM-135**: Admin dashboard adds: total unique mini-sites visited, total embed impressions, top-10 most-embedded agencies. Just numbers — no per-rider data.

---

## 11. Public API Surface (additions)

All read-only, public, no auth.

| Method & Path | Purpose |
|---|---|
| `GET feeds.gtfsbuilder.net/<slug>/` | Mini-site landing |
| `GET feeds.gtfsbuilder.net/<slug>/route/<route_id>` | Per-route page |
| `GET feeds.gtfsbuilder.net/<slug>/stop/<stop_id>` | Per-stop page |
| `GET feeds.gtfsbuilder.net/<slug>/embed/system-map` | System map iframe |
| `GET feeds.gtfsbuilder.net/<slug>/embed/route/<route_id>` | Route iframe |
| `GET feeds.gtfsbuilder.net/<slug>/embed/schedule/<route_id>` | Schedule-only iframe |
| `GET feeds.gtfsbuilder.net/<slug>/embed/stop/<stop_id>` | Stop departures iframe |
| `GET feeds.gtfsbuilder.net/<slug>/widgets.js` | Web-component loader |
| `GET feeds.gtfsbuilder.net/<slug>/api/routes` | Route list JSON |
| `GET feeds.gtfsbuilder.net/<slug>/api/routes/<id>` | One route JSON |
| `GET feeds.gtfsbuilder.net/<slug>/api/stops/<id>/departures` | Departures JSON |
| `GET feeds.gtfsbuilder.net/<slug>/api/alerts` | Active alerts JSON |
| `GET feeds.gtfsbuilder.net/<slug>/sitemap.xml` | SEO |
| `GET feeds.gtfsbuilder.net/<slug>/robots.txt` | SEO |

Authenticated (editor → embed config):

| Method & Path | Purpose |
|---|---|
| `GET  /api/projects/:id/branding` | Get current branding |
| `PUT  /api/projects/:id/branding` | Update branding (color, logo, header text, custom CSS vars) |
| `POST /api/projects/:id/branding/logo` | Upload logo (multipart, R2-backed) |
| `GET  /api/projects/:id/embed-stats?range=30d` | Per-widget impression counts |

---

## 12. Phasing

Each phase ends with a demoable thing.

### Phase 7a — Mini-site MVP (3–4 weeks)
Hosted mini-site only, no embeds yet. Landing page + per-route page + per-stop page, server-rendered, with the system map and per-route map. English only. Today's service-day banner. Read straight from the canonical published feed.

**Demo:** "Here's `feeds.gtfsbuilder.net/streamline/` with all of Streamline's routes, the schedule for today, and a working map."

### Phase 7b — Iframe embeds (1–2 weeks)
Same renderer, served at `/embed/...` with auto-resize, themes, accent colors, language param. Agency copies an iframe snippet from a new "Embed" tab in the editor.

**Demo:** "I pasted this iframe on a WordPress staging site; here's the route map embedded next to the agency's existing copy."

### Phase 7c — Web components + widgets.js (2–3 weeks)
`widgets.js` loader, custom elements, shadow DOM, code-split map, web-component-only attributes. Iframe embeds remain available.

**Demo:** "Single `<gtfs-route-map route='4'>` element on a hand-rolled HTML page, no iframe, fits the host's design system."

### Phase 7d — Branding, localization, alerts (2 weeks)
Branding panel in the editor (logo, primary color, custom header). Spanish translations. Free-text alert authoring. Per-widget impression counts.

**Demo:** "Streamline Spanish mini-site with their teal brand color, a detour alert showing on the affected route, and a 'Memorial Day — Sunday schedule today' banner."

### Phase 7e — Headless API + structured data (1–2 weeks)
JSON API for agencies that want to build their own UI. Schema.org JSON-LD. Sitemap. Open Graph cards.

**Demo:** "I tweeted `feeds.gtfsbuilder.net/streamline/route/4` and the unfurled card shows the route color and headway. Searching Google for 'Streamline Route 4 schedule' returns the mini-site as the top result."

### Phase 7f — GTFS-RT integration *(stretch)*
If the project has a registered RT feed (BE-87), surface live arrival times on stop pages and "next bus" indicators on the system map. We don't host the RT feed, just consume it from the URL the agency registered.

**Demo:** "Stop 1234 shows '4 min — Route 7' updating in real time."

---

## 13. Out of Scope (v1)

- **In-app trip planning.** Riders use Transit / Google Maps / Apple Maps. We deep-link to those, we don't build a competitor.
- **Fare purchase or account-linked fare products.** Lots of regulatory + integration work, niche demand for small agencies.
- **Native mobile apps.** Mini-site PWA-style installation is the path.
- **Per-route comments / ratings / community.** We're a publishing tool, not a transit social network.
- **Custom domain for the mini-site.** Same rationale as BE §5.3 — agencies can `301` from their domain.
- **GTFS-RT hosting.** §6.5 of the backend doc; we coordinate but don't generate.
- **Advertising / sponsored content.** Privacy + simplicity.

---

## 14. Open Questions

1. **Map tile costs.** Mapbox is generous on free tier but a popular agency could cross it. Do we (a) cap views and switch to OSM tiles past a threshold, (b) require agencies on heavy-use plans to bring their own Mapbox token, or (c) absorb cost as part of RTAP licensing?
2. **Branding logo upload — image processing.** Resize/optimize on upload (Workers Image API), or store original and serve on-demand?
3. **Embed-version pinning.** Do we default embeds to "always latest" (republish updates the embed automatically) or "pinned to version at embed-creation time" (agency must manually re-paste to update)? Recommendation: **always latest** with an opt-in `?version=<id>` for testing. The whole point is to remove the drift.
4. **Realtime in v1 vs v2.** Defer to Phase 7f as drawn here, or push it earlier given how much riders ask for it?
5. **Multi-agency feeds.** A regional org publishes one feed for three agencies (multi-`agency_id` GTFS). Mini-site needs an agency picker. Is this Phase 7a or Phase 7b?

---

## 15. Decisions (resolved during review)

*(To be filled in after review — same pattern as §12 of `BACKEND_REQUIREMENTS.md`.)*
