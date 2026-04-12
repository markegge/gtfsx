# Transit Demand Dot Map — Nationwide Scaling Plan

**Status:** Planning. Not yet started.
**Owner:** mark@eateggs.com
**Decision log (2026-04-12):**
- Block-level resolution (not block group).
- Housing permit layer omitted — it was Bozeman-specific and doesn't scale.
- Display only — this data is NOT wired into the analysis features. Analysis remains on the existing ACS tract pipeline (`public/census/`).
- Hosting: Cloudflare R2.
- Refresh cadence: yearly manual regen.
- Rollout: **Montana proof of concept first**, then evaluate before nationwide.

---

## 1. Scope

A single vector-tile layer (PMTiles) covering all US states, showing dot-density for three classes:

- **High transit propensity** (renters ∪ zero-vehicle-HH members ∪ age 18–24, with overlap de-duplication) — blue/green
- **Other adults** — gray
- **Jobs** (LODES WAC, all sectors) — orange

Block-level resolution using TIGER TABBLOCK20 geometries, with ACS variables apportioned from block group → block by land area (same method `build_dots.py` already uses for Gallatin County).

**Out of scope:**
- New housing permits layer (Bozeman-specific; omitted permanently)
- Any use of these dots in analysis/coverage features — those stay on the existing tract-level pipeline
- Realtime or sub-yearly updates

---

## 2. Data sources

All public, all via HTTP. No accounts needed beyond a free Census API key.

| Source | URL / endpoint | Granularity | Update cadence |
|---|---|---|---|
| ACS 5-year — population/renter/vehicle/age | `api.census.gov/data/{year}/acs/acs5` | block group | annual (Dec release of 5-yr ending prior year) |
| LODES 8 WAC — jobs | `lehd.ces.census.gov/data/lodes/LODES8/{st}/wac/{st}_wac_S000_JT00_{year}.csv.gz` | block | annual, ~2-yr lag |
| TIGER/Line TABBLOCK20 | `www2.census.gov/geo/tiger/TIGER{year}/TABBLOCK20/tl_{year}_{state_fips}_tabblock20.zip` | block geometry | every 10 yrs + annual minor revisions |

Already handled by `demand-dots/build_dots.py`. For nationwide, we just need to drive it across all 3,143 counties (or by state file, which is more efficient — see §4).

---

## 3. Output architecture

**Input → pipeline → PMTiles on R2 → client**

```
┌───────────────────┐       ┌───────────────┐     ┌─────────────────┐
│ Census APIs +     │──────▶│ build_dots.py │────▶│ dots_{st}.ldjson│
│ LODES + TIGER     │       │ (per state)   │     │ (line-delim)    │
└───────────────────┘       └───────────────┘     └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌─────────────────┐
                                                  │   tippecanoe    │
                                                  └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌─────────────────┐
                                                  │   us.pmtiles    │
                                                  │ (single file)   │
                                                  └────────┬────────┘
                                                           │ wrangler r2 object put
                                                           ▼
                                                  ┌─────────────────┐
                                                  │ R2: gtfs-builder│
                                                  │ -tiles bucket   │
                                                  └────────┬────────┘
                                                           │ R2 binding (TILES)
                                                           ▼
                                                  ┌─────────────────┐
                                                  │ gtfs-builder    │
                                                  │ Worker          │
                                                  │ (worker/index.ts│
                                                  │  reads PMTiles  │
                                                  │  via Range)     │
                                                  └────────┬────────┘
                                                           │ /_demand-tiles/{archive}/{z}/{x}/{y}.pbf
                                                           ▼
                                                  ┌─────────────────┐
                                                  │  DemandDotsLayer│
                                                  │ (vector source, │
                                                  │  URL template)  │
                                                  └─────────────────┘
```

