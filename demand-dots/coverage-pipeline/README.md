# Coverage Pipeline — nationwide block-level FlatGeobuf

Builder for the GTFS·X **Coverage** layer: one POINT per populated or
job-bearing US census block, carrying EXACT integer demographics, two
PUMS-derived ridership-propensity / transit-need estimates, and LODES jobs,
written as a single nationwide **`us.fgb`** FlatGeobuf with a spatial (R-tree)
index that the GTFS·X worker serves for bbox queries.

**Not copyable on its own any more.** `build_coverage_blocks.py` imports
`../puma_union.py` — the same union estimator the demand-dot tiles are built
with, not a second copy of it (see *Method*, below) — plus
`../data/puma_corrections.csv` and the tract→PUMA crosswalk. **Copy the whole
`demand-dots/` directory, not just `coverage-pipeline/`**, and run from inside
it. Everything else is still third-party-only: `pip install -r
requirements.txt` covers every dependency `puma_union.py` needs (numpy,
pandas — already listed). The ACS-vintage probe is the one thing still
deliberately duplicated here rather than imported — see *Caveats*.

---

## What it produces

`us.fgb` — ~5 million POINT features (EPSG:4326), one per census block where
`pop>0` OR `jobs>0`, each at the block's official TIGER internal point
(`INTPTLAT20/INTPTLON20`). Per-block integer attributes:

```
geoid, pop, hh, workers, minority, race_pop, lowinc, pov_univ, zeroveh_hh,
occ_hh, senior, youth, carless, disability, prop_all, need_all, jobs
```

Two kinds of number live in that list, and the distinction is load-bearing —
never blur it, and never sum across it:

| kind | columns | what it is |
|---|---|---|
| **COUNT** | `pop, hh, workers, minority, race_pop, lowinc, pov_univ, zeroveh_hh, occ_hh, senior, youth, carless, disability, jobs` | a straight ACS (or LODES) table lookup. `carless` is PEOPLE — zero-vehicle households (`B25044`) × the PUMA's PUMS-measured zero-vehicle household size (~1.8 persons, **not** B25010's ~2.43 average, which over-counts this segment by ~35%). `disability` is civilian adults 18+ with a disability (`C21007` — see *Caveats*). `jobs` is the LODES **workplace** universe — never add it to a residence-based number. |
| **ESTIMATE** | `prop_all` (ridership propensity = carless ∪ low-income), `need_all` (transit need = carless ∪ low-income ∪ senior ∪ disability) | PUMS-derived statistical unions, de-duplicated — not headcounts. The categories overlap by construction (one person can be carless *and* low-income *and* a senior), so there is no honest total across any of these columns. |

The old `riders` column (renters ∪ carless ∪ adults 18–24, × an invented ×0.6
dedup factor) is **gone**. It was a different, abandoned model, and the true
dedup factor for that composite is 0.824, so it under-counted its own headline
by 27%.

### Method

- **The four segments** (`carless`, `lowinc`, `senior`, `disability`) are
  straight ACS block-group counts, one table each.
- **The two unions** (`prop_all`, `need_all`) are produced by **`../puma_union.py`**
  — imported, not reimplemented (see the note at the top). It derives them from
  an independence backbone × a PUMA-measured correction (from Census PUMS
  microdata), Fréchet-clamped, and it is the same estimator the demand-dot
  tiles are built with, so the Coverage panel and the dot map cannot end up
  disagreeing about what "likely rider" means.
- **Block population** comes from the BG demographics apportioned down to blocks
  (it is *not* raw POP20 — POP20 is only the apportionment weight).
- **ACS block-group demographics (5-year)** are fetched for the full variable set,
  the segments and unions derived per block group, then apportioned to each
  constituent block **dasymetrically**, weighted by 2020 decennial **POP20**
  (→ HOUSING20 → ALAND20 → even split), joined by the 12-char block-group GEOID
  prefix.
- **Largest-remainder apportionment** (Hamilton method) replaces independent
  per-column rounding. The per-block fraction is computed once and every
  attribute is split by it, but each column's block-group total is then
  conserved EXACTLY by handing its leftover integer units to the blocks with
  the largest fractional remainders. Independent rounding (`round(bg_total *
  weight)` per block) silently destroyed rare columns — a block group with 24
  zero-vehicle households spread over 100 blocks gave each block 0.24, and
  every single one rounded to zero. Measured on Montana against the ACS
  block-group truth: zero-vehicle households -10.25%, carless -5.70%,
  disability -0.58%, seniors -0.23%, low income -0.11%. The shipped `us.fgb`
  had been serving a zero-vehicle household count a tenth short of the ACS —
  into the Title VI panel's own equity numerator — until this fix. Population
  is apportioned FIRST and gates every residence column (each of those is then
  split only over the blocks that actually received people), so a rounding
  leftover can never be handed to a block that gets dropped at emit for having
  zero population.
