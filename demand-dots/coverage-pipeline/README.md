# Coverage Pipeline — nationwide block-level FlatGeobuf

Builder for the GTFS·X **Coverage** layer: one POINT per populated or
job-bearing US census block, carrying EXACT integer demographics, two
PUMS-derived ridership-propensity / transit-need estimates, and LODES jobs,
written as a single nationwide FlatGeobuf with a spatial (R-tree) index that
the GTFS·X worker serves for bbox queries. Name the `--out` file after the R2
key you intend to upload it under (currently **`us-v2.fgb`** — see *Host it*),
not the historical `us.fgb`; that older name is a DIFFERENT, currently-live R2
object with the old schema, and this pipeline no longer produces that schema.

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

`us-v2.fgb` — ~5 million POINT features (EPSG:4326), one per census block where
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

**All of the US** (50 states + DC) → one merged `us-v2.fgb` (name it after the
target R2 key — see *Host it*):

```bash
../.venv/bin/python build_us.py --out us-v2.fgb --jobs 4
```

Useful flags:

```bash
../.venv/bin/python build_us.py --states "MT,WY" --out us-test.fgb   # subset (testing)
../.venv/bin/python build_us.py --out us-v2.fgb --jobs 4             # build 4 states at once
../.venv/bin/python build_us.py --out us-v2.fgb --territories        # also build Puerto Rico
../.venv/bin/python build_us.py --out us-v2.fgb --force              # rebuild every state
../.venv/bin/python build_us.py --out us-v2.fgb --merge pyogrio      # force the pure-Python merge
```

The driver builds each state into `states/<st>.fgb` in its own subprocess
(per-state logs in `states/<st>.log`), is **resumable** (an existing
`states/<st>.fgb` is skipped — re-run after any interruption; `--force` to
rebuild), then **streams** every per-state file into the output (e.g. `us-v2.fgb`) one state at a time
and verifies the result with a pyogrio bbox read. Final summary prints states
built, total block points, total pop/jobs, and output size.

### Expected runtime & disk

- **First run:** ~3–5 h, **download-dominated** (TIGER block zips + LODES + ACS
  for 51 states). Parallelize with `--jobs 4`–`8` to cut wall time substantially.
- **Re-runs (cache warm):** ~45–60 min — geometry/ACS/LODES are cached under
  `cache/`, so re-runs are CPU/IO-bound on apportionment + merge.
- **Disk:** `cache/` grows to **several GB** (per-state TIGER GeoPackages
  dominate); the merged output is **a few hundred MB**.

### Merge backends (RAM note)

- **pyogrio (default, no system deps):** appends each state into the output one
  state at a time — peak RAM ≈ the **largest single state** (CA, ~1 GB), not the
  whole nation.
- **ogr2ogr (`--merge ogr2ogr`, faster):** used automatically when the GDAL CLI
  is on `PATH`; falls back to pyogrio on any error.
- If you ever switch to an all-in-memory concat of all ~5M points, budget
  **~8–16 GB RAM**. The streaming default avoids that.

---

## Host it

Upload the build to the GTFS·X tiles R2 bucket under the **versioned key that
matches the client's `COVERAGE_REGION`** (`src/services/blockCoverage.ts`) —
currently `us-v2` — NOT the bare `coverage/us.fgb` key.

**Use `rclone`, not `wrangler`.** `us-v2.fgb` is ~1.7 GB and `wrangler r2 object
put` hard-fails above 300 MiB, so it has never been able to upload this file.

```bash
rclone copyto us-v2.fgb r2:gtfs-builder-tiles/coverage/us-v2.fgb \
  --s3-no-check-bucket --s3-chunk-size 64M --s3-upload-concurrency 4
rclone lsl r2:gtfs-builder-tiles/coverage/     # verify HERE, not by exit code
```

`--s3-no-check-bucket` is REQUIRED (without it: `403 AccessDenied` on
`CreateBucket`), and the bucket listing—not the exit status—is the source of
truth. The reasons, and the two ways this silently no-ops, are in
[ARCHITECTURE.md §5 deploy gotchas, "Large R2 uploads"](../../docs/ARCHITECTURE.md#large-r2-uploads);
read them before your first upload.

(Name the local `--out` file to match — `build_us.py --out us-v2.fgb` — so the
upload command above needs no translation.) The worker serves whatever key it's
asked for at `/_coverage/<region>.fgb` with HTTP Range support (FlatGeobuf bbox
queries) — see `worker/legacy/coverage.ts`.

**Do NOT overwrite `coverage/us.fgb`.** That object is prod's CURRENT,
already-deployed key: production is running an old-schema client that reads
`coverage/us.fgb` and expects the (retired) `riders` column. Overwrite it with
this schema and prod immediately reads `riders` as `undefined → 0` and renders
"High-propensity riders: 0" to real users — before prod's own client has even
redeployed. There is no server-side error surface for that failure; it just
looks like a real, wrong number. See the "Deploy ordering" section below for
the full safe sequence.

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

## Deploy ordering: version the R2 key, don't overwrite it in place

The client (`src/services/blockCoverage.ts`) is wired nationwide —
`regionForState()` returns `COVERAGE_REGION` (currently `us-v2`) for all 50
states + DC, and the layer is fetched from `/_coverage/${COVERAGE_REGION}.fgb`.
That constant, not a bare `'us'`, is what makes this schema change safe to
ship, because the schema break cuts BOTH ways:

- **new client + OLD layer** — defended. `blockCoverage.ts` checks every
  loaded layer for the union-schema columns (`prop_all`, `need_all`,
  `carless`, `disability`) and throws `CoverageLayerSchemaError` if they're
  missing, instead of letting a missing value coerce to `0` and render a
  confident, specific, wrong "Ridership propensity: 0". Callers already fall
  back to the block-group estimate on any load failure, so a stale layer
  degrades to "counts only, no estimate available" — safe, just less precise.
- **OLD client + NEW layer** — NOT defendable client-side, because the client
  that would need to defend itself is the one already running in production,
  built before this change existed. It reads `coverage/us.fgb` and expects
  `riders`; there is no code to ship into the past. The only fix is to never
  let that request land on the new schema: ship the new build under a
  **different** R2 key (`coverage/us-v2.fgb`) and leave `coverage/us.fgb`
  untouched. Prod's current client keeps reading its old object, unaffected,
  for as long as it takes to redeploy.

**Safe order for this (or any future) breaking schema change:**

1. Build the layer (see *Run*), naming the output after the NEW key
   (`--out us-v2.fgb`).
2. Upload it to the NEW key — `coverage/us-v2.fgb` — per *Host it*, above.
   **Never** `rclone copyto ... coverage/us.fgb` over the existing object
   while a client that depends on the old schema is still deployed.
3. Deploy the client change that points `COVERAGE_REGION` at the new key
   (already done in this repo — see `src/services/blockCoverage.ts`) and
   verify it in production against `/_coverage/us-v2.fgb`.
4. Only once prod is confirmed running on the new client may `coverage/us.fgb`
   be deleted from R2. Until then it costs a few hundred MB of R2 storage
   (negligible) to keep as a rollback target.

If a future schema change repeats this pattern, bump `COVERAGE_REGION` again
(`us-v2` → `us-v3` → …) and repeat the same four steps — never edit an
already-shipped key in place.
