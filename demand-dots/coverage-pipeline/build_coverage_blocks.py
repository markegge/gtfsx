"""
Build an EXACT census-block-level coverage layer for GTFS·X.

One POINT per populated / job-bearing census block, carrying EXACT integer
demographic attributes at the block's official internal point, so the GTFS·X
Coverage panel can tabulate precise population / jobs / equity counts inside a
transit walkshed (block centroid-in-polygon) instead of the coarse
tract-centroid disc apportionment.

WHAT THIS FILE DEPENDS ON (and the one thing that changed)
──────────────────────────────────────────────────────────
Third-party: geopandas, pandas, numpy, requests, shapely (via geopandas),
pyogrio (FlatGeobuf IO). Nothing else — the TIGER/LODES/ACS fetching, the
apportionment and the FlatGeobuf write are all inlined here.

ONE exception, and it is deliberate: the two UNION columns (`prop_all`,
`need_all`) are produced by `../puma_union.py`, the estimator the demand-dot
tiles are built with. It is IMPORTED, not copied.

The rest of this folder duplicates small helpers from the parent (the ACS vintage
probe, the state FIPS map) because those are inert lookups that resolve
dynamically against the same API and cannot drift. `puma_union` is NOT that: it
is a statistical model — an independence backbone, a PUMA-measured correction
table and a Fréchet clamp — and a hand-mirrored second copy of it is exactly how
the Coverage panel and the dot map end up quietly disagreeing about what "likely
rider" means. There is ONE definition of the estimator, in ../puma_union.py, and
both pipelines call it.

The cost is that this folder is no longer copyable ON ITS OWN: copy
`demand-dots/` (which carries puma_union.py + data/) and run this from inside it.
That is stated in the README. It is a smaller price than two models.

Pipeline:
  1. Fetch ACS 5-year block-group demographics and derive the per-BG metrics:
     population, occupied households, workers, the Title VI equity numerators /
     denominators, the four transit SEGMENTS (carless, low income, senior,
     disability — all straight ACS counts) and the two UNIONS (ridership
     propensity, transit need — PUMS-derived statistical estimates, via
     ../puma_union.py). The ACS vintage is auto-probed (newest published 5-year
     release), except Connecticut, which is pinned — see ACS_YEAR_BY_STATE.
  2. Fetch TIGER TABBLOCK20 block geometries WITH the official internal point
     (INTPTLAT20 / INTPTLON20) — the block centroid we tabulate against.
  3. Apportion every BG attribute down to its constituent blocks, weighted by
     block POP20 (2020 decennial) -> HOUSING20 -> ALAND20 -> even split. The
     per-block fraction is computed once and applied to every attribute
     (dasymetric, 12-char GEOID-prefix join), then puma_union.reconcile() runs
     AGAIN on the rounded block counts so the union invariants hold exactly on
     every row of the .fgb (see reconcile_blocks).
  4. Join LODES WAC block-level jobs by GEOID (no apportionment — already
     block-level; LODES vintage auto-probed downward from 2024).
  5. Write a FlatGeobuf (EPSG:4326, POINT at each block's internal point) with
     short snake_case attribute keys, emitting ONLY blocks where pop>0 OR jobs>0.

ESTIMATES vs COUNTS — the distinction the whole layer must preserve
──────────────────────────────────────────────────────────────────
    prop_all, need_all          ESTIMATE.  PUMS-derived statistical unions.
    carless, lowinc, senior,
    disability, minority, youth COUNT.     Straight ACS table lookups (people).
    hh, occ_hh, zeroveh_hh      COUNT.     HOUSEHOLDS, not people.
    jobs                        COUNT.     WORKPLACE universe (LODES). Never add
                                           it to a residence-based number.

The categories OVERLAP by construction — one person can be carless AND low-income
AND a senior. There is NO honest total. The frontend surfaces the estimate/count
split as badges; do not blur it here.

CLI:
    python build_coverage_blocks.py --state MT --out states/mt.fgb [--cache-dir ./cache]
"""

import argparse
import os
import sys
import tempfile
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import requests

# ─── The union estimator: imported, never re-implemented ──────────────────────
#
# ../puma_union.py owns the definition of `prop_all` / `need_all` — the same one
# the demand-dot tiles are built from. Importing it (rather than copying it) is
# what guarantees the dot map and the Coverage panel cannot disagree about the
# number. It needs ../data/puma_corrections.csv and
# ../data/2020_Census_Tract_to_2020_PUMA.txt, which it resolves relative to
# itself.
_PARENT = Path(__file__).resolve().parent.parent
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))
try:
    import puma_union  # noqa: E402  (path shim must run first)
except ImportError as exc:  # pragma: no cover - import-time guard
    raise ImportError(
        f"Could not import the union estimator from {_PARENT / 'puma_union.py'}.\n"
        "This pipeline lives inside demand-dots/ and imports its parent's "
        "puma_union.py (plus data/puma_corrections.csv and the PUMA crosswalk) "
        "rather than keeping a second copy of the model. Copy the whole "
        "demand-dots/ directory, not just coverage-pipeline/."
    ) from exc

# ─── Vintages / endpoints ─────────────────────────────────────────────────────

CENSUS_API_BASE = "https://api.census.gov/data"