**Why the Worker step exists (and isn't optional):**
Mapbox GL JS 3.x does NOT support MapLibre's `addProtocol` API, so the
pmtiles npm package can't plug itself into Mapbox sources directly. The
first POC attempt failed with `TypeError: addProtocol is not a function`
in production. The Worker bridges that gap: it reads the PMTiles file
from R2 via Range requests (how PMTiles was designed to be consumed) and
emits individual `.pbf` tiles for Mapbox's standard vector source. This
is only ~40 lines of code and runs at the edge on the same domain as
the SPA, so there are no CORS concerns and cache-hit tiles never touch
the Worker at all.

**Why PMTiles on R2, not exploded tile directories:**
- Single-file upload beats uploading 90k–10M individual tiles (Montana
  exploded is 91k tiles; nationwide would be millions)
- R2 class-A write cost for bulk tile uploads adds up quickly
- Regens become a single `wrangler r2 object put` instead of an rclone
  sync operation

---

## 4. Pipeline changes to `build_dots.py`

Current state: accepts `--county FIPS`, emits one county.

Changes required (keep changes small — don't rewrite):

### 4a. Add `--state` flag
Loop over all counties in a state (the Census API will return all BGs for `state:30 county:*`, so we can fetch the whole state's ACS data in one call rather than looping county-by-county). Structure:

```python
if args.state:
    counties = list_counties_in_state(args.state)  # from Census API
    bg_data = fetch_block_group_data_state(args.state)      # single API call
    lodes_data = fetch_lodes_wac_state(args.state)          # whole-state CSV
    blocks_gdf = fetch_block_geometries_state(args.state)   # state TIGER file
    # apportion per county, emit one big file
```

### 4b. Output format: line-delimited GeoJSON
tippecanoe reads newline-delimited features much more efficiently than a single giant `FeatureCollection`. Add `--ldjson` output mode — write one feature per line, no surrounding array.

### 4c. Drop the housing block entirely
Remove `fetch_new_housing()` and all `multi_units` / `single_units` logic. Simpler pipeline, smaller output.

### 4d. Memory guard
At state scale, can't hold all features in memory. Stream: as each block's dots are generated, write them to the output file and release. `build_dot_geojson()` becomes a generator.

**Estimated build time, Montana:** 15–30 minutes after the cache is warm. First run (downloading TIGER + LODES + ACS): ~45 min, mostly network-bound.

---

## 5. Tile generation (tippecanoe)

Install: `brew install tippecanoe` (macOS).

Command for Montana POC:

```bash
tippecanoe \
  --output=tiles/mt.pmtiles \
  --layer=demand \
  --minimum-zoom=6 \
  --maximum-zoom=15 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --base-zoom=12 \
  --no-tile-compression \
  dots_mt.geojson.ldjson
```

Key flags:
- `--drop-densest-as-needed` — where a tile would exceed 500 KB, drop densest features. Avoids useless "all black" tiles at low zoom.
- `--extend-zooms-if-still-dropping` — automatically adds higher zoom levels if needed to preserve all features.
- `--base-zoom=12` — features visible from z12 up. At z6 we show only ~10% to keep the low-zoom experience clean.
- `--layer=demand` — the source-layer name we'll reference in the map style.
- Don't include housing units as a class since we removed them.

**Expected output size (Montana, ~68k blocks, ~300k dots at 5 people/dot):** 3–8 MB PMTiles.
**Extrapolated nationwide (~100M dots at 5 ppl/dot):** 1–3 GB PMTiles.

---

## 6. R2 bucket + Worker binding

One-time setup (already done as of the Montana POC):

```bash
# Create the bucket
npx wrangler r2 bucket create gtfs-builder-tiles

# Optional: attach a custom domain for direct-file access (e.g. debugging).
# This is NOT used by the map itself — the map hits /_demand-tiles/... on
# the main gtfs-builder Worker, which reads the PMTiles via the R2 binding.
npx wrangler r2 bucket domain add gtfs-builder-tiles \
  --domain tiles.gtfsbuilder.net \
  --zone-id <gtfsbuilder.net zone id> \
  --force
```

**Worker binding** (in `wrangler.jsonc`):
```jsonc
"r2_buckets": [
  { "binding": "TILES", "bucket_name": "gtfs-builder-tiles" }
]
```

**Uploads** are remote-scoped (`--remote`) and versioned by filename:
```bash
npx wrangler r2 object put gtfs-builder-tiles/mt-2026.pmtiles \
  --file=tiles/mt-2026.pmtiles \
  --remote \
  --content-type=application/vnd.pmtiles \
  --cache-control="public, max-age=31536000, immutable"
```

`--remote` is critical — without it, wrangler writes to local simulated storage.

**CORS** on the R2 bucket matters only if/when you expose the bucket via
its custom domain and let the browser fetch directly. Since the map goes
through the main Worker (same origin as the SPA), CORS isn't in play for
the production path. The bucket still has a CORS rule (`tiles/cors.json`
in this repo) for direct-file debugging.

---

## 7. The tile-serving Worker (`worker/index.ts`)

~40 lines. Reads the PMTiles archive from R2 via Range requests (using
the pmtiles library's `Source` interface) and serves each tile as a
standalone response. Path shape: `/_demand-tiles/{archive}/{z}/{x}/{y}.pbf`.

The archive name is a URL segment so multiple archives can coexist —
when the nationwide build ships, switching to `us-2026` is a client-side
string change, and the MT POC file can hang around for comparison.

Per-request flow:
1. Regex-match the URL. If it doesn't match, forward to `env.ASSETS.fetch`
   (the static-assets binding) so the SPA fallback still works.
2. Cache the `PMTiles` instance per-archive in a module-level `Map` so
   the header isn't re-read on every request (still read fresh per
   Worker isolate, but isolates are long-lived).
3. `pmtiles.getZxy(z, x, y)` → byte range pull from R2 → `.pbf` body.
4. Respond with `Content-Type: application/x-protobuf` and a year-long
   `Cache-Control` so Cloudflare's edge cache fronts most requests.
5. Missing tiles return `204 No Content` with a shorter cache. Mapbox
   GL handles 204 by treating the tile as empty.

**Build config:** the Worker needs Cloudflare types (`R2Bucket`, `Fetcher`)
that the React app shouldn't pull in. `tsconfig.worker.json` handles
this — the Worker's tsconfig has `"types": ["@cloudflare/workers-types"]`
and includes only `worker/**/*`. The React tsconfig excludes `worker/`.

---

## 8. Client integration

`src/components/map/DemandDotsLayer.tsx` is a plain Mapbox vector source
with a URL template. No client-side pmtiles library, no protocol
registration.

```tsx
const ARCHIVE = 'mt-2026';
const TILE_URL = `${window.location.origin}/_demand-tiles/${ARCHIVE}/{z}/{x}/{y}.pbf`;

<Source id="demand-dots" type="vector" tiles={[TILE_URL]} minzoom={6} maxzoom={15}>
  <Layer id="demand-dots" type="circle" source-layer="demand" paint={...} />
</Source>
```

Yearly regen: update the `ARCHIVE` constant to the new filename, commit.
No other client changes required.

### Legacy cleanup (already done)
`public/data/demand_dots.geojson` has been deleted from the repo.

---

## 8. Montana proof-of-concept runbook

End-to-end, start to finish, before touching nationwide:

```bash
# 1. Build dots for Montana
cd demand-dots
uv run python build_dots.py --state MT --output ../tiles/dots_mt.geojson.ldjson --ldjson --dots-per-person 5 --dots-per-job 5

# 2. Build PMTiles
cd ..
brew install tippecanoe  # first time only
tippecanoe \
  --output=tiles/mt-2026.pmtiles \
  --layer=demand \
  --minimum-zoom=6 --maximum-zoom=15 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping \
  --base-zoom=12 \
  tiles/dots_mt.geojson.ldjson

# 3. R2 bucket + Worker binding (first time only — already done for the
#    POC; listed here for completeness)
npx wrangler r2 bucket create gtfs-builder-tiles
# ensure wrangler.jsonc has:
#   "main": "worker/index.ts"
#   "assets": { "directory": "./dist", "binding": "ASSETS", "not_found_handling": "single-page-application" }
#   "r2_buckets": [{ "binding": "TILES", "bucket_name": "gtfs-builder-tiles" }]

# 4. Upload (use --remote; --local writes to simulated storage, not R2)
npx wrangler r2 object put gtfs-builder-tiles/mt-2026.pmtiles \
  --file=tiles/mt-2026.pmtiles \
  --remote \
  --content-type=application/vnd.pmtiles \
  --cache-control="public, max-age=31536000, immutable"

# 5. Update the ARCHIVE constant in src/components/map/DemandDotsLayer.tsx
#    from the previous version to 'mt-2026'.

# 6. npm run dev OR push and wait for CI. Pan to Montana,
#    toggle Map Layers → Transit Demand → Demand Dots, verify dots render
#    smoothly at zoom 6-15.

# 7. Check the network panel — expect:
#    - Per-view tile requests to /_demand-tiles/mt-2026/{z}/{x}/{y}.pbf
#    - Each tile 0–200 KB
#    - Subsequent views hit cf-cache-status: HIT
```

**POC acceptance criteria:**
- [ ] Dots render at all zoom levels 6–15 in Montana
- [ ] No visible tile seams or missing dots
- [ ] Tile endpoints return 200 with non-zero body for populated areas,
      204 for empty tiles
- [ ] Panning around Montana feels responsive
- [ ] Outside Montana there are no dots (expected, the file only covers MT)
- [ ] Network cost per page view is reasonable (check R2 ops + Worker
      requests in CF dashboard after a day of use)

---

## 9. Nationwide rollout (do AFTER POC accepted)

### Compute
- Run `build_dots.py --state XX` for all 50 + DC + PR. **Parallelizable** — each state is independent.
- Laptop estimate: 30 min/state × 52 / 4 parallel = ~6 hours total. Cache writes to `demand-dots/cache/` so reruns are free.
- Memory per state: 2–8 GB peak (CA is the big one — maybe do CA on a machine with 16 GB+ or split it).

### Tile build
```bash
cat tiles/dots_*.geojson.ldjson | tippecanoe \
  --output=tiles/us-2026.pmtiles \
  --layer=demand \
  --minimum-zoom=4 --maximum-zoom=15 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping \
  --base-zoom=12 \
  --read-parallel
```

Expected: ~1–3 GB. Single-threaded-ish for ~1–4 hours.

### Upload & cut over
```bash
npx wrangler r2 object put gtfs-builder-tiles/us-2026.pmtiles \
  --file=tiles/us-2026.pmtiles \
  --remote \
  --content-type=application/vnd.pmtiles \
  --cache-control="public, max-age=31536000, immutable"
```

Then change the `ARCHIVE` constant in `src/components/map/DemandDotsLayer.tsx`
from `mt-2026` to `us-2026`. Commit, push, CI deploys.

### Cost at nationwide scale
- R2 storage: ~3 GB × $0.015 = **~$0.05/mo**
- R2 Class B ops (reads): $0.36/M. Say 10k visits/mo × 30 tiles avg =
  300k ops/mo = **~$0.11/mo**. Each tile is one Range read of the PMTiles
  file, which the pmtiles client chunks efficiently.
- Worker requests: Workers Paid plan is $0.30/M after 10M included, so
  at 300k/mo: **$0**. At 10M/mo: **~$0**.
- Egress: **$0** (R2)
- **Rough total: under $1/month at 10k visits/mo**. At 100k: still under $5.

---

## 10. Yearly regen runbook

Run once per year, typically January (after Dec ACS 5-yr release). Full process, copy-paste ready:

```bash
# Prereqs
# - uv installed
# - tippecanoe installed (brew install tippecanoe)
# - Cloudflare API token with R2 Object Write permission set as CLOUDFLARE_API_TOKEN
# - CENSUS_API_KEY exported (get one at https://api.census.gov/data/key_signup.html)

cd /Users/clippy2/proj/gtfs-builder
YEAR=2027  # bump each year
ACS_YEAR=2025  # latest ACS 5-year release

# 1. Clear the cache to force fresh data
rm -rf demand-dots/cache/*

# 2. Bump the ACS year in build_dots.py
#    Edit demand-dots/build_dots.py → ACS_YEAR = {ACS_YEAR}

# 3. Bump TIGER year to match
#    Edit demand-dots/build_dots.py → TIGER URL has the year hard-coded; update it

# 4. Build all states (parallel)
mkdir -p tiles/ldjson
for st in AL AK AZ ... WY PR; do
  echo "=== $st ==="
  (cd demand-dots && uv run python build_dots.py --state $st \
    --output ../tiles/ldjson/dots_$st.ldjson --ldjson) &
  # Limit parallelism to avoid hammering Census API:
  while [ $(jobs -rp | wc -l) -ge 4 ]; do sleep 5; done
done
wait

# 5. Combine and build PMTiles
cat tiles/ldjson/*.ldjson | tippecanoe \
  --output=tiles/us-${YEAR}.pmtiles \
  --layer=demand \
  --minimum-zoom=4 --maximum-zoom=15 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping \
  --base-zoom=12 --read-parallel --force

# 6. Upload (--remote is required; --local writes to simulated storage)
npx wrangler r2 object put gtfs-builder-tiles/us-${YEAR}.pmtiles \
  --file=tiles/us-${YEAR}.pmtiles \
  --remote \
  --content-type=application/vnd.pmtiles \
  --cache-control="public, max-age=31536000, immutable"

# 7. Update client — change the ARCHIVE constant in
#    src/components/map/DemandDotsLayer.tsx to the new filename prefix.
#    Commit, push, CI auto-deploys.

# 8. Verify
#    - Load https://www.gtfsbuilder.net/, toggle demand layer on
#    - Spot check 3 metros (Bozeman, Seattle, Miami) — dots load, numbers plausible
#    - Check R2 bucket browser: confirm new file exists, old file can stay (cheap storage)

# 9. Cleanup (optional — only after a few weeks of the new file working)
#    npx wrangler r2 object delete gtfs-builder-tiles/us-$((YEAR-1)).pmtiles
```

### Year-over-year numbers to sanity check
- Total dots shouldn't swing more than ~5% year over year (population growth + ACS sampling)
- PMTiles file size should be stable within ~10%
- If anything is off by 20%+, re-run the pipeline for one state and compare to prior year before publishing

### Where things will break (documented so future-you knows)
- **LODES release timing:** LODES lags ACS by about a year. When you regen in Jan-YYYY, ACS release year is YYYY-2 and LODES is YYYY-3. This is OK — they don't need to match, just be labeled correctly in the UI if we ever surface the vintage.
- **TIGER decennial revisions:** Every 10 yrs (next 2030) the entire block system changes. Expect to rework `build_dots.py`'s block handling when that happens.
- **ACS variable IDs:** Census occasionally renumbers variables. The `B01001`/`B25003`/`B25044` tables we use have been stable since 2010 but validate the variable list still returns data.
- **LODES 8 vs 9:** Current code hardcodes LODES8. If LODES9 ships, update the `LODES_BASE` URL.

---

## 11. Open questions (for later, not blocking POC)

- Do we want state-level PMTiles separately in case the big one fails to load? (Probably not — PMTiles degrades gracefully; a partial file still serves tiles it has.)
- Should the UI show the vintage ("Based on ACS 2020–2024 + LODES 2023")? Yes eventually, but not for POC.
- Legend placement and copy — nationwide will need an explicit legend since most users won't intuit the classes. Out of scope for POC but add before nationwide cutover.
