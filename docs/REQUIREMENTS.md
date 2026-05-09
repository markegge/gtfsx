# GTFS Builder — Requirements

## Overview

GTFS Builder is a web application for creating, editing, analysing, and publishing GTFS (and GTFS-Flex) transit feeds. It targets small-to-mid-sized transit agencies and the consultants who serve them. The primary surface is a Mapbox-backed editor where alignments are drawn before stops are placed; analysis features let users size service against demand, demographics, and cost; and a backend tier handles accounts, multi-agency workspaces, publication, and embeddable rider-facing widgets.

### Status snapshot

| | |
|---|---|
| **Editor (anonymous, IndexedDB-only)** | Live in production at https://www.gtfsbuilder.net |
| **Backend (auth, projects, orgs, publication, embeds)** | Live on staging at https://staging.gtfsbuilder.net (and feeds at https://staging-feeds.gtfsbuilder.net). **Disabled in production** since 2026-05-08 (kill switch) — backend code is deployed but `BACKEND_ENABLED=false` and the SPA bundle ships with `VITE_BACKEND_ENABLED=false`. |
| **Active development branch** | `staging-features` (new since the last main merge: Turnstile signup gate; embeds with mini-site landing, per-route, per-stop, system map; org logo upload + brand colour; cross-workspace feed transfer; orphan-stop deletion choice on route delete; export-all-stops fidelity fix). |

If you are picking this project up cold: read this overview, then `docs/BACKEND_STATUS.md` for the live operational picture, then the section below that matches the area you're working in.

---

## How this document is organized

Four sections corresponding to the major capability areas:

1. **GTFS feed editing** — the map + form + timetable workflows that produce a valid GTFS feed.
2. **Analysis and route development** — the things you do *with* a feed before you publish it: demand dots, demographic coverage, Title VI equity, cost estimation.
3. **Account and organization management** — auth, orgs, multi-tenant workspaces, branding, admin console.
4. **Feed publication and distribution** — versioning, canonical publish, draft links, catalog submissions, and rider-facing embeds + mini-site.

Within each section, capabilities are marked:

- ✅ **Shipped** — built and exercised in production or staging.
- 🟡 **Partial** — modelled, with known gaps tracked elsewhere.
- 🔲 **Planned** — specced but not built.
- 🚫 **Deferred** — considered and deliberately skipped.

Detailed plans, schemas, and runbooks live in companion documents (linked at the bottom). This file is intentionally short — it's the orientation map, not the territory.

---

## 1. GTFS feed editing

### 1.1 GTFS spec coverage

Required and core-optional files are first-class entities in the editor:

| File | Status |
|---|---|
| `agency.txt` | ✅ |
| `stops.txt` | ✅ |
| `routes.txt` | ✅ |
| `trips.txt` | ✅ |
| `stop_times.txt` | ✅ |
| `calendar.txt` | ✅ |
| `calendar_dates.txt` | ✅ |
| `shapes.txt` | ✅ |
| `feed_info.txt` | ✅ |
| `fare_attributes.txt` / `fare_rules.txt` | ✅ |
| `directions.txt` (auto-emitted from per-route direction names) | ✅ |
| `frequencies.txt` (headway-based service) | 🔲 |
| `transfers.txt` | 🔲 |
| `pathways.txt` | 🔲 |
| GTFS-Flex (`locations.geojson`, `booking_rules.txt`, `location_groups.txt`, extended `stop_times`) | 🟡 — see [`FLEX_ROADMAP.md`](./FLEX_ROADMAP.md) |

### 1.2 Routes and shapes

The editor enforces a **route-first** workflow: alignment is drawn before stops are placed. This supports rapid iteration on alignments — important for analysis features that compare candidate alignments against demand and demographics.

- ✅ Route metadata (short/long name, color picker, GTFS route type, agency, URL).
- ✅ Polyline drawing with vertex add/remove/drag.
- ✅ Snap-to-road via the Mapbox Map Matching API.
- ✅ Freehand drawing for off-road segments.
- ✅ Multiple shape variants per route (e.g., inbound vs outbound; loops).
- ✅ `shape_dist_traveled` auto-calculated on export.
- ✅ Per-route hidden/visible toggle on the map.
- ✅ Route delete cascades trips, `stop_times`, `route_stops`, fare rules, and shapes only used by this route. Stops unique to the route are deleted by default; user can opt out via the delete confirmation dialog to preserve them as standalone stops in `stops.txt` (useful when reassigning to a different route).