# The ACS vintage is NOT hardcoded: we probe the Census API downward from a year
# that cannot exist yet and take the newest release that answers. The same probe
# runs in the repo's demand-dots/acs_vintage.py, which additionally emits
# src/generated/acsVintage.ts so the GTFS·X frontend reads the identical year.
#
# This probe is DELIBERATELY DUPLICATED here rather than imported: this folder's
# contract (see README) is that it can be copied to a fresh workstation and run
# with nothing from the gtfsx repo but `pip install -r requirements.txt`. The two
# copies cannot drift in practice — both resolve dynamically against the same
# API, so they always land on the same year. demand-dots/acs_vintage.py remains
# the single authoritative emitter of the frontend constant.
ACS_PROBE_START = 2026
ACS_PROBE_FLOOR = 2019

# Connecticut (FIPS 09) replaced its 8 counties with 9 "planning regions" as
# county-equivalents starting with the ACS 2022 5-yr release (county codes
# 110-190). But the 2020 census BLOCKS in TIGER/Line still carry the OLD county
# codes (001-015), so a current-vintage CT block-group GEOID can't prefix-match
# the blocks → 0 apportioned blocks. Pin CT to the ACS 2021 5-yr (old counties),
# which prefix-matches the TIGER blocks. One year older for CT ONLY; every other
# state uses the probed year. (CT is the only state that did this.)
ACS_YEAR_BY_STATE = {"09": 2021}

_LATEST_ACS_YEAR: int | None = None


def resolve_latest_acs_year() -> int:
    """Newest ACS 5-year vintage the Census API actually serves. An unpublished
    year 404s; the first year that answers wins. Memoized for the process."""
    global _LATEST_ACS_YEAR
    if _LATEST_ACS_YEAR is not None:
        return _LATEST_ACS_YEAR

    params = {"get": "NAME", "for": "state:30"}  # cheapest possible query
    key = _census_key()
    if key:
        params["key"] = key
    for year in range(ACS_PROBE_START, ACS_PROBE_FLOOR - 1, -1):
        try:
            resp = requests.get(f"{CENSUS_API_BASE}/{year}/acs/acs5", params=params, timeout=30)
        except requests.RequestException:
            continue
        if resp.status_code == 200:
            _LATEST_ACS_YEAR = year
            return year
    raise RuntimeError(
        f"No ACS 5-year vintage responded between {ACS_PROBE_FLOOR} and {ACS_PROBE_START}. "
        "The Census API may be down, or CENSUS_API_KEY may be missing/invalid."
    )


def _acs_year(state_fips: str) -> int:
    """ACS vintage for a state: the newest published release, unless pinned."""
    pinned = ACS_YEAR_BY_STATE.get(state_fips)
    return pinned if pinned is not None else resolve_latest_acs_year()


TIGER_YEAR = 2025
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
# LODES WAC: probe downward from this year until a file exists. LODES lags
# ACS/TIGER by ~2 years, so the actual data year used will usually be older.
LODES_PROBE_START = 2024


# ─── Cache directory (configurable via --cache-dir / set_cache_dir) ───────────

CACHE_DIR = Path("cache")


def set_cache_dir(path) -> None:
    """Point the on-disk cache at `path` (created on first write)."""
    global CACHE_DIR
    CACHE_DIR = Path(path)


