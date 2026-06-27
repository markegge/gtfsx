# Coverage Pipeline — nationwide block-level FlatGeobuf

Self-contained builder for the GTFS·X **Coverage** layer: one POINT per
populated or job-bearing US census block, carrying EXACT integer demographics +
LODES jobs, written as a single nationwide **`us.fgb`** FlatGeobuf with a spatial
(R-tree) index that the GTFS·X worker serves for bbox queries.

Copy this folder anywhere, `pip install -r requirements.txt`, run one command,
get `us.fgb`. It imports **only third-party libraries** — nothing from the rest
of the gtfsx repo.

---

## What it produces

`us.fgb` — ~5 million POINT features (EPSG:4326), one per census block where
`pop>0` OR `jobs>0`, each at the block's official TIGER internal point
(`INTPTLAT20/INTPTLON20`). Per-block integer attributes:

```
geoid, pop, hh, workers, riders, minority, race_pop, lowinc, pov_univ,
zeroveh_hh, occ_hh, senior, youth, jobs
```

### Method

- **Block population** comes from the BG demographics apportioned down to blocks
  (it is *not* raw POP20 — POP20 is only the apportionment weight).
- **ACS block-group demographics (vintage 2022, ACS 5-year)** are fetched for the
  full variable set and apportioned to each constituent block **dasymetrically**,
  weighted by 2020 decennial **POP20** (→ HOUSING20 → ALAND20 → even split), joined
  by the 12-char block-group GEOID prefix. The same per-block fraction is applied
  to every attribute, so block sums conserve the block-group totals (a
  population-conservation check runs per state and fails the build if it drifts).
- **Jobs** come from **LODES8 WAC** at the block level (no apportionment —
  already block-level). The LODES vintage is auto-probed downward from 2024 to
  the newest year that publishes a file (LODES lags ACS/TIGER ~2 years).
- **Geometry** is **TIGER/Line 2025 TABBLOCK20**.

Workplace-only blocks (LODES jobs but no apportioned residents) are emitted too,
at their own internal point with zeroed demographics.

---

## Setup

```bash
python3.12 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

`pyogrio` bundles GDAL inside its wheel, so **no system GDAL install is
required** to write/read FlatGeobuf. (The optional faster merge path uses the
`ogr2ogr` CLI if you happen to have GDAL installed — see *Merge backends*.)

### Census API key (recommended)

Set a free Census key to avoid rate-limiting during the download-heavy first run:

```bash
export CENSUS_API_KEY=xxxxxxxx   # https://api.census.gov/data/key_signup.html
```

If unset, the builder also looks for `CENSUS_API_KEY` / `VITE_CENSUS_API_KEY` in
a `.env` file in this folder or a parent (so it just works inside the gtfsx
repo). Without any key it still runs, but slower and rate-limited.

---

## Run

**Single state** (fast smoke test):

```bash
python build_coverage_blocks.py --state MT --out states/mt.fgb
```

**All of the US** (50 states + DC) → one merged `us.fgb`:

```bash
python build_us.py --out us.fgb
```

Useful flags:

```bash
python build_us.py --states "MT,WY" --out us-test.fgb   # subset (testing)
python build_us.py --out us.fgb --jobs 4                # build 4 states at once
python build_us.py --out us.fgb --territories           # also build Puerto Rico
python build_us.py --out us.fgb --force                 # rebuild every state
python build_us.py --out us.fgb --merge pyogrio         # force the pure-Python merge
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
2. **ACS vintage is 2022** (5-year) — pinned to match the on-screen
   tract-centroid method (`src/services/demographics.ts`) so numbers stay
   consistent, just at finer geography.
3. **Negative Census sentinels** (`-666666666`, `-999999999`, …) for suppressed /
   unavailable values are **clamped to 0**.
4. **AK & PR have no LODES WAC** — those states build with population but `jobs=0`.

---

## Follow-up: wiring the client to the nationwide layer

The gtfsx client currently **gates block mode to Montana only**:
`regionForState()` in `src/services/blockCoverage.ts` returns `'mt'` for state
FIPS `30` and `null` for everything else, and the layer is fetched from
`/_coverage/<region>.fgb`. To go nationwide, point it at the merged file — e.g.
have `regionForState()` return `'us'` for any state (and host `us.fgb` at
`/_coverage/us.fgb`). **Do this as a separate integration step** — this pipeline
only builds the data; it does not change the client.
