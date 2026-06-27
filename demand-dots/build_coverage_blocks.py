"""
Build an EXACT census-block-level coverage layer for GTFS·X.

Where build_dots.py produces a dot map for visualization, this produces one
POINT per populated / job-bearing census block carrying EXACT integer
demographic attributes, so the GTFS·X Coverage panel can tabulate the precise
population/jobs/equity counts inside a transit walkshed (block centroid-in-
polygon) instead of the coarse tract-centroid disc apportionment.

Pipeline (reuses build_dots.py for LODES + the BG→block index):
  1. Fetch ACS 5-year block-group demographics (FULL variable set mirroring
     src/services/demographics.ts, ACS year 2022 to match the on-screen
     method) and derive the same per-BG metrics (population, households,
     workers, high-propensity riders, equity numerators/denominators).
  2. Fetch TIGER TABBLOCK20 block geometries WITH the official internal point
     (INTPTLAT20/INTPTLON20) — the block centroid we tabulate against.
  3. Apportion every BG attribute down to its constituent blocks, weighted by
     block POP20 (2020 decennial) → HOUSING20 → ALAND20 → even split. The
     per-block fraction is computed once and applied to every attribute.
  4. Join LODES WAC block-level jobs by GEOID (no apportionment — already
     block-level).
  5. Write a FlatGeobuf (EPSG:4326, POINT at each block's internal point) with
     short snake_case attribute keys, emitting ONLY blocks where pop>0 OR
     jobs>0.

Usage:
    ./.venv/bin/python build_coverage_blocks.py --state MT --out ../tiles/coverage/mt.fgb
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

# Reuse the existing pipeline (LODES, BG→block index, state resolution).
from build_dots import (
    CACHE_DIR,
    TIGER_YEAR,
    cache_path,
    resolve_state,
    fetch_lodes_wac_state,
    build_bg_to_blocks_index,
)

CENSUS_API_BASE = "https://api.census.gov/data"
# ACS year MUST match src/services/demographics.ts (data/2022/acs/acs5) so the
# block-level Montana numbers stay consistent with the prior tract-centroid
# method — just at finer geography.
ACS_YEAR = 2022
ACS_DATASET = f"{CENSUS_API_BASE}/{ACS_YEAR}/acs/acs5"


# ─── ACS variable set (mirrors src/services/demographics.ts ACS_ALL_VARS) ─────

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
ACS_TENURE_TOTAL = "B25003_001E"
ACS_TENURE_RENTER = "B25003_003E"
ACS_AVG_HH_SIZE = "B25010_001E"
ACS_AGE_18_24 = [
    "B01001_007E", "B01001_008E", "B01001_009E", "B01001_010E",  # male 18-19,20,21,22-24
    "B01001_031E", "B01001_032E", "B01001_033E", "B01001_034E",  # female 18-19,20,21,22-24
]

ACS_ALL_VARS = [
    *ACS_BASE_VARS,
    ACS_LOW_INCOME_DENOM, *ACS_LOW_INCOME_NUM,
    ACS_HOUSEHOLDS_DENOM, *ACS_NO_VEHICLE_NUM,
    *ACS_SENIOR_NUM,
    *ACS_YOUTH_NUM,
    ACS_TENURE_TOTAL, ACS_TENURE_RENTER, ACS_AVG_HH_SIZE,
    *ACS_AGE_18_24,
]

# The integer attributes apportioned to blocks (mirror BlockGroupData fields).
# Order matters only for readability; the .fgb keys come from here.
ATTR_KEYS = [
    "pop", "hh", "workers", "riders",
    "minority", "race_pop", "lowinc", "pov_univ",
    "zeroveh_hh", "occ_hh", "senior", "youth",
]


def _census_key() -> str:
    """Census now requires an API key. Prefer CENSUS_API_KEY, else read
    VITE_CENSUS_API_KEY from the repo root .env (same key the SPA bundles)."""
    key = os.environ.get("CENSUS_API_KEY")
    if key:
        return key
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("VITE_CENSUS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    """Numeric column, Census negative sentinels (< 0) coerced to 0 (matches
    build_dots.py). Missing column → all zeros."""
    if col not in df.columns:
        return pd.Series(0, index=df.index, dtype=float)
    vals = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return vals.where(vals >= 0, 0)


def fetch_block_group_full_state(state_fips: str) -> pd.DataFrame:
    """Fetch the FULL ACS variable set for a state's block groups and derive
    the per-BG attributes that mirror src/services/demographics.ts exactly."""
    cache_file = cache_path(f"acs{ACS_YEAR}_cov_bg_state_{state_fips}.csv")
    if cache_file.exists():
        print(f"  Using cached coverage ACS block-group data: {cache_file}")
        return pd.read_csv(cache_file, dtype={"GEOID": str})

    print(f"  Fetching ACS {ACS_YEAR} 5-yr block-group data ({len(ACS_ALL_VARS)} vars, state {state_fips})...")
    params = {
        "get": ",".join(ACS_ALL_VARS),
        "for": "block group:*",
        "in": f"state:{state_fips} county:* tract:*",
    }
    key = _census_key()
    if key:
        params["key"] = key
    resp = requests.get(ACS_DATASET, params=params)
    resp.raise_for_status()
    data = resp.json()
    df = pd.DataFrame(data[1:], columns=data[0])
    df["GEOID"] = df["state"] + df["county"] + df["tract"] + df["block group"]

    population = _num(df, "B01003_001E")
    total_race = _num(df, "B03002_001E")
    nonhisp_white = _num(df, "B03002_003E")

    # High-propensity riders — identical model to demographics.ts:
    #   renter_pop  = renter share of tenure × population
    #   zero_veh_pop = zero-vehicle households × avg household size (≥0; 2.5 fb)
    #   pop_18_24   = adults 18-24 from B01001
    #   high = min(population, round((renter_pop + zero_veh_pop + pop_18_24)×0.6))
    zero_veh_hh = sum((_num(df, c) for c in ACS_NO_VEHICLE_NUM), start=pd.Series(0.0, index=df.index))
    tenure_total = _num(df, ACS_TENURE_TOTAL)
    renter_units = _num(df, ACS_TENURE_RENTER)
    renter_pop = np.where(tenure_total > 0, (renter_units / tenure_total * population).round(), 0)
    avg_hh_raw = _num(df, ACS_AVG_HH_SIZE)
    avg_hh = avg_hh_raw.where(avg_hh_raw > 0, 2.5)
    zero_veh_pop = (zero_veh_hh * avg_hh).round()
    pop_18_24 = sum((_num(df, c) for c in ACS_AGE_18_24), start=pd.Series(0.0, index=df.index))
    riders = np.minimum(population, ((renter_pop + zero_veh_pop + pop_18_24) * 0.6).round())

    lowinc = sum((_num(df, c) for c in ACS_LOW_INCOME_NUM), start=pd.Series(0.0, index=df.index))
    senior = sum((_num(df, c) for c in ACS_SENIOR_NUM), start=pd.Series(0.0, index=df.index))
    youth = sum((_num(df, c) for c in ACS_YOUTH_NUM), start=pd.Series(0.0, index=df.index))

    out = pd.DataFrame({
        "GEOID": df["GEOID"],
        "pop": population,
        # Households here = occupied households (B25044_001E), per the coverage
        # spec; also surfaced separately as occ_hh (the equity denominator).
        "hh": _num(df, ACS_HOUSEHOLDS_DENOM),
        "workers": _num(df, "B08301_001E"),
        "riders": riders,
        "minority": np.maximum(0, total_race - nonhisp_white),
        "race_pop": total_race,
        "lowinc": lowinc,
        "pov_univ": _num(df, ACS_LOW_INCOME_DENOM),
        "zeroveh_hh": zero_veh_hh,
        "occ_hh": _num(df, ACS_HOUSEHOLDS_DENOM),
        "senior": senior,
        "youth": youth,
    })
    for k in ATTR_KEYS:
        out[k] = out[k].round().astype(int)
    out.to_csv(cache_file, index=False)
    print(f"  Cached coverage ACS data: {len(out)} block groups")
    return out


def fetch_block_geometries_cov_state(state_fips: str) -> gpd.GeoDataFrame:
    """Download TIGER TABBLOCK20 for a state, keeping POP20/HOUSING20/ALAND20
    for apportionment weighting PLUS the official internal point
    (INTPTLAT20/INTPTLON20) — the block centroid we tabulate against.

    A copy of build_dots.fetch_block_geometries_state with the internal point
    added to the keep-list and a distinct cache filename, so build_dots.py's
    pipeline stays untouched."""
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


def apportion_state(
    bg_data: pd.DataFrame,
    bg_index: dict[str, pd.DataFrame],
) -> dict[str, dict]:
    """Apportion every BG attribute to its blocks, weighted by POP20 (→HOUSING20
    →ALAND20→even). The per-block fraction is computed once and applied to all
    attributes. Returns geoid → {lon, lat, attrs...} for every block in a BG
    that has demographic data."""
    blocks: dict[str, dict] = {}
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

        bg_attrs = {k: float(row[k]) for k in ATTR_KEYS}
        geoids = bg_blocks["GEOID_BLOCK"].to_numpy()
        lons = bg_blocks["INTPTLON20"].to_numpy()
        lats = bg_blocks["INTPTLAT20"].to_numpy()
        for i in range(len(bg_blocks)):
            frac = weights[i]
            rec = {"lon": float(lons[i]), "lat": float(lats[i])}
            for k in ATTR_KEYS:
                rec[k] = max(0, int(round(bg_attrs[k] * frac)))
            blocks[geoids[i]] = rec
    return blocks


def main():
    parser = argparse.ArgumentParser(description="Build block-level coverage FlatGeobuf")
    parser.add_argument("--state", required=True, help="State FIPS ('30') or abbrev ('MT')")
    parser.add_argument("--out", required=True, help="Output .fgb path")
    args = parser.parse_args()

    state_fips, abbr = resolve_state(args.state)
    print(f"Building block-level coverage layer for {abbr.upper()} (FIPS {state_fips})")

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

    out_path = Path(args.out)
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

    print("\n── Summary ─────────────────────────────────────────────")
    print(f"  Blocks emitted:     {len(gdf):,}  ({job_only:,} job-only)")
    print(f"  File size:          {size_mb:.2f} MB  ({out_path})")
    print(f"  Total population:   {int(gdf['pop'].sum()):,}  (ACS statewide {statewide_acs_pop:,})")
    print(f"  Total households:   {int(gdf['hh'].sum()):,}")
    print(f"  Total workers:      {int(gdf['workers'].sum()):,}")
    print(f"  Total riders:       {int(gdf['riders'].sum()):,}")
    print(f"  Total jobs:         {int(gdf['jobs'].sum()):,}")
    print(f"  Bbox readback:      {len(bbox_read):,} blocks in central 0.5° box")
    print("────────────────────────────────────────────────────────")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
