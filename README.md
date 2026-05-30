# GTFS·X

A web-based editor for creating, editing, analyzing, and publishing [GTFS](https://gtfs.org/) (General Transit Feed Specification) transit feeds. Draw routes on a map, place stops, build timetables, run demographic and equity analysis, and publish a validated feed with rider-facing embeds — all in the browser.

**Live site:** [www.gtfsx.com](https://www.gtfsx.com)

![GTFS·X screenshot](docs/screenshot.png)

## Features

### Editor (anonymous, browser-only)

- **Agency & Feed Info** — set up the operating agency and feed publisher.
- **Calendars** — service patterns (weekdays / weekends / custom day grids), exception dates, bulk-add US federal holidays, visual month preview.
- **Routes** — color picker, GTFS route type, multiple shape variants per route. Polyline drawing with vertex add/move/remove, snap-to-road via the Mapbox Map Matching API, freehand drawing for off-road segments, simplify with preview, route visibility toggles. Route delete cascades trips / stop_times / fare rules / shapes, with an opt-out for orphaned stops.
- **Stops** — place along the active route (snap-to-route or freehand), curbside offset based on direction of travel, drag-and-drop reorder, multi-route stop sharing with near-duplicate detection, bulk CSV import.
- **Trips & Timetables** — spreadsheet-style grid (rows = trips, columns = stops, cells = times). Auto-interpolate intermediate stop times from shape distances. Duplicate a trip with a configurable time offset. Bidirectional editing — the timetable reflects on the map and vice versa.
- **Fares** — fare attributes, fare rules (flat or zone-based), multiple fare types. Empty-fare warning banner.
- **GTFS-Flex** — `locations.geojson` polygon zones with on-map editing handles, `booking_rules.txt`, extended `stop_times` with pickup/drop-off windows, location groups. Round-trip preserved.
- **Validation** — real-time validator surfaces errors (block export) and warnings (exportable but flagged), click-to-navigate to the offending entity, auto-fix path in the export dialog.
- **Import / Export** — upload an existing GTFS ZIP, export a validated ZIP. Round-trips every supported file with `shape_dist_traveled` auto-calculated and `feed_info.txt` always emitted.

### Analysis & route development

- **Demand-dot map** — nationwide vector-tile layer of high-transit-propensity population, other adults, and jobs. Block-resolution dot density apportioned from ACS + LODES.
- **Demographic coverage** — for each stop, how many people / households / workers live within a configurable buffer. Uses ACS block-group totals apportioned via circle-circle overlap. Live Census API for variable lookups.
- **Title VI equity analysis** — apportions daily trips per stop to nearby block groups, classifies block groups by regional minority share, reports the trip-ratio between minority and non-minority groups. Methodology in [`docs/Title VI Transit Service Analysis - Calculation Procedures Memo.md`](./docs/Title%20VI%20Transit%20Service%20Analysis%20-%20Calculation%20Procedures%20Memo.md).
- **Cost estimation** — per-route operating costs from timetable structure (revenue hours, peak vehicles, weekly + annual cost) with configurable cost-per-hour and deadhead factor.

### Two-rail editor layout

- **Left rail** — navigation only. Continuously resizable from 40 to 260 px via a drag handle on the right edge; renders icon-only / icons-with-labels / full rows depending on width. Responsive default per viewport: 40 (phone) / 96 (tablet) / 260 (large desktop).
- **Right rail** — configuration panels (Agency, Calendars, Routes, Stops, Fares, Flex Zones, Costs, Coverage, Title VI). 460 px wide, opens on section selection, collapses to a thin reopen strip when shape-editing the map. `Cmd/Ctrl + /` toggles it.
- **Route detail** is master-detail with a breadcrumb, swatch + title row, Duplicate / Delete actions, and Details / Stops / Trips / Frequencies tabs. Each tab focuses the map appropriately.
- **Bottom panel** holds the timetable, per-stop departures, service summary, validation, and (when signed in) versions / share & publish / embed snippets / activity audit.

### Account, organizations, publication (backend tier)

- Email + password signup with verification, magic-link login, password reset, Turnstile gate on signup.
- Organizations with `owner` / `admin` / `editor` / `viewer` roles, invitations, ownership transfer, per-org logo + brand color.
- Workspaces: personal feeds vs. org feeds, switcher in the top bar, cross-workspace transfer.
- Canonical publication to `feeds.gtfsx.com/<slug>/gtfs.zip` with ETag / `Last-Modified` / 304 support, validation gate, atomic R2→D1 pointer flip.
- Draft links with revocable 192-bit tokens, `X-Robots-Tag: noindex`.
- Catalog submissions to the Mobility Database (live API).
- Rider-facing embed surfaces (server-rendered HTML on the FEEDS origin):
  - **Mini-site landing** at `feeds.*/<slug>/`
  - **Per-route** schedule + map at `/embed/route/<route_id>`
  - **Per-stop** "departures today" at `/embed/stop/<stop_id>`
  - **System map** at `/embed/system-map`
  - Today's-service banner, feed-expiry warning, per-project brand color, per-org logo. Mobile-responsive. Open Graph / Twitter cards.
- Admin console at `/admin` for staff users (dashboard counters, paginated users / orgs, audit-log viewer with CSV export).

**Status:** Backend is **live on production** at [www.gtfsx.com](https://www.gtfsx.com) (re-enabled 2026-05-15 alongside live billing). Auth, projects, snapshots, draft links, publication, embeds, and Stripe checkout all available. Anonymous IndexedDB editing also still works for users who don't sign in.

## Tech stack

- **React 18** + **TypeScript** + **Vite**
- **Mapbox GL JS** via `react-map-gl` + `@mapbox/mapbox-gl-draw`
- **Zustand** with the `immer` middleware
- **Tailwind CSS v4** with a warm custom theme (cream / sand / coral / teal / gold)
- **Radix UI** popovers + dropdowns
- **TanStack Table** for the timetable grid
- **Turf.js** for geospatial math
- **JSZip** + **PapaParse** for GTFS import/export
- **Dexie.js** for IndexedDB persistence

**Backend:** Single Cloudflare Worker (Hono router) + D1 (metadata) + R2 (working states, version snapshots, GTFS zips, org logos, demand-dot PMTiles) + KV (rate-limit counters) + Resend (transactional email) + Cloudflare Turnstile (signup bot mitigation).

## Getting started

### Prerequisites

- Node.js 18+
- A [Mapbox](https://account.mapbox.com/) public access token (`pk.*`)

### Local development

```bash
git clone https://github.com/markegge/gtfs-studio.git
cd gtfs-studio
npm install
cp .env.example .env
# Edit .env: add VITE_MAPBOX_TOKEN
# Optionally also: VITE_BACKEND_ENABLED=true, VITE_TURNSTILE_SITE_KEY=...

# Editor only:
npm run dev                   # http://localhost:5173

# With backend (in a second terminal):
npx wrangler dev --port 8787 --local
```

`.env` carries `VITE_*` flags. `.dev.vars` carries `RESEND_API_KEY` and overridden `APP_ORIGIN` / `FEEDS_ORIGIN`. Both are gitignored.

### Tests

```bash
# Editor integration tests (round-trip a real Pittsburgh PRT feed through every entity type)
npx tsx run-tests.ts

# Worker integration tests
npx vitest run --fileParallelism=false

# Typecheck
npx tsc -p tsconfig.app.json --noEmit       # frontend
npx tsc -p tsconfig.worker.json --noEmit    # worker
```

`--fileParallelism=false` is required for worker tests because of a workerd WebSocket-disconnect quirk under parallel runs.

## Deployment

- **Production:** `gtfsx.com` / `www.gtfsx.com` / `feeds.gtfsx.com` — auto-deployed by **Cloudflare Workers Builds** on every push to `main` (no separate promotion step).
- **Staging:** `staging.gtfsx.com` + `staging-feeds.gtfsx.com` — parked, manual rehearsal env. Deploy via `npx wrangler deploy --env staging`.

Full day-to-day cadence, the first-time Cloudflare provisioning runbook (D1, KV, R2, Resend, Turnstile), and the live operational state (kill-switch positions, deploy gotchas) all live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (§5 live state, §6 provisioning, §7 workflow).

## Data sources

- **Map tiles & snap-to-road:** [Mapbox](https://www.mapbox.com/)
- **Demographics (ACS):** US Census Bureau [American Community Survey 5-year](https://www.census.gov/data/developers/data-sets/acs-5year.html)
- **Tract centroids:** Census Bureau [CenPop2020](https://www.census.gov/geographies/reference-files/time-series/geo/centers-population.html), bundled per state in `public/census/`
- **Jobs (LODES WAC):** [LEHD Origin-Destination Employment Statistics](https://lehd.ces.census.gov/data/)
- **Demand-dot pipeline:** see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) Appendix A
- **Catalog distribution:** [Mobility Database](https://mobilitydata.org/) (live), transit.land (stubbed)

## Documentation

| Doc | Scope |
|---|---|
| [`REQUIREMENTS.md`](./docs/REQUIREMENTS.md) | Capability inventory across editor, analysis, accounts, billing, publication, and forum. Shipped / partial / planned / deferred. |
| [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | The single engineering reference — system architecture, data model, full API surface, security/privacy NFRs (`BE-*`/`NF-*` anchors), live environment state, git + deploy workflow, provisioning + operator runbooks, demand-dot regen + Google Ads OCI appendices. |
| [`brand-kit/`](./docs/brand-kit/) | Brand assets — logos, palette, fonts, guidelines. |

The 🔲 planned-feature backlog lives in **GitHub issues**. Superseded/historical specs are preserved under `docs/archive/` (gitignored; local reference only).

## Project structure

```
src/
├── components/
│   ├── layout/          # AppShell, TopBar, LeftRail (responsive nav rail),
│   │                    # RightRail (configuration panel host), BottomPanel,
│   │                    # AppBrand, UserMenu, FloatingHelp, WelcomeBanner
│   ├── map/             # MapView, RouteLayer, StopLayer, DrawControl, popups,
│   │                    # MapLayerControls, CoverageLayer, DemandDotsLayer
│   ├── agency/          # Agency + Feed Info editor
│   ├── calendar/        # Service-pattern editor with month preview
│   ├── routes/          # RouteList, RouteEditor, RouteDetailPanel (tabbed),
│   │                    # RouteStopsTab, RouteTripsTab, RouteFrequenciesTab,
│   │                    # RouteDeleteDialog (shared confirmation)
│   ├── stops/           # Route-scoped stops + bulk CSV import
│   ├── timetable/       # TimetableGrid, StopDepartures, ServiceSummary
│   ├── fares/           # Fare attributes + route rules editor
│   ├── flex/            # GTFS-Flex zone editor + booking rules
│   ├── costs/           # Cost estimation summary
│   ├── coverage/        # Demographic coverage analysis
│   ├── titlevi/         # Title VI equity analysis
│   ├── validation/      # Validation panel
│   ├── import-export/   # Import / export dialogs
│   ├── versions/        # Version history (backend)
│   ├── distribution/    # Publish + catalog submission (backend)
│   ├── embed/           # Embed snippet copier (backend)
│   ├── audit/           # Project activity log (backend)
│   ├── feeds/           # My Feeds page (backend)
│   ├── orgs/            # Org settings + invitations (backend)
│   ├── admin/           # Admin console (backend, staff-only)
│   ├── auth/            # Login / signup / magic-link / account / password reset
│   ├── help/            # Help dialog
│   └── ui/              # Shared (FormField, Badge, EmptyState, RailHeadings)
├── store/               # Zustand slices, one per entity type + ui slice
├── services/            # GTFS import/export, validation, snap-to-road,
│                        # coverage analysis, cost estimation, Title VI,
│                        # auth API, projects API, orgs API
├── db/                  # Dexie (IndexedDB) auto-save + server persistence
├── types/               # GTFS + UI TypeScript interfaces
└── utils/               # Time parsing, colors, constants, feature flags

worker/                  # Cloudflare Worker (Hono): auth, projects, orgs,
                         # admin, publication, embeds, email, util, cron
worker/migrations/       # D1 SQL migrations
```

## License

MIT