- **`reconcile_blocks()`** re-runs the estimator's Fréchet/conditional clamp on
  the ROUNDED block counts, so the invariants (`carless, lowinc, senior,
  disability ≤ prop_all ≤ need_all ≤ pop`) hold exactly on every row of the
  `.fgb`. Largest-remainder conserves each column's own total exactly but not
  cross-column consistency (a block's leftover `carless` unit and leftover
  `prop_all` unit can land in different blocks) — this step re-clamps that.
- **Jobs** come from **LODES8 WAC** at the block level (no apportionment —
  already block-level). The LODES vintage is auto-probed downward from 2024 to
  the newest year that publishes a file (LODES lags ACS/TIGER ~2 years).
- **Geometry** is **TIGER/Line 2025 TABBLOCK20**.

Workplace-only blocks (LODES jobs but no apportioned residents) are emitted too,
at their own internal point with zeroed demographics.

---

## Setup

This folder is no longer standalone (see above), so set up ONE venv at the
`demand-dots/` level — shared with the rest of that pipeline, which is where
`puma_union.py` lives — rather than one per subfolder:

```bash
cd demand-dots
python3.12 -m venv .venv
.venv/bin/pip install -r coverage-pipeline/requirements.txt
```

Every command below is run from inside `coverage-pipeline/`, invoking that
shared venv as `../.venv/bin/python` (or `. ../.venv/bin/activate` once, then
just `python`).

`pyogrio` bundles GDAL inside its wheel, so **no system GDAL install is
required** to write/read FlatGeobuf. (The optional faster merge path uses the
`ogr2ogr` CLI if you happen to have GDAL installed — see *Merge backends*.)

### Census API key (REQUIRED)

The Census data API now **rejects keyless requests** with an HTML "Missing Key"
page (not JSON), so a key is required — get a free one instantly:

```bash
export CENSUS_API_KEY=xxxxxxxx   # https://api.census.gov/data/key_signup.html
```

The builder also looks for `CENSUS_API_KEY` / `VITE_CENSUS_API_KEY` in a `.env`
file in this folder or a parent (so it just works inside the gtfsx repo, which
already has one). On a standalone box you MUST export it — otherwise the build
fails fast with a clear message pointing here.

---

## Run

**Single state** (fast smoke test):

```bash
../.venv/bin/python build_coverage_blocks.py --state MT --out states/mt.fgb
```

**All of the US** (50 states + DC) → one merged `us.fgb`:

```bash
../.venv/bin/python build_us.py --out us.fgb --jobs 4
```

Useful flags:

```bash
../.venv/bin/python build_us.py --states "MT,WY" --out us-test.fgb   # subset (testing)
../.venv/bin/python build_us.py --out us.fgb --jobs 4                # build 4 states at once
../.venv/bin/python build_us.py --out us.fgb --territories           # also build Puerto Rico
../.venv/bin/python build_us.py --out us.fgb --force                 # rebuild every state
../.venv/bin/python build_us.py --out us.fgb --merge pyogrio         # force the pure-Python merge
```

The driver builds each state into `states/<st>.fgb` in its own subprocess
(per-state logs in `states/<st>.log`), is **resumable** (an existing
`states/<st>.fgb` is skipped — re-run after any interruption; `--force` to
rebuild), then **streams** every per-state file into `us.fgb` one state at a time
and verifies the result with a pyogrio bbox read. Final summary prints states
built, total block points, total pop/jobs, and output size.

### Expected runtime & disk

- **First run:** ~3–5 h, **download-dominated** (TIGER block zips + LODES + ACS
  for 51 states). Parallelize with `--jobs 4`–`8` to cut wall time substantially.
- **Re-runs (cache warm):** ~45–60 min — geometry/ACS/LODES are cached under
  `cache/`, so re-runs are CPU/IO-bound on apportionment + merge.
- **Disk:** `cache/` grows to **several GB** (per-state TIGER GeoPackages
  dominate); `us.fgb` is **a few hundred MB**.