def cache_path(name: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return CACHE_DIR / name


# ─── State FIPS / abbrev maps ─────────────────────────────────────────────────

FIPS_TO_ABBR = {
    "01": "al", "02": "ak", "04": "az", "05": "ar", "06": "ca",
    "08": "co", "09": "ct", "10": "de", "11": "dc", "12": "fl",
    "13": "ga", "15": "hi", "16": "id", "17": "il", "18": "in",
    "19": "ia", "20": "ks", "21": "ky", "22": "la", "23": "me",
    "24": "md", "25": "ma", "26": "mi", "27": "mn", "28": "ms",
    "29": "mo", "30": "mt", "31": "ne", "32": "nv", "33": "nh",
    "34": "nj", "35": "nm", "36": "ny", "37": "nc", "38": "nd",
    "39": "oh", "40": "ok", "41": "or", "42": "pa", "44": "ri",
    "45": "sc", "46": "sd", "47": "tn", "48": "tx", "49": "ut",
    "50": "vt", "51": "va", "53": "wa", "54": "wv", "55": "wi",
    "56": "wy", "72": "pr",
}
ABBR_TO_FIPS = {v: k for k, v in FIPS_TO_ABBR.items()}


def resolve_state(s: str) -> tuple[str, str]:
    """Accept a state FIPS ('30') or abbrev ('MT' or 'mt'), return (fips, abbr)."""
    s = s.strip().lower()
    if s in ABBR_TO_FIPS:
        return ABBR_TO_FIPS[s], s
    if s in FIPS_TO_ABBR:
        return s, FIPS_TO_ABBR[s]
    if len(s) == 2 and s.isdigit():
        return s, FIPS_TO_ABBR.get(s, s)
    raise ValueError(f"Could not resolve state: {s!r}")


# ─── Census API key ───────────────────────────────────────────────────────────

def _census_key() -> str:
    """Census now requires an API key. Prefer the CENSUS_API_KEY env var; else
    walk up from this script looking for a `.env` that defines CENSUS_API_KEY or
    VITE_CENSUS_API_KEY (lets it work both standalone and inside the gtfsx repo).
    Returns '' if none found — the build still runs but is rate-limited."""
    key = os.environ.get("CENSUS_API_KEY")
    if key:
        return key
    here = Path(__file__).resolve().parent
    for d in [here, *here.parents][:5]:
        env_path = d / ".env"
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            line = line.strip()
            for prefix in ("CENSUS_API_KEY=", "VITE_CENSUS_API_KEY="):
                if line.startswith(prefix):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


# ─── ACS variable set ─────────────────────────────────────────────────────────
#
# Every table here is available AT BLOCK GROUP. That is not a given, and the one
# that bites is disability:
#
#   C21007, NOT B18101 / B18105 / C18108. The B18xxx family and C18108 are
#   published at TRACT and above ONLY. Ask the API for them at block group and it
#   does NOT error — it returns rows of NULLs, which coerce to 0 and ship as a
#   silently empty column. C21007 ("Age by Veteran Status by Poverty Status by
#   Disability Status", civilian population 18+) IS block-group available, and its
#   universe is exactly the one puma_union's PUMS correction table is measured
#   against, so the union and the segment describe the same concept.

ACS_BASE_VARS = [
    "B01003_001E",  # total population
    "B25001_001E",  # housing units
    "B08301_001E",  # workers (means-of-transportation-to-work universe)
    "B03002_001E",  # race/ethnicity universe
    "B03002_003E",  # non-Hispanic White alone
]
ACS_LOW_INCOME_DENOM = "C17002_001E"
ACS_LOW_INCOME_NUM = [
    "C17002_002E", "C17002_003E", "C17002_004E",
    "C17002_005E", "C17002_006E", "C17002_007E",
]
ACS_HOUSEHOLDS_DENOM = "B25044_001E"            # occupied households
ACS_NO_VEHICLE_NUM = ["B25044_003E", "B25044_010E"]
ACS_SENIOR_NUM = [
    "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E", "B01001_024E", "B01001_025E",  # male 65+
    "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E",  # female 65+
]
ACS_YOUTH_NUM = [
    "B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E",  # male <5,5-9,10-14,15-17
    "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E",  # female <5,5-9,10-14,15-17
]
ACS_DISABILITY_NUM = [
    # C21007 "with a disability" cells, across the 8 age x veteran x poverty
    # branches of the table. Summing the branches gives the whole civilian 18+
    # disabled population of the block group. Same cells as build_dots.py.
    "C21007_005E", "C21007_008E", "C21007_012E", "C21007_015E",
    "C21007_020E", "C21007_023E", "C21007_027E", "C21007_030E",
]

ACS_ALL_VARS = [
    *ACS_BASE_VARS,
    ACS_LOW_INCOME_DENOM, *ACS_LOW_INCOME_NUM,
    ACS_HOUSEHOLDS_DENOM, *ACS_NO_VEHICLE_NUM,
    *ACS_SENIOR_NUM,
    *ACS_YOUTH_NUM,
    *ACS_DISABILITY_NUM,
]

# ─── The block attribute schema ───────────────────────────────────────────────
#
# COUNT_KEYS  straight ACS counts (+ derived-but-exact ones). Tabulating them is
#             a sum; a walkshed total is a headcount of what the ACS published.
# UNION_KEYS  the two PUMS-derived statistical ESTIMATES. Not headcounts. The
#             frontend badges them differently, and it must keep doing so.
#
# `carless` is PEOPLE (zero-vehicle HOUSEHOLDS x the PUMA's measured zero-vehicle
# household size, ~1.8 — NOT the ~2.43 average household size, which over-counted
# by ~35%). `zeroveh_hh` is the raw HOUSEHOLD count and is kept alongside it: the
# Title VI panel's denominator is occupied households, not people.
#
# The old `riders` column (renters u carless u adults 18-24, x an invented 0.6)
# is GONE. It was a different, abandoned model — the true dedup factor for that
# composite is 0.824, so it under-counted its own headline by 27% — and shipping
# it beside prop_all would have put two contradictory answers to the same question
# in one file. Nothing reads it any more (blockCoverage.ts / walkshedProfile.ts /
# CoveragePanel all moved to prop_all + need_all).
COUNT_KEYS = [
    "pop", "hh", "workers",
    "minority", "race_pop", "lowinc", "pov_univ",
    "zeroveh_hh", "occ_hh", "senior", "youth",
    "carless", "disability",
]
UNION_KEYS = ["prop_all", "need_all"]

# The integer attributes apportioned to blocks, in .fgb column order.
ATTR_KEYS = [*COUNT_KEYS, *UNION_KEYS]

# The subset puma_union.reconcile() constrains. Its keys are the estimator's own
# names, so they are mapped to our column names once, here, rather than at three
# call sites.
RECONCILE_TO_COLUMN = {
    "total_pop": "pop",
    "carless": "carless",
    "low_income": "lowinc",
    "senior": "senior",
    "disability": "disability",
    "prop_all": "prop_all",
    "need_all": "need_all",
}


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    """Numeric column, Census negative sentinels (< 0) coerced to 0. Missing
    column -> all zeros."""
    if col not in df.columns:
        return pd.Series(0, index=df.index, dtype=float)
    vals = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return vals.where(vals >= 0, 0)


def fetch_block_group_full_state(state_fips: str) -> pd.DataFrame:
    """Fetch the FULL ACS variable set for a state's block groups and derive every
    per-BG attribute: the counts, and the two PUMS-derived unions."""
    acs_year = _acs_year(state_fips)
    dataset = f"{CENSUS_API_BASE}/{acs_year}/acs/acs5"
    # The cache key carries the content hash of the PUMS tables the unions are
    # derived from (puma_union.corrections_hash), so regenerating those tables —
    # or bumping the schema — busts the cache instead of silently reusing a CSV
    # whose prop_all/need_all columns were computed from the old ones. A stale
    # cache here has no error surface at all: the columns are simply wrong.
    schema_key = puma_union.corrections_hash()
    cache_file = cache_path(f"acs{acs_year}_v{schema_key}_cov_bg_state_{state_fips}.csv")
    if cache_file.exists():
        print(f"  Using cached coverage ACS block-group data: {cache_file}")
        return pd.read_csv(cache_file, dtype={"GEOID": str})

    note = " (pinned: CT planning-region transition)" if state_fips in ACS_YEAR_BY_STATE else ""
    print(f"  Fetching ACS {acs_year} 5-yr block-group data ({len(ACS_ALL_VARS)} vars, state {state_fips}){note}...")
    params = {
        "get": ",".join(ACS_ALL_VARS),
        "for": "block group:*",
        # Wildcard COUNTY only — block-group queries reject `county:* tract:*`
        # together. The tract still comes back as a column in the response.
        # Mirrors the proven demand-dots build_dots.py.
        "in": f"state:{state_fips} county:*",
    }
    key = _census_key()
    if not key:
        raise RuntimeError(
            "CENSUS_API_KEY is required for the Census data API. Get a free key at "
            "https://api.census.gov/data/key_signup.html, then `export CENSUS_API_KEY=...` "
            "(or put CENSUS_API_KEY=... in a .env beside this script)."
        )
    params["key"] = key
    resp = requests.get(dataset, params=params)
    resp.raise_for_status()
    # A missing/invalid key or bad geography returns an HTML error page (200 OK,
    # text/html), not JSON. Surface that clearly instead of a deep JSONDecodeError.
    if "json" not in resp.headers.get("content-type", "").lower():
        first = " ".join(resp.text.split())[:200]
        raise RuntimeError(
            f"Census API returned non-JSON (check CENSUS_API_KEY and the variable list). Got: {first}"
        )
    data = resp.json()
    df = pd.DataFrame(data[1:], columns=data[0])
    df["GEOID"] = df["state"] + df["county"] + df["tract"] + df["block group"]

    population = _num(df, "B01003_001E")
    total_race = _num(df, "B03002_001E")
    nonhisp_white = _num(df, "B03002_003E")

    # ── The four SEGMENTS. Straight ACS counts, one table each. ───────────────
    #
    # carless is the one that needs a conversion: B25044 counts zero-vehicle
    # HOUSEHOLDS, not people. It is scaled by the PUMA's own MEASURED zero-vehicle
    # household size (~1.8 persons, from PUMS — see puma_union/
    # build_puma_corrections), not by B25010's average household size (~2.43): a
    # zero-vehicle household is much smaller than an average one, and using the
    # average over-counted this segment by ~35%.
    zero_veh_hh = sum((_num(df, c) for c in ACS_NO_VEHICLE_NUM), start=pd.Series(0.0, index=df.index))
    params = puma_union.puma_params(df["GEOID"])
    carless = zero_veh_hh * params["hh_size_carless"].to_numpy()

    lowinc = sum((_num(df, c) for c in ACS_LOW_INCOME_NUM), start=pd.Series(0.0, index=df.index))
    senior = sum((_num(df, c) for c in ACS_SENIOR_NUM), start=pd.Series(0.0, index=df.index))
    youth = sum((_num(df, c) for c in ACS_YOUTH_NUM), start=pd.Series(0.0, index=df.index))
    disability = sum((_num(df, c) for c in ACS_DISABILITY_NUM), start=pd.Series(0.0, index=df.index))

    # ── The two UNIONS. Estimated, not counted. ───────────────────────────────
    #
    # The ACS publishes MARGINALS at block group and no joint distribution below
    # PUMA, so "how many DISTINCT people are carless OR low-income" cannot be read
    # off a table. puma_union.estimate() answers it the same way the demand-dot
    # tiles do — independence backbone x a PUMS-measured PUMA correction, then
    # Fréchet-clamped — and reconcile() makes the invariants
    # (segment <= prop_all <= need_all <= pop) true BY CONSTRUCTION.
    #
    # The population handed to the estimator is B01003_001E, the same `pop` column
    # this layer displays. build_dots.py feeds it B01001_001E (the sex-by-age
    # universe). The two are the ACS's total population and agree to the person in
    # practice; using OUR pop is what guarantees `prop_all <= pop` holds against
    # the number the Coverage panel actually shows.
    cls = puma_union.estimate(
        population.to_numpy(),
        carless.to_numpy(), lowinc.to_numpy(),
        senior.to_numpy(), disability.to_numpy(),
        params["c_prop"].to_numpy(), params["c_need"].to_numpy(),
    )
    violations = puma_union.check_invariants(cls)
    if violations:
        raise AssertionError(
            "block-group invariants violated by the union estimator: " + "; ".join(violations))

    out = pd.DataFrame({
        "GEOID": df["GEOID"],
        "pop": population,
        # Households here = occupied households (B25044_001E), per the coverage
        # spec; also surfaced separately as occ_hh (the equity denominator).
        "hh": _num(df, ACS_HOUSEHOLDS_DENOM),
        "workers": _num(df, "B08301_001E"),
        "minority": np.maximum(0, total_race - nonhisp_white),
        "race_pop": total_race,
        "lowinc": lowinc,
        "pov_univ": _num(df, ACS_LOW_INCOME_DENOM),
        "zeroveh_hh": zero_veh_hh,
        "occ_hh": _num(df, ACS_HOUSEHOLDS_DENOM),
        "senior": senior,
        "youth": youth,
        # From reconcile(): already integer, already clamped, already consistent.
        "carless": cls["carless"],
        "disability": cls["disability"],
        "prop_all": cls["prop_all"],
        "need_all": cls["need_all"],
    })
    for k in ATTR_KEYS:
        out[k] = out[k].round().clip(lower=0).astype(int)
    out.to_csv(cache_file, index=False)
    print(f"  Cached coverage ACS data: {len(out)} block groups")
    return out


def fetch_lodes_wac_state(state_fips: str) -> pd.DataFrame:
    """Download LODES WAC for a whole state, probing for the newest available
    year. Returns block-level job counts (w_geocode, total_jobs). The cache
    filename embeds the detected year. AK / PR don't publish LODES WAC -> empty
    frame (population blocks still build)."""
    abbr = FIPS_TO_ABBR.get(state_fips, state_fips)
    existing = sorted(CACHE_DIR.glob(f"lodes_wac_state_{state_fips}_*.csv"),
                      reverse=True) if CACHE_DIR.exists() else []
    if existing:
        cache_file = existing[0]
        year = cache_file.stem.rsplit("_", 1)[-1]
        print(f"  Using cached LODES {year}: {cache_file}")
        return pd.read_csv(cache_file, dtype={"w_geocode": str})

    for year in range(LODES_PROBE_START, 2017, -1):
        url = f"{LODES_BASE}/{abbr}/wac/{abbr}_wac_S000_JT00_{year}.csv.gz"
        resp = requests.get(url, stream=True)
        if resp.status_code == 200:
            print(f"  Downloaded LODES WAC {abbr.upper()} {year}")
            break
    else:
        print(f"  No LODES WAC for {abbr.upper()} — continuing with no jobs data")
        empty = pd.DataFrame({"w_geocode": pd.Series(dtype=str),
                              "total_jobs": pd.Series(dtype=int)})
        cache_file = cache_path(f"lodes_wac_state_{state_fips}_EMPTY.csv")
        empty.to_csv(cache_file, index=False)
        return empty

    tmp = tempfile.NamedTemporaryFile(suffix=".csv.gz", delete=False)
    tmp.write(resp.content)
    tmp.close()
    df = pd.read_csv(tmp.name, dtype={"w_geocode": str})
    os.unlink(tmp.name)
    result = df[["w_geocode", "C000"]].rename(columns={"C000": "total_jobs"})
    cache_file = cache_path(f"lodes_wac_state_{state_fips}_{year}.csv")
    result.to_csv(cache_file, index=False)
    print(f"  Cached LODES {year}: {len(result)} blocks, {result['total_jobs'].sum():,} jobs")
    return result


def fetch_block_geometries_cov_state(state_fips: str) -> gpd.GeoDataFrame:
    """Download TIGER TABBLOCK20 for a state, keeping POP20 / HOUSING20 / ALAND20
    for apportionment weighting PLUS the official internal point (INTPTLAT20 /
    INTPTLON20) — the block centroid we tabulate against."""
    cache_file = cache_path(f"blocks_cov_state_{state_fips}_tiger{TIGER_YEAR}.gpkg")
    if cache_file.exists():
        print(f"  Using cached coverage block geometries: {cache_file}")
        return gpd.read_file(cache_file)
    print(f"  Downloading TIGER/Line {TIGER_YEAR} state block geometries ({state_fips})...")
    url = (
        f"https://www2.census.gov/geo/tiger/TIGER{TIGER_YEAR}/TABBLOCK20/"
        f"tl_{TIGER_YEAR}_{state_fips}_tabblock20.zip"
    )
    resp = requests.get(url)
    resp.raise_for_status()
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.write(resp.content)
    tmp.close()
    gdf = gpd.read_file(f"zip://{tmp.name}")
    os.unlink(tmp.name)
    gdf = gdf[gdf["STATEFP20"] == state_fips]
    keep = ["GEOID20", "POP20", "HOUSING20", "ALAND20", "INTPTLAT20", "INTPTLON20", "geometry"]
    gdf = gdf[keep].rename(columns={"GEOID20": "GEOID_BLOCK"})
    for col in ("POP20", "HOUSING20", "ALAND20"):
        gdf[col] = pd.to_numeric(gdf[col], errors="coerce").fillna(0)
    gdf.to_file(cache_file, driver="GPKG")
    print(f"  Cached coverage block geometries: {len(gdf)} blocks")
    return gdf


def build_bg_to_blocks_index(blocks_gdf: gpd.GeoDataFrame) -> dict[str, pd.DataFrame]:
    """Group blocks by their 12-char block group GEOID for fast apportionment."""
    b = blocks_gdf.copy()
    b["BG_GEOID"] = b["GEOID_BLOCK"].str[:12]
    return {bg: g for bg, g in b.groupby("BG_GEOID", sort=False)}


def _largest_remainder(total: int, weights: np.ndarray) -> np.ndarray:
    """Split an integer `total` across blocks by `weights` (which sum to 1),
    conserving it EXACTLY: floor everything, then hand the leftover units to the
    largest fractional remainders.

    THIS REPLACES INDEPENDENT PER-BLOCK ROUNDING, WHICH DESTROYED RARE COLUMNS.
    ──────────────────────────────────────────────────────────────────────────
    The old code did `round(bg_total * weight_i)` per block, independently. For a
    COMMON attribute that is roughly fine — the population of a block group is big
    enough that most blocks want ≥ 0.5 of a person and round up as often as down.

    For a RARE one it is a shredder. A block group with 24 zero-vehicle households
    spread over 100 blocks gives each block 0.24 of a household; every single one
    rounds to ZERO, and all 24 households simply cease to exist. The loss is
    systematic (never compensating), and it grows as the attribute gets rarer.

    Measured on Montana, against the ACS block-group truth the file is built from:

        zero-vehicle households   -10.25%     seniors 65+        -0.23%
        carless people             -5.70%     low income         -0.11%
        disability                 -0.58%     population         -0.01%

    The -5.70% is not a coincidence: build_dots.py hit this exact bug and its
    APPORTION_VERSION note records "lost 5.7% of Montana's carless population" —
    the same state, the same attribute, the same number. That pipeline fixed it and
    this one did not, so the shipped us.fgb has been serving a zero-vehicle
    household count a tenth short of the ACS — into the Title VI panel, whose
    zero-vehicle row is one of its four equity numerators.

    Largest-remainder (Hamilton) is the right tool HERE specifically because this
    is one quantity across many units: the fractional remainders vary from block to
    block, so the leftovers land in different places each time and nothing is
    starved systematically. (It is the WRONG tool for splitting one block's dot
    budget across 16 fixed-share cells — see build_dots._apportion_dots, which uses
    randomized apportionment for that opposite case. The two are not
    interchangeable, and the distinction is why each pipeline uses what it uses.)
    """
    if total <= 0:
        return np.zeros(len(weights), dtype=np.int64)
    exact = weights * float(total)
    base = np.floor(exact).astype(np.int64)
    leftover = int(total - base.sum())
    if leftover > 0:
        # Stable sort so a given block group always apportions identically.
        order = np.argsort(-(exact - base), kind="stable")
        base[order[:leftover]] += 1
    return base


def apportion_state(
    bg_data: pd.DataFrame,
    bg_index: dict[str, pd.DataFrame],
) -> dict[str, dict]:
    """Apportion every BG attribute to its blocks, weighted by POP20 (->HOUSING20
    ->ALAND20->even). The per-block fraction is computed once and applied to every
    attribute, each split by largest remainder so the block group's total is
    conserved EXACTLY (see _largest_remainder). Returns
    geoid -> {lon, lat, attrs...} for every block in a BG that has data.

    Conservation is per-column and per-block-group, so the statewide block sums
    come back to the ACS statewide totals to the person. What it does NOT give is
    cross-column consistency: the leftover unit of `carless` and the leftover unit
    of `prop_all` can land in different blocks, so a block can end up with
    carless = 12 and prop_all = 11 — a segment larger than the union containing it.
    reconcile_blocks() runs next and fixes exactly that.

    POPULATION IS APPORTIONED FIRST, AND IT GATES EVERYTHING ELSE.
    ─────────────────────────────────────────────────────────────
    Only blocks where `pop > 0` OR `jobs > 0` are written to the .fgb. If the other
    columns were apportioned over the same weights as population, largest remainder
    could hand the last low-income resident to a block that ended up with pop = 0 —
    and that block is then DROPPED, taking the person with it. That would quietly
    re-open the leak this function was just fixed to close, and it would put
    low-income residents in a block with no residents, which is nonsense on its own
    terms.

    So population is split first, and every residence-based column is then split
    over the weights RESTRICTED to the blocks that actually received people (and
    renormalized). Each column still conserves its block-group total exactly, and
    every unit now lands in a block that survives to the file.
    """
    blocks: dict[str, dict] = {}
    residence_keys = [k for k in ATTR_KEYS if k != "pop"]
    for _, row in bg_data.iterrows():
        bg_geoid = row["GEOID"]
        bg_blocks = bg_index.get(bg_geoid)
        if bg_blocks is None or len(bg_blocks) == 0:
            continue

        weights = None
        for col in ("POP20", "HOUSING20", "ALAND20"):
            if col in bg_blocks.columns:
                total = bg_blocks[col].sum()
                if total > 0:
                    weights = (bg_blocks[col].to_numpy() / total)
                    break
        if weights is None:
            n = len(bg_blocks)
            weights = np.full(n, 1.0 / n)

        split = {"pop": _largest_remainder(int(row["pop"]), weights)}

        # Restrict the residence columns to the blocks that got people. When the
        # block group has no population at all there is nowhere coherent to put
        # them, so fall back to the raw weights; such blocks carry no jobs either
        # and are dropped at emit, which is the right answer for an empty BG.
        peopled = split["pop"] > 0
        w_res = weights
        if peopled.any():
            masked = weights * peopled
            s = masked.sum()
            if s > 0:
                w_res = masked / s
        for k in residence_keys:
            split[k] = _largest_remainder(int(row[k]), w_res)

        geoids = bg_blocks["GEOID_BLOCK"].to_numpy()
        lons = bg_blocks["INTPTLON20"].to_numpy()
        lats = bg_blocks["INTPTLAT20"].to_numpy()
        for i in range(len(bg_blocks)):
            rec = {"lon": float(lons[i]), "lat": float(lats[i])}
            for k in ATTR_KEYS:
                rec[k] = int(split[k][i])
            blocks[geoids[i]] = rec
    return blocks


def reconcile_blocks(blocks: dict[str, dict]) -> tuple[dict[str, dict], int]:
    """Re-run puma_union.reconcile() on the ROUNDED block counts.

    Returns (blocks, n_rows_changed).

    WHY THIS EXISTS. The estimator's invariants
    (carless/lowinc/senior/disability <= prop_all <= need_all <= pop, plus both
    Fréchet bounds) hold exactly at BLOCK GROUP, and they hold exactly on the
    real-valued block split too, because a block's counts are its block group's
    counts times one scalar weight. What breaks them is ROUNDING: apportion_state
    rounds each column independently, so a block wanting carless = 11.6 and
    prop_all = 11.5 rounds to 12 and 11 — a segment bigger than the union it
    belongs to, off by one person, in a file nobody will ever eyeball.

    At walkshed scale those ±1s mostly cancel, which is exactly why this must not
    be left to average out: a ¼-mi walkshed around a rural stop can contain ONE
    block, and then the panel prints "Carless 12 / Likely riders 11" and the
    product has visibly contradicted itself.

    reconcile() is idempotent and is the estimator's own choke point, so calling
    it again on the integers is not a patch over the model — it is the same
    clamp, applied at the geography we ship. It moves counts by at most the
    rounding error that created the violation.
    """
    if not blocks:
        return blocks, 0

    geoids = list(blocks)
    cols = {
        name: np.array([blocks[g][col] for g in geoids], dtype=np.int64)
        for name, col in RECONCILE_TO_COLUMN.items()
    }
    fixed = puma_union.reconcile(
        cols["total_pop"], cols["carless"], cols["low_income"],
        cols["senior"], cols["disability"],
        cols["prop_all"], cols["need_all"],
    )

    changed = np.zeros(len(geoids), dtype=bool)
    for name, col in RECONCILE_TO_COLUMN.items():
        changed |= fixed[name] != cols[name]
    for i, g in enumerate(geoids):
        if not changed[i]:
            continue
        for name, col in RECONCILE_TO_COLUMN.items():
            blocks[g][col] = int(fixed[name][i])

    violations = puma_union.check_invariants(fixed)
    if violations:
        raise AssertionError(
            "block-level invariants violated after reconcile: " + "; ".join(violations))
    return blocks, int(changed.sum())


def build_state(state: str, out: str, cache_dir: str | None = None) -> dict:
    """Build the block-level coverage FlatGeobuf for one state. Returns a stats
    dict. Raises on a population-conservation failure."""
    if cache_dir is not None:
        set_cache_dir(cache_dir)

    state_fips, abbr = resolve_state(state)
    print(f"Building block-level coverage layer for {abbr.upper()} (FIPS {state_fips})")
    print(f"  ACS {_acs_year(state_fips)} / TIGER {TIGER_YEAR} / "
          f"LODES probe<= {LODES_PROBE_START} / cache {CACHE_DIR}")

    print("\n1. Fetching ACS block-group demographics (full var set)...")
    bg_data = fetch_block_group_full_state(state_fips)
    statewide_acs_pop = int(bg_data["pop"].sum())

    print("\n2. Fetching LODES block-level jobs...")
    lodes = fetch_lodes_wac_state(state_fips)
    block_jobs = {str(r["w_geocode"]): int(r["total_jobs"]) for _, r in lodes.iterrows()}

    print("\n3. Fetching block geometries (with internal points)...")
    blocks_gdf = fetch_block_geometries_cov_state(state_fips)

    print("\n4. Apportioning BG attributes to blocks (POP20-weighted)...")
    t0 = time.time()
    bg_index = build_bg_to_blocks_index(blocks_gdf)
    block_attrs = apportion_state(bg_data, bg_index)
    print(f"  Apportioned {len(block_attrs):,} blocks in {time.time()-t0:.1f}s")

    # Re-clamp the union invariants after the independent per-column rounding.
    block_attrs, n_fixed = reconcile_blocks(block_attrs)
    pct = 100.0 * n_fixed / max(1, len(block_attrs))
    print(f"  Reconciled union invariants at block level: "
          f"{n_fixed:,} of {len(block_attrs):,} blocks adjusted ({pct:.2f}%, rounding only)")

    # Conservation check (population): sum of block pop ≈ statewide ACS pop.
    apportioned_pop = sum(b["pop"] for b in block_attrs.values())
    drift = abs(apportioned_pop - statewide_acs_pop)
    tol = max(50, len(block_attrs) // 100)  # rounding slack (≤ ~1 person/block)
    print(f"  Conservation: apportioned pop {apportioned_pop:,} vs ACS pop "
          f"{statewide_acs_pop:,} (drift {drift:,}, tol {tol:,})")
    assert drift <= tol, f"Population conservation failed: drift {drift} > tol {tol}"

    print("\n5. Building point records (pop>0 OR jobs>0)...")
    rows = []
    geoms_lon = []
    geoms_lat = []
    job_only = 0
    for geoid, jobs in block_jobs.items():
        if geoid not in block_attrs and jobs > 0:
            job_only += 1
    for geoid, rec in block_attrs.items():
        jobs = block_jobs.get(geoid, 0)
        if rec["pop"] <= 0 and jobs <= 0:
            continue
        row = {"geoid": geoid}
        for k in ATTR_KEYS:
            row[k] = rec[k]
        row["jobs"] = jobs
        rows.append(row)
        geoms_lon.append(rec["lon"])
        geoms_lat.append(rec["lat"])

    # Blocks with jobs but no apportioned population (workplace-only blocks):
    # emit them too, using their own internal point from the geometry table.
    if job_only:
        pt_lookup = blocks_gdf.set_index("GEOID_BLOCK")
        for geoid, jobs in block_jobs.items():
            if jobs <= 0 or geoid in block_attrs:
                continue
            if geoid not in pt_lookup.index:
                continue
            r = pt_lookup.loc[geoid]
            row = {"geoid": geoid}
            for k in ATTR_KEYS:
                row[k] = 0
            row["jobs"] = jobs
            rows.append(row)
            geoms_lon.append(float(r["INTPTLON20"]))
            geoms_lat.append(float(r["INTPTLAT20"]))

    df = pd.DataFrame(rows)
    for k in [*ATTR_KEYS, "jobs"]:
        df[k] = df[k].astype("int64")
    gdf = gpd.GeoDataFrame(
        df,
        geometry=gpd.points_from_xy(geoms_lon, geoms_lat),
        crs="EPSG:4326",
    )

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()
    print(f"\n6. Writing FlatGeobuf → {out_path}")
    gdf.to_file(out_path, driver="FlatGeobuf")

    size_mb = out_path.stat().st_size / 1024 / 1024
    # Verify the spatial index / readability with a bbox filter readback.
    minx, miny, maxx, maxy = gdf.total_bounds
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    bbox_read = gpd.read_file(out_path, bbox=(cx - 0.25, cy - 0.25, cx + 0.25, cy + 0.25))

    stats = {
        "abbr": abbr.upper(),
        "fips": state_fips,
        "blocks": len(gdf),
        "job_only": job_only,
        "pop": int(gdf["pop"].sum()),
        "acs_pop": statewide_acs_pop,
        "hh": int(gdf["hh"].sum()),
        "workers": int(gdf["workers"].sum()),
        "carless": int(gdf["carless"].sum()),
        "lowinc": int(gdf["lowinc"].sum()),
        "senior": int(gdf["senior"].sum()),
        "disability": int(gdf["disability"].sum()),
        "prop_all": int(gdf["prop_all"].sum()),
        "need_all": int(gdf["need_all"].sum()),
        "blocks_reconciled": n_fixed,
        "jobs": int(gdf["jobs"].sum()),
        "size_mb": size_mb,
        "out": str(out_path),
        "bbox_readback": len(bbox_read),
    }

    print("\n── Summary ─────────────────────────────────────────────")
    print(f"  Blocks emitted:     {stats['blocks']:,}  ({job_only:,} job-only)")
    print(f"  File size:          {size_mb:.2f} MB  ({out_path})")
    print(f"  Total population:   {stats['pop']:,}  (ACS statewide {statewide_acs_pop:,})")
    print(f"  Total households:   {stats['hh']:,}")
    print(f"  Total workers:      {stats['workers']:,}")
    print(f"  Total jobs:         {stats['jobs']:,}   (WORKPLACE universe — never add to residents)")
    print("  ── Segments (ACS counts, people; they OVERLAP — do not sum) ──")
    print(f"    Carless:          {stats['carless']:,}")
    print(f"    Low income:       {stats['lowinc']:,}")
    print(f"    Senior 65+:       {stats['senior']:,}")
    print(f"    Disability:       {stats['disability']:,}")
    print("  ── Unions (PUMS-derived ESTIMATES, de-duplicated) ──")
    print(f"    Ridership propensity: {stats['prop_all']:,}"
          f"  ({100.0 * stats['prop_all'] / max(1, stats['pop']):.1f}% of residents)")
    print(f"    Transit need:         {stats['need_all']:,}"
          f"  ({100.0 * stats['need_all'] / max(1, stats['pop']):.1f}% of residents)")
    print(f"  Bbox readback:      {stats['bbox_readback']:,} blocks in central 0.5° box")
    print("────────────────────────────────────────────────────────")
    return stats


def main():
    parser = argparse.ArgumentParser(description="Build block-level coverage FlatGeobuf (one state)")
    parser.add_argument("--state", required=True, help="State FIPS ('30') or abbrev ('MT')")
    parser.add_argument("--out", required=True, help="Output .fgb path")
    parser.add_argument("--cache-dir", default="cache", help="Cache directory (default ./cache)")
    args = parser.parse_args()
    build_state(args.state, args.out, args.cache_dir)


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