### 1.3 Stops

Stops are placed in the context of the currently-selected route. Default behaviour mimics curbside placement: the stop snaps to the route line and renders offset to the right-hand side relative to direction of travel.

- ✅ Click-to-place along the active route; snaps to nearest point on the route line.
- ✅ Right-hand offset rendering (curbside convention) per direction.
- ✅ Freehand stop placement for off-route stops (park-and-rides, transfer points).
- ✅ Drag to reposition; snapped stops re-snap, freehand stops move freely.
- ✅ Stop attributes: name, code, description, lat/lon, wheelchair boarding.
- ✅ Multi-route stops — stops can be assigned to additional routes; near-duplicate detection prompts to reuse existing stops.
- ✅ Reorder stops along a route via drag-and-drop.
- ✅ Bulk import stops from CSV.
- 🟡 Parent station / location_type hierarchy — types accepted on import + preserved on export, no rich UI for editing the hierarchy.
- ✅ Stop names labelled on the map at appropriate zoom levels.

### 1.4 Calendars and service patterns

- ✅ Day-of-week toggles + start/end date.
- ✅ `calendar_dates` exception editor (added/removed days).
- ✅ Bulk-add common US holidays (MLK Day, Presidents' Day, Memorial Day, July 4, Labor Day, Thanksgiving, Christmas, etc.) within the active service date range.
- ✅ Visual calendar showing which services run on which dates, with exception days colour-coded.
- ✅ Human-readable service summary ("Weekdays", "Saturday Only", custom day patterns) — surfaced both inside the editor and on rider-facing embeds.
- 🔲 Validation nudge when a service pattern has no exception dates configured for major holidays.

### 1.5 Trips and timetables

- ✅ Per-route timetable grid (rows = trips, columns = stops, cells = times).
- ✅ Trip metadata: headsign, direction, service pattern, block_id, wheelchair_accessible.
- ✅ Auto-interpolate intermediate stop times from distance + speed.
- ✅ Duplicate a trip with a configurable time offset (e.g. "repeat every 30 min").
- ✅ Bidirectional editing — changes in the timetable reflect on the map and vice versa.
- ✅ Service summary showing weekly revenue hours, trips per week, peak vehicles per route.
- ✅ Per-stop departures view ("departures from this stop today").
- 🔲 Frequency-based service entry (`frequencies.txt`).
- 🔲 Marey diagram (time–distance trip chart).
- 🔲 Block assignment UI (block_id is preserved on round-trip but isn't a first-class editor concept yet).

### 1.6 Fares

Fare information is **strongly encouraged**. Empty-fare feeds are flagged prominently; export emits a warning.

- ✅ Fare attributes (price, currency, payment method, transfer policy, transfer duration).
- ✅ Fare rules — flat-route fares, zone-to-zone matrices.
- ✅ Multiple fare types (regular, reduced, etc., via additional `fare_id`s).
- ✅ Empty-fare warning banner + export-time validation warning.
- 🟡 Zone editor — basic zone assignment per stop is supported; no map-drawing zone editor yet.

### 1.7 GTFS-Flex (demand-responsive service)

Coverage is detailed in [`docs/FLEX_ROADMAP.md`](./FLEX_ROADMAP.md) which is the source of truth for what's shipped vs open. Headlines:

- ✅ `locations.geojson` polygon zones (single + multi-polygon) with edit handles on the map.
- ✅ `booking_rules.txt` (booking type, prior-notice durations, contact info, messages) per zone or trip.
- ✅ Extended `stop_times` (location_id, pickup/drop_off booking rule ids, pickup/drop-off windows).
- ✅ `location_groups.txt` + `location_group_stops.txt`.
- ✅ Zone ↔ route ↔ service_id linkage preserved on round-trip; map popups for editing.
- 🟡 / 🔲 — see roadmap for the open items.

### 1.8 Validation, import, export

- ✅ Real-time validator running against canonical GTFS rules — surfaces errors (block export) and warnings (exportable but flagged).
- ✅ Click-to-navigate from a validation message to the offending entity.
- ✅ Auto-fix path in the export dialog for orphan references (trips → missing routes, stop_times → missing stops, etc.).
- ✅ Import GTFS ZIP — parses every supported file, preserves unknown columns where possible, populates the editor.
- ✅ Export GTFS ZIP — emits every populated file. As of the export-fidelity fix on the `staging-features` branch, every stop in editor state is written to `stops.txt` (previously, unreferenced stops were silently dropped; the validator already warns on unused stops, so users still get the nudge).

---

## 2. Analysis and route development

The editor is also a planning tool. These features answer "where should we run service?" and "what would it cost?" alongside the basic editing flow. They run client-side against in-memory feed state plus bundled or fetched reference data.

### 2.1 Demand dot map

A nationwide vector-tile layer of dot-density transit demand, served from R2 PMTiles via the Cloudflare Worker. Each dot represents one of:

- **High transit propensity** (renters ∪ zero-vehicle households ∪ ages 18–24, deduplicated).
- **Other adults**.
- **Jobs** (LODES WAC, all sectors).

Resolution: TIGER block (TABBLOCK20) geometries, with ACS variables apportioned from block group → block by land area. See [`docs/demand-dots-nationwide-plan.md`](./demand-dots-nationwide-plan.md) for the build pipeline + refresh cadence.

- ✅ Built and live: `us-2026b` archive served at `/_demand-tiles/<archive>/{z}/{x}/{y}.pbf`.
- ✅ Toggleable map layer (`DemandDotsLayer.tsx`).
- 🚫 Demand dots are **display only** — explicitly not wired into coverage / Title VI analysis. The analysis pipeline uses ACS tract centroids for apportionment to keep methodology stable.

### 2.2 Demographic coverage

Walkshed-based apportioned coverage analysis — for each stop, how many people / households / workers live within a configurable buffer (default 0.5 miles). Apportions ACS block-group totals via a circle–circle overlap formula (`coverageAnalysis.ts`).

- ✅ Tract centroids bundled per state in `public/census/TR<FIPS>.txt`.
- ✅ ACS variables fetched live from `api.census.gov` (B03002 race, B25044 vehicles, B23025 workers, etc.).
- ✅ `CoveragePanel` UI with covered population, household, worker totals + Title VI summary tabs.
- ✅ Map overlay showing which block groups are covered, shaded by apportionment fraction.

### 2.3 Title VI equity analysis

Implements the methodology in [`Title VI Transit Service Analysis - Calculation Procedures Memo.md`](./Title%20VI%20Transit%20Service%20Analysis%20-%20Calculation%20Procedures%20Memo.md): apportions daily trips per stop to nearby block groups, classifies block groups as minority or non-minority against the regional minority share, and reports the ratio of average daily trips received by each group.

- ✅ End-to-end calculation in `titleVI.ts` reusing `coverageAnalysis`'s overlap math.
- ✅ `TitleVIPanel` summarising per-group population, average daily trips, and the minority/non-minority ratio.

### 2.4 Cost estimation

Estimates annual operating cost from feed structure + per-route inputs.

- ✅ Per-route UI fields for cost-per-revenue-hour and vehicles-required (stored as `_cost_per_revenue_hour` / `_vehicles_required` UI-only fields, ignored on export).
- ✅ Computes weekly revenue hours, peak vehicles, weekly cost — broken out per service pattern and rolled up to annual.
- ✅ `CostSummary` panel surfaces the totals.
- 🔲 Scenario comparison ("what if we add a Saturday run?").
- 🔲 Deadhead-factor inputs beyond a global multiplier.

---

## 3. Account and organization management

Specced in [`docs/BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md), phased in [`docs/BACKEND_IMPLEMENTATION_PLAN.md`](./BACKEND_IMPLEMENTATION_PLAN.md), runbook in [`docs/DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md), live state in [`docs/BACKEND_STATUS.md`](./BACKEND_STATUS.md).

The backend tier is implemented as a single Cloudflare Worker that also serves the SPA's static assets and the public feeds origin. D1 holds metadata; R2 holds working-state JSON, version snapshots, GTFS zips, and org logos; KV holds rate-limit counters.

### 3.1 Authentication

- ✅ Email + password signup with email verification.
- ✅ Magic-link login.
- ✅ Password reset.
- ✅ Logout (per-session) + logout-all-devices.
- ✅ HTTP-only `Secure SameSite=Lax` session cookies; idle (30d) + absolute (90d) timeouts.
- ✅ Cloudflare Turnstile captcha gate on `/auth/signup` (Managed mode; site key public, secret as Worker secret).
- ✅ Rate limits on all `/auth/*` endpoints (KV-backed, per IP + per email).
- ✅ Account settings: change name, email (with re-verify), password, soft-delete account.
- ⚠️ Password hashing is PBKDF2-HMAC-SHA256 @ 100k iterations (workerd cap). Argon2id migration is the **NF-40a** follow-up that should land before broad RTAP distribution; details in `BACKEND_REQUIREMENTS.md` §9.1.
- 🔲 Google OAuth (deferred to v1.1 per the requirements doc).

### 3.2 Organizations

- ✅ Create / rename / delete (soft-delete) orgs.
- ✅ Membership roles: `owner`, `admin`, `editor`, `viewer`. Many-to-many — one user can belong to multiple orgs (consultant case is a primary scenario).
- ✅ Invitation flow (email-based; consumer signs up if needed and joins on accept).
- ✅ Ownership transfer; last-owner protection.
- ✅ Org settings page at `/orgs/<slug>` — members, roles, invitations, branding.
- ✅ Per-project membership granularity is **not** built and is a future option (see BACKEND_REQUIREMENTS BE-95).

### 3.3 Workspaces and feed ownership

- ✅ A feed project is owned by either a user (personal) or an org. Slug uniqueness is per `(owner_type, owner_id)`.
- ✅ Workspace switcher in the top bar; `My Feeds` page is workspace-scoped (the prior behaviour of always returning personal feeds was a bug, fixed on `staging-features`).
- ✅ Cross-workspace feed transfer: kebab → "Move to…" with workspace picker (Personal + every org where the user is editor+). Auto-suffixes the slug on collision; updates `publication.canonical_slug` in lockstep so a published feed's URL keeps pointing at the same project after a move.
- ✅ Anonymous → signed-in import: local IndexedDB projects can be uploaded to the server on first sign-in; collision/quota prompts.

### 3.4 Quotas and abuse controls

- ✅ Quotas: 20 projects per owner, 50 versions per project, 50 MB per ZIP. Implemented as soft-warn at the 90% threshold (`HARD_LIMITS=true` env flag flips to hard rejection — intended for the eventual RTAP licensing model).
- ✅ Per-IP + per-email rate limits on auth endpoints.
- ✅ Turnstile signup gate.
- ✅ CSRF defense via `X-GB-Client` header on state-changing endpoints.
- 🔲 Abuse controls in the admin panel (disable user, freeze new signups by IP, take down a user's publications) — see BACKEND_REQUIREMENTS §10.1 / Phase 6.

### 3.5 Admin console

- ✅ Routes under `/admin` gated on `user.staff = 1`; non-staff get 404 (not 403) to avoid surface enumeration.
- ✅ Dashboard counters (users by status, orgs, projects, versions, publications, signups this week/month, active-user proxy via session activity).
- ✅ Users: paginated table, filter by status + email substring, row actions (disable / re-enable, resend verification, impersonate).
- ✅ Orgs: paginated table, member-role management.
- ✅ Audit log: filtered + paginated viewer with CSV export.
- 🔲 Global full-text search, bulk operations, abuse review queues — deferred per BACKEND_REQUIREMENTS §10.6.

### 3.6 Org branding

- ✅ Per-project primary color (hex) — drives the active service-day tab + accent links on every embed surface (CSS custom property `--brand`).
- ✅ Per-org logo upload (PNG / JPEG / WebP / SVG; ≤1 MB) at `/api/orgs/:id/logo`. Public read at `feeds.gtfsbuilder.net/_/orgs/<id>/logo` with edge cache + ETag.
- ✅ Logo renders next to the agency name on the mini-site landing, per-route, per-stop, and system-map embeds.
- 🔲 Custom CSS variables / advanced theming (specced in EMBEDS_REQUIREMENTS EM-60, deferred for now).
- 🔲 Per-route display-name override (specced as EMBEDS_REQUIREMENTS EM-61, deferred).

---

## 4. Feed publication and distribution

Specced in [`BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md) §5–6 and [`EMBEDS_REQUIREMENTS.md`](./EMBEDS_REQUIREMENTS.md).

### 4.1 Canonical publication

- ✅ "Publish" promotes a saved version to the canonical URL `feeds.gtfsbuilder.net/<slug>/gtfs.zip`. Stable across republishes; only the bytes change.
- ✅ Validation gate: errors block publish; warnings allowed (configurable per-publish).
- ✅ Cache headers tuned for GTFS ingestors: `public, max-age=3600, s-maxage=3600`, version-id ETag, `Last-Modified`, 304 support, atomic R2 → D1 pointer flip.
- ✅ Sidecar `feeds.*/<slug>/feed_info.json` with title, description, effective dates, version id, contact, distribution targets, registered RT feeds.
- ✅ Unpublish — pointer cleared, canonical URL returns `410 Gone`. Republish restores.
- ✅ Publication history view + rollback ("publish this old version again").
- ✅ Per-version state stored as gzipped JSON (R2) plus a rendered ZIP (also R2); two immutable blobs per version.
- 🔲 Scheduled publish ("go live on 2026-06-01 at 02:00 UTC") — BACKEND_REQUIREMENTS BE-77, stretch.

### 4.2 Draft links

- ✅ "Get review link" generates `feeds.*/<slug>/draft/<token>.zip` with an unguessable 192-bit token (hashed at rest). 30-day default expiry, renewable, revocable.
- ✅ `X-Robots-Tag: noindex`; feeds-origin `robots.txt` disallows `/draft/`.
- ✅ Each draft URL points to a specific `feed_version` so the bytes don't change once a link is shared.

### 4.3 Catalog submissions and distribution metadata

- ✅ One-time opt-in per project at first publish: register with the Mobility Database (real API call against the existing refresh token).
- 🟡 transit.land submission — wired through the same `CatalogClient` interface but stubbed (status=`pending`, manual-review marker). Pre-RTAP follow-up, see BACKEND_STATUS §5.
- ✅ External GTFS-RT feed URLs can be registered per project (vehicle_positions / trip_updates / alerts). They're metadata only — we don't proxy or generate RT.
- ✅ ID-stability check on publish: warns when a publish would drop or rename a `trip_id` / `stop_id` / `route_id` / `agency_id` referenced by a registered RT feed.
- ✅ Distribution checklist UI: Mobility DB (auto), transit.land (auto/stub), Google Transit Partners + Apple Maps Transit + Transit app (external links + manual mark-done).
- 🚫 GTFS-Realtime feed generation or hosting — out of scope; we coordinate with existing RT feeds only.

### 4.4 Embeddable maps and schedules

Full spec: [`EMBEDS_REQUIREMENTS.md`](./EMBEDS_REQUIREMENTS.md). Live on staging.

Architecture: server-rendered HTML on the FEEDS origin (Hono `html` template), edge-cached, version-id ETag. Same renderer powers the public mini-site landing, the iframe embeds, and shared social-card meta. Mapbox GL JS via CDN; the SPA's existing public publishable token is also bound to the Worker as `MAPBOX_TOKEN`.

| Surface | URL | Status |
|---|---|---|
| Mini-site landing | `feeds.*/<slug>/` | ✅ — agency name + contact, system map, route list, today's-service banner, `frame-ancestors 'none'`, indexable |
| Per-route embed | `feeds.*/<slug>/embed/route/<route_id>` | ✅ — route map + schedule table with seasonal/day-pattern tabs, defaults to today's pattern |
| Per-stop embed | `feeds.*/<slug>/embed/stop/<stop_id>` | ✅ — chronological "departures today" + map + routes serving the stop |
| System-map embed | `feeds.*/<slug>/embed/system-map` | ✅ — all routes coloured, clickable stop dots, route list |
| Demo agency page | `/embed-demo/` (editor origin) | ✅ — fake "Sunny Valley Transit" page demonstrating iframe usage |

Cross-cutting embed features:

- ✅ Today's-service banner ("Today is Friday · Weekday schedule in effect" / "No service today") computed in agency timezone.
- ✅ Feed-expiry warning when within 14 days of `feed_end_date` (yellow) or already past (red).
- ✅ Service-day tabs split by both day pattern AND date range — feeds with seasonal services (e.g., summer / fall / spring weekday variants) get separate tabs disambiguated by date.
- ✅ Per-org brand logo + per-project brand color applied via CSS custom properties.
- ✅ Open Graph + Twitter card meta on every embed page.
- ✅ Mobile responsive layout (220px map on phones, sticky stop-name column, narrower tabs).
- ✅ Editor "Embed" bottom-tab on a published feed: copy-pasteable iframe snippets per route + system map; live brand-color picker.
- 🔲 `widgets.js` declarative web-component loader (`<gtfs-route-map>`, `<gtfs-schedule>`) — EMBEDS_REQUIREMENTS Phase 7c.
- 🔲 Headless JSON API at `feeds.*/<slug>/api/*` — Phase 7e.
- 🔲 Localization — UI strings in English only; Spanish queued (Streamline already publishes Spanish PDFs, so demand exists). Per-route display name overrides + `translations.txt` consumption deferred to the same phase.
- 🔲 Per-stop / per-route impression counters (`embed_view_count`) and the agency-facing usage view.
- 🔲 GTFS-RT integration on stop pages (live arrival times when an RT feed is registered) — Phase 7f stretch.
- 🚫 Custom domains for published feeds. Agencies can `301` from their own domain if needed; we don't issue per-tenant certs.

---

## Cross-cutting

### Mapping platform — Mapbox GL JS

The original platform analysis is preserved here because the choice still drives most map-related decisions:

| Consideration | Mapbox GL JS | Google Maps JS API | Leaflet + OSM |
|---|---|---|---|
| Drawing/editing tools | Excellent — `mapbox-gl-draw` supports points, lines, polygons with snapping, vertex editing, drag | Drawing library exists but limited vertex editing, no snapping | `leaflet-draw` works but less polished |
| Custom map styling | Full control — Studio editor, custom tilesets | Limited via JSON; fewer options | Tile-provider dependent |
| Performance (large shapes) | WebGL-rendered, handles thousands of shape points | Good but heavier DOM usage | Canvas mode helps but slower |
| Polygon support (Flex zones) | Native, with editing handles | Basic | Basic |
| Pricing | 50K free map loads/mo, then $0.60/1K | $7/1K loads after $200 credit | Free, tile-quality / hosting tradeoffs |
| Developer experience | Excellent docs, TypeScript, `react-map-gl` | Mature but more boilerplate | Very flexible but more DIY |

We use `react-map-gl` + `@mapbox/mapbox-gl-draw` in the editor and Mapbox GL JS via CDN in the embed renderer. The Map Matching API powers snap-to-road. Cost stays well under the free tier at current usage; scaling assumptions live in `EMBEDS_REQUIREMENTS.md` §14.

### Infrastructure

Single Cloudflare account; everything runs as a single Worker with static-asset binding and multiple custom domains.

```
www.gtfsbuilder.net          → editor SPA + /api + /auth + /_demand-tiles
gtfsbuilder.net (apex)       → same as www
feeds.gtfsbuilder.net        → public feed distribution + embed renderer
                               + /_/orgs/<id>/logo public read

staging.gtfsbuilder.net      → staging editor
staging-feeds.gtfsbuilder.net → staging feeds origin
```

| Concern | Service |
|---|---|
| Compute | Cloudflare Worker (single `gtfs-builder` deploy + `gtfs-builder-staging`) |
| Relational metadata (users, orgs, projects, versions, publications, audit) | D1 |
| Rate-limit counters, KV cache | KV |
| Tiles + feed blobs | R2 (`gtfs-builder-tiles` for PMTiles; `gtfs-builder-feeds` / `gtfs-builder-feeds-staging` for working states, version snapshots, ZIPs, org logos) |
| Transactional email | Resend |
| Bot mitigation | Cloudflare Turnstile (signup) |
| Web analytics | Cloudflare Web Analytics (cookieless, zone-level) |

Frontend stack: React 18 + TypeScript, Vite, Zustand (Immer middleware) for state, Radix UI + Tailwind, Dexie for IndexedDB, JSZip + PapaParse for GTFS, `@turf/turf` for geometry, `@cloudflare/vitest-pool-workers` for the worker test harness.

### Design direction

- **Mood**: warm, approachable, slightly playful — a planning tool, not enterprise GIS.
- **Palette**: warm neutrals (cream, sand, soft brown) with vibrant accent colours for routes; coral primary; teal save indicator.
- **Typography**: rounded sans-serif headings, clean body text.
- **Map style**: Mapbox `light-v11` baseline, route shapes coloured per `route_color`, stop dots as white-with-dark-border.
- **Empty states**: illustrated and encouraging.
- **Layout**: left sidebar (sections + entity lists + property editors) · centre map · collapsible bottom panel (timetable, validation, versions, publish, embed, activity).

### Non-functional requirements

- **Performance**: 60 fps map interaction; feeds with 500+ stops, 50+ routes; import/export of 10 MB feeds within 10 s; autosave (local) within 1 s.
- **Usability**: no GTFS expertise required; warm visual design; desktop-primary, tablet-friendly; keyboard shortcuts for common map operations.
- **Data integrity**: referential integrity enforced (e.g., orphaned reference auto-fix surfaced in the export dialog); IDs auto-generated and overridable; IndexedDB persistence keeps anonymous editor work safe across crashes; explicit Save button for server-backed feeds with `beforeunload` guard on unsaved changes.
- **Accessibility**: WCAG 2.1 AA target for non-map UI; embed pages audited with axe-core; schedule tables use `<th scope="row">` / `<th scope="col">` for screen-reader compatibility.
- **Privacy**: PII limited to email, display name, IP + UA on active sessions, and feed contents; no third-party analytics; no marketing tracking.
- **Auditability**: every state-changing backend action writes an `audit_event` (login, publish, delete, member changes, admin impersonation, transfers, …).

### User workflow

The editor still guides users through this default path, though every section is reachable at any time:

```
1. Agency setup           →  Who operates this transit?
2. Calendars + holidays   →  When does service run?
3. Routes & shapes        →  What paths do vehicles take? (alignments first)
4. Stops                  →  Pick a route, place stops along it (snap-to-route default)
5. Fares                  →  How much does it cost to ride? (prompted if missing)
6. Timetables             →  What are the trip times?
7. Flex zones (optional)  →  Demand-responsive areas + booking rules
8. Analysis               →  Demand dots, demographic coverage, Title VI, cost
9. Validate & publish     →  Errors → fix; warnings → optional. Publish to a stable URL.
10. Embed                 →  Copy iframe snippets into the agency website.
```

---

## Companion documents

Read these when you need the deep version of a particular surface:

| Doc | Scope |
|---|---|
| [`WORKFLOW.md`](./WORKFLOW.md) | Day-to-day git + deployment cadence — branching, staging deploys, prod deploys, kill-switch flags, hotfixes. |
| [`BACKEND_REQUIREMENTS.md`](./BACKEND_REQUIREMENTS.md) | Reference spec — data model, API surface, security/privacy NFRs, decisions appendix. Anchors `BE-*` and `NF-*` numbers. |
| [`BACKEND_STATUS.md`](./BACKEND_STATUS.md) | "Where we are now" snapshot — env state, deploy gotchas, outstanding work. **Update this when you change deployed state.** |
| [`DEPLOY_BACKEND.md`](./DEPLOY_BACKEND.md) | First-time provisioning runbook (D1 / KV / R2 / Resend / Turnstile / smoke-test). |
| [`EMBEDS_REQUIREMENTS.md`](./EMBEDS_REQUIREMENTS.md) | Embeds reference — research findings, architecture, what's shipped, what's queued, open questions. Anchors `EM-*` numbers. |
| [`FLEX_ROADMAP.md`](./FLEX_ROADMAP.md) | GTFS-Flex coverage tracker — shipped / partial / open / deferred per spec field. |
| [`demand-dots-nationwide-plan.md`](./demand-dots-nationwide-plan.md) | Build pipeline + decisions for the demand-dot tile archive. |
| [`Title VI Transit Service Analysis - Calculation Procedures Memo.md`](./Title%20VI%20Transit%20Service%20Analysis%20-%20Calculation%20Procedures%20Memo.md) | Methodology for the Title VI equity analysis. |
| [`wireframes.html`](./wireframes.html) | Original UI sketches — historical reference. |

The previous `BACKEND_IMPLEMENTATION_PLAN.md` was retired in 2026-05 — Phases 1–5 are fully shipped, the live operational picture moved into `BACKEND_STATUS.md`, and the remaining outstanding items (NF-40a argon2id, transit.land submission, hard-mode quotas, Phase 7 embed sub-phases, etc.) are tracked in `BACKEND_STATUS.md` §"Outstanding work" or `EMBEDS_REQUIREMENTS.md` §3.