### Merge backends (RAM note)

- **pyogrio (default, no system deps):** appends each state into `us.fgb` one
  state at a time — peak RAM ≈ the **largest single state** (CA, ~1 GB), not the
  whole nation.
- **ogr2ogr (`--merge ogr2ogr`, faster):** used automatically when the GDAL CLI
  is on `PATH`; falls back to pyogrio on any error.
- If you ever switch to an all-in-memory concat of all ~5M points, budget
  **~8–16 GB RAM**. The streaming default avoids that.

---

## Host it

Upload `us.fgb` to the GTFS·X tiles R2 bucket; the worker serves it at
`/_coverage/us.fgb` with HTTP Range support (FlatGeobuf bbox queries):

```bash
wrangler r2 object put gtfs-builder-tiles/coverage/us.fgb \
  --file us.fgb --content-type application/octet-stream --remote
```

---

## Caveats

1. **Households = ACS B25044 occupied households** (`hh` and `occ_hh`), not total
   housing units.
2. **ACS vintage is auto-probed** — the builder walks back from an impossible
   year until the Census API answers, so it always uses the newest published
   5-year release. The gtfsx repo runs the same probe in
   `demand-dots/acs_vintage.py`, which emits `src/generated/acsVintage.ts`; that
   is how the on-screen tract-centroid method
   (`src/services/demographics.ts`) stays on the same vintage as this layer.
3. **Connecticut is pinned one year back** (`ACS_YEAR_BY_STATE = {"09": 2021}`).
   CT swapped its 8 counties for 9 planning regions in ACS 2022+ (county codes
   110-190), but TIGER TABBLOCK20 still codes CT blocks with the old counties
   (001-015), so a current-vintage CT block-group GEOID prefix-matches nothing
   and the state would apportion to zero blocks. ACS 2021 still uses the old
   county codes and joins cleanly. CT is the only state affected.
4. **Negative Census sentinels** (`-666666666`, `-999999999`, …) for suppressed /
   unavailable values are **clamped to 0**.
5. **AK & PR have no LODES WAC** — those states build with population but `jobs=0`.
6. **Estimates vs. counts.** `prop_all`/`need_all` are PUMS-derived statistical
   unions, not headcounts — see *What it produces*. Never sum them with a
   segment or with each other; the categories overlap by construction.
7. **Disability must come from `C21007`, not `B18101`/`B18105`/`C18108`.** The
   B18xxx family and `C18108` are published at TRACT and above ONLY — ask the
   Census API for them at block group and it does not error, it silently
   returns rows of NULLs, which coerce to 0 and ship as a quietly-empty column.
   `C21007`'s civilian 18+ universe is also the one `puma_union`'s PUMS
   correction table is measured against, so the segment and the union describe
   the same concept.
8. **Cache busting.** The ACS block-group cache key embeds
   `puma_union.corrections_hash()`, so regenerating the PUMS correction tables
   (or changing the schema) busts it automatically — no manual cache-dir wipe
   needed. The old `acs<year>_cov_bg_state_<fips>.csv` files (pre-union
   schema) are dead; delete them.

---

## Deploy ordering: regenerate the layer before shipping a schema change

The client (`src/services/blockCoverage.ts`) is already wired nationwide —
`regionForState()` returns `'us'` for all 50 states + DC, and the layer is
fetched from `/_coverage/us.fgb` — so there is no separate client-integration
step left to do here. What's left is ordering the two halves of a release that
changes the schema, like this one:

**Regenerate and upload `us.fgb` before, or together with, shipping client
code that expects the new columns.** The layer is a ~1.6 GB artifact built by
a separate, hours-long, manually-triggered run (see *Run*) — it does not
redeploy itself when the client ships, and a stale layer has no error surface
of its own on the server side (a missing column just reads back as
`undefined`).

That failure mode is caught client-side, not silent: `blockCoverage.ts` checks
every loaded layer for the union-schema columns (`prop_all`, `need_all`,
`carless`, `disability`) and throws `CoverageLayerSchemaError` if they're
missing, instead of letting a missing value coerce to `0` and render a
confident, specific, wrong "Ridership propensity: 0". Callers already fall
back to the block-group estimate on any load failure, so a stale layer
degrades to "counts only, no estimate available" — safe, just less precise —
rather than lying. Regenerate promptly regardless: that guard is a safety net
for the deploy window, not a reason to leave prod on an old layer.
