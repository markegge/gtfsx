"""
Build a synthetic population dot map for transit demand analysis.

Generates one dot per person/job at the census block level, with three classes:
  - high: High transit propensity (renters ∪ zero-vehicle-HH ∪ age 18-24, deduped)
  - other: All other adults
  - jobs:  LODES workplace-area-characteristics total jobs

ACS variables are fetched at block group granularity and apportioned to blocks
by land area. LODES WAC is already block-level. Block geometries come from
TIGER/Line TABBLOCK20.

Housing-permit data (previously Bozeman-specific) has been removed — this
pipeline only produces the three transit-demand classes.

Usage:
    # Whole state (preferred for nationwide builds):
    uv run python build_dots.py --state MT --output dots_mt.ldjson --ldjson

    # Single county (legacy):
    uv run python build_dots.py --county 30031 --output dots.geojson
"""

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Iterator

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
from shapely.geometry import Point, mapping

CENSUS_API_BASE = "https://api.census.gov/data"
ACS_YEAR = 2024  # latest 5-year release = 2020-2024 (Dec 2025)
ACS_DATASET = f"{CENSUS_API_BASE}/{ACS_YEAR}/acs/acs5"
TIGER_YEAR = 2025
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
# LODES WAC: probe downwards from this year until a file exists. LODES lags
# ACS/TIGER by ~2 years so the actual data year used will usually be older.
LODES_PROBE_START = 2024

CACHE_DIR = Path("cache")


def cache_path(name: str) -> Path:
    CACHE_DIR.mkdir(exist_ok=True)
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
    # Two-digit number: treat as FIPS
    if len(s) == 2 and s.isdigit():
        return s, FIPS_TO_ABBR.get(s, s)
    raise ValueError(f"Could not resolve state: {s!r}")


# ─── ACS (block group) ────────────────────────────────────────────────────────

ACS_VARS = [
    "B01001_001E",  # total pop
    "B01001_007E", "B01001_008E", "B01001_009E", "B01001_010E",  # male 18-24
    "B01001_031E", "B01001_032E", "B01001_033E", "B01001_034E",  # female 18-24
    "B25003_001E",  # total occupied units
    "B25003_003E",  # renter-occupied units
    "B25044_003E",  # owner-occupied, no vehicle
    "B25044_010E",  # renter-occupied, no vehicle
    "B25010_001E",  # average household size
]


def _census_api_get(dataset_url: str, get_vars: list[str], geo: dict) -> pd.DataFrame:
    params = {"get": ",".join(get_vars)}
    params.update(geo)
    api_key = os.environ.get("CENSUS_API_KEY")
    if api_key:
        params["key"] = api_key
    resp = requests.get(dataset_url, params=params)
    resp.raise_for_status()
    data = resp.json()
    return pd.DataFrame(data[1:], columns=data[0])


def _compute_acs_derived(df: pd.DataFrame) -> pd.DataFrame:
    for col in ACS_VARS:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["total_pop"] = df["B01001_001E"]
    df["pop_18_24"] = (
        df["B01001_007E"] + df["B01001_008E"] + df["B01001_009E"] + df["B01001_010E"]
        + df["B01001_031E"] + df["B01001_032E"] + df["B01001_033E"] + df["B01001_034E"]
    )
    df["renter_units"] = df["B25003_003E"]
    df["total_units"] = df["B25003_001E"]
    df["renter_pop"] = np.where(
        df["total_units"] > 0,
        (df["renter_units"] / df["total_units"] * df["total_pop"]).round(),
        0,
    ).astype(int)
    df["zero_veh_hh"] = df["B25044_003E"] + df["B25044_010E"]
    df["avg_hh_size"] = df["B25010_001E"].replace(0, 2.5)
    df["zero_veh_pop"] = (df["zero_veh_hh"] * df["avg_hh_size"]).round().astype(int)

    # High-propensity = (renter + zero-veh + 18-24), scaled down 0.6 for overlap
    df["high_propensity"] = (
        (df["renter_pop"] + df["zero_veh_pop"] + df["pop_18_24"]) * 0.6
    ).round().astype(int)
    df["high_propensity"] = df[["high_propensity", "total_pop"]].min(axis=1)

    df["adults"] = (df["total_pop"] * 0.78).round().astype(int)
    df["other_adults"] = (df["adults"] - df["high_propensity"]).clip(lower=0)
    return df[["GEOID", "total_pop", "high_propensity", "other_adults"]].copy()


def fetch_block_group_data_county(state_fips: str, county_fips: str) -> pd.DataFrame:
    cache_file = cache_path(f"acs{ACS_YEAR}_bg_{state_fips}_{county_fips}.csv")
    if cache_file.exists():
        print(f"  Using cached ACS block group data: {cache_file}")
        return pd.read_csv(cache_file, dtype={"GEOID": str})
    print(f"  Fetching ACS {ACS_YEAR} 5-yr block group data (county {state_fips}{county_fips})...")
    df = _census_api_get(
        ACS_DATASET, ACS_VARS,
        {"for": "block group:*", "in": f"state:{state_fips} county:{county_fips}"},
    )
    df["GEOID"] = df["state"] + df["county"] + df["tract"] + df["block group"]
    result = _compute_acs_derived(df)
    result.to_csv(cache_file, index=False)
    print(f"  Cached ACS data: {len(result)} block groups")
    return result


def fetch_block_group_data_state(state_fips: str) -> pd.DataFrame:
    """Fetch ACS block group data for an entire state in one API call."""
    cache_file = cache_path(f"acs{ACS_YEAR}_bg_state_{state_fips}.csv")
    if cache_file.exists():
        print(f"  Using cached ACS block group data: {cache_file}")
        return pd.read_csv(cache_file, dtype={"GEOID": str})
    print(f"  Fetching ACS {ACS_YEAR} 5-yr block group data (state {state_fips})...")
    # ACS requires county:* alongside block group:* in the state-wide query
    df = _census_api_get(
        ACS_DATASET, ACS_VARS,
        {"for": "block group:*", "in": f"state:{state_fips} county:*"},
    )
    df["GEOID"] = df["state"] + df["county"] + df["tract"] + df["block group"]
    result = _compute_acs_derived(df)
    result.to_csv(cache_file, index=False)
    print(f"  Cached ACS data: {len(result)} block groups")
    return result


# ─── LODES WAC (block-level jobs) ─────────────────────────────────────────────

def fetch_lodes_wac_state(state_fips: str) -> pd.DataFrame:
    """Download LODES WAC for a whole state, probing for the newest available year.

    Returns block-level job counts. Cache filename includes the detected year
    so a future regen can tell at a glance what vintage the cached data is.
    """
    abbr = FIPS_TO_ABBR.get(state_fips, state_fips)
    # Check existing cache (any year) before hitting the network
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
        raise RuntimeError(f"No LODES WAC file found for {abbr.upper()} in any year")

    tmp = tempfile.NamedTemporaryFile(suffix=".csv.gz", delete=False)
    tmp.write(resp.content); tmp.close()
    df = pd.read_csv(tmp.name, dtype={"w_geocode": str})
    os.unlink(tmp.name)
    result = df[["w_geocode", "C000"]].rename(columns={"C000": "total_jobs"})
    cache_file = cache_path(f"lodes_wac_state_{state_fips}_{year}.csv")
    result.to_csv(cache_file, index=False)
    print(f"  Cached LODES {year}: {len(result)} blocks, {result['total_jobs'].sum():,} jobs")
    return result


def fetch_lodes_wac_county(state_fips: str, county_fips: str) -> pd.DataFrame:
    state = fetch_lodes_wac_state(state_fips)
    prefix = state_fips + county_fips
    return state[state["w_geocode"].str.startswith(prefix)].copy()


# ─── TIGER block geometries ───────────────────────────────────────────────────

def fetch_block_geometries_state(state_fips: str) -> gpd.GeoDataFrame:
    """Download TIGER TABBLOCK20 for a state; keep POP20 + HOUSING20 for
    apportionment weighting (far more accurate than land area)."""
    cache_file = cache_path(f"blocks_state_{state_fips}_tiger{TIGER_YEAR}.gpkg")
    if cache_file.exists():
        print(f"  Using cached block geometries: {cache_file}")
        return gpd.read_file(cache_file)
    print(f"  Downloading TIGER/Line {TIGER_YEAR} state block geometries ({state_fips})...")
    url = (
        f"https://www2.census.gov/geo/tiger/TIGER{TIGER_YEAR}/TABBLOCK20/"
        f"tl_{TIGER_YEAR}_{state_fips}_tabblock20.zip"
    )
    resp = requests.get(url)
    resp.raise_for_status()
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp.write(resp.content); tmp.close()
    gdf = gpd.read_file(f"zip://{tmp.name}")
    os.unlink(tmp.name)
    gdf = gdf[gdf["STATEFP20"] == state_fips]
    keep = ["GEOID20", "POP20", "HOUSING20", "ALAND20", "geometry"]
    gdf = gdf[keep].rename(columns={"GEOID20": "GEOID_BLOCK"})
    for col in ("POP20", "HOUSING20", "ALAND20"):
        gdf[col] = pd.to_numeric(gdf[col], errors="coerce").fillna(0)
    gdf.to_file(cache_file, driver="GPKG")
    print(f"  Cached block geometries: {len(gdf)} blocks")
    return gdf


def fetch_block_geometries_county(state_fips: str, county_fips: str) -> gpd.GeoDataFrame:
    state = fetch_block_geometries_state(state_fips)
    mask = state["GEOID_BLOCK"].str[:5] == (state_fips + county_fips)
    return state[mask].copy()


# ─── Apportionment + dot generation ───────────────────────────────────────────

def build_bg_to_blocks_index(blocks_gdf: gpd.GeoDataFrame) -> dict[str, pd.DataFrame]:
    """Group blocks by their 12-char block group GEOID for fast apportionment."""
    b = blocks_gdf.copy()
    b["BG_GEOID"] = b["GEOID_BLOCK"].str[:12]
    return {bg: g for bg, g in b.groupby("BG_GEOID", sort=False)}


def apportion_bg_to_blocks(
    bg_geoid: str,
    bg_high: int,
    bg_other: int,
    bg_index: dict[str, pd.DataFrame],
) -> list[tuple[str, int, int]]:
    """Distribute block group counts across its constituent blocks.

    Weight preference: POP20 (actual 2020 decennial population per block) →
    HOUSING20 (housing unit count) → ALAND20 (land area, last resort).
    Using population instead of land area is a huge accuracy win in rural
    areas, where a single empty 500 km² block otherwise absorbs half the
    block group's residents.
    """
    bg_blocks = bg_index.get(bg_geoid)
    if bg_blocks is None or len(bg_blocks) == 0:
        return []

    for weight_col in ("POP20", "HOUSING20", "ALAND20"):
        if weight_col not in bg_blocks.columns:
            continue
        total = bg_blocks[weight_col].sum()
        if total > 0:
            results: list[tuple[str, int, int]] = []
            for geoid, w in zip(bg_blocks["GEOID_BLOCK"], bg_blocks[weight_col]):
                frac = w / total
                results.append((
                    geoid,
                    max(0, round(bg_high * frac)),
                    max(0, round(bg_other * frac)),
                ))
            return results

    # Nothing usable — split evenly
    n = len(bg_blocks)
    return [
        (geoid, max(0, round(bg_high / n)), max(0, round(bg_other / n)))
        for geoid in bg_blocks["GEOID_BLOCK"]
    ]


def random_points_in_polygon(polygon, n: int, rng: np.random.Generator) -> list[Point]:
    if n <= 0 or polygon.is_empty:
        return []
    points: list[Point] = []
    minx, miny, maxx, maxy = polygon.bounds
    max_attempts = n * 20
    attempts = 0
    while len(points) < n and attempts < max_attempts:
        batch_size = min((n - len(points)) * 3, 10000)
        xs = rng.uniform(minx, maxx, batch_size)
        ys = rng.uniform(miny, maxy, batch_size)
        for x, y in zip(xs, ys):
            pt = Point(x, y)
            if polygon.contains(pt):
                points.append(pt)
                if len(points) >= n:
                    break
        attempts += batch_size
    return points[:n]


def iter_dot_features(
    blocks_gdf: gpd.GeoDataFrame,
    block_pop: dict[str, tuple[int, int]],
    block_jobs: dict[str, int],
    dots_per_person: int,
    dots_per_job: int,
) -> Iterator[dict]:
    """Yield GeoJSON Feature dicts one at a time; does not build a full list."""
    rng = np.random.default_rng(42)
    for _, block in blocks_gdf.iterrows():
        geoid = block["GEOID_BLOCK"]
        geom = block["geometry"]
        if geom is None or geom.is_empty:
            continue
        high, other = block_pop.get(geoid, (0, 0))
        jobs = block_jobs.get(geoid, 0)
        n_high = max(0, high // dots_per_person)
        n_other = max(0, other // dots_per_person)
        n_jobs = max(0, jobs // dots_per_job)
        total_needed = n_high + n_other + n_jobs
        if total_needed == 0:
            continue
        points = random_points_in_polygon(geom, total_needed, rng)
        idx = 0
        for _ in range(min(n_high, len(points) - idx)):
            yield {"type": "Feature", "properties": {"class": "high"},
                   "geometry": mapping(points[idx])}
            idx += 1
        for _ in range(min(n_other, max(0, len(points) - idx))):
            yield {"type": "Feature", "properties": {"class": "other"},
                   "geometry": mapping(points[idx])}
            idx += 1
        for _ in range(min(n_jobs, max(0, len(points) - idx))):
            yield {"type": "Feature", "properties": {"class": "jobs"},
                   "geometry": mapping(points[idx])}
            idx += 1


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build transit demand dot map")
    parser.add_argument("--state", help="State FIPS ('30') or abbrev ('MT'). Whole-state build.")
    parser.add_argument("--county", help="5-char state+county FIPS ('30031'). Single-county build.")
    parser.add_argument("--output", required=True, help="Output path")
    parser.add_argument("--ldjson", action="store_true",
                        help="Line-delimited GeoJSON (one Feature per line). "
                             "Default is a single FeatureCollection.")
    parser.add_argument("--dots-per-person", type=int, default=5)
    parser.add_argument("--dots-per-job", type=int, default=5)
    args = parser.parse_args()

    if bool(args.state) == bool(args.county):
        parser.error("Specify exactly one of --state or --county")

    # 1-3. Fetch sources
    if args.state:
        state_fips, abbr = resolve_state(args.state)
        print(f"Building transit demand dots for state {abbr.upper()} (FIPS {state_fips})")
        print("\n1. Fetching Census ACS block group data...")
        bg_data = fetch_block_group_data_state(state_fips)
        print("\n2. Fetching LODES employment data...")
        lodes_data = fetch_lodes_wac_state(state_fips)
        print("\n3. Fetching block geometries...")
        blocks_gdf = fetch_block_geometries_state(state_fips)
    else:
        state_fips, county_fips = args.county[:2], args.county[2:]
        abbr = FIPS_TO_ABBR.get(state_fips, state_fips)
        print(f"Building transit demand dots for county {state_fips}{county_fips} ({abbr.upper()})")
        print("\n1. Fetching Census ACS block group data...")
        bg_data = fetch_block_group_data_county(state_fips, county_fips)
        print("\n2. Fetching LODES employment data...")
        lodes_data = fetch_lodes_wac_county(state_fips, county_fips)
        print("\n3. Fetching block geometries...")
        blocks_gdf = fetch_block_geometries_county(state_fips, county_fips)

    # 4. Apportion BG→block
    print("\n4. Apportioning block group data to census blocks...")
    bg_index = build_bg_to_blocks_index(blocks_gdf)
    block_pop: dict[str, tuple[int, int]] = {}
    for _, row in bg_data.iterrows():
        for block_geoid, high, other in apportion_bg_to_blocks(
            row["GEOID"], int(row["high_propensity"]), int(row["other_adults"]), bg_index,
        ):
            block_pop[block_geoid] = (high, other)

    block_jobs = {row["w_geocode"]: int(row["total_jobs"]) for _, row in lodes_data.iterrows()}

    print(f"  Population blocks: {len(block_pop):,}")
    print(f"  Employment blocks: {len(block_jobs):,}")
    print(f"  Total high propensity: {sum(v[0] for v in block_pop.values()):,}")
    print(f"  Total other adults:    {sum(v[1] for v in block_pop.values()):,}")
    print(f"  Total jobs:            {sum(block_jobs.values()):,}")

    # 5. Stream features to disk
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"\n5. Writing dots ({args.dots_per_person} ppl/dot, {args.dots_per_job} jobs/dot) → {out_path}"
          f" [{'ldjson' if args.ldjson else 'FeatureCollection'}]")

    counts = {"high": 0, "other": 0, "jobs": 0}
    total = 0
    with open(out_path, "w") as f:
        if not args.ldjson:
            f.write('{"type":"FeatureCollection","features":[')
        first = True
        for feat in iter_dot_features(blocks_gdf, block_pop, block_jobs,
                                      args.dots_per_person, args.dots_per_job):
            cls = feat["properties"]["class"]
            counts[cls] = counts.get(cls, 0) + 1
            total += 1
            if args.ldjson:
                f.write(json.dumps(feat))
                f.write("\n")
            else:
                if not first:
                    f.write(",")
                f.write(json.dumps(feat))
                first = False
            if total % 50000 == 0:
                print(f"    ... {total:,} features written")
        if not args.ldjson:
            f.write(']}')

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"\nDot summary:")
    print(f"  High propensity (high): {counts['high']:,}")
    print(f"  Other adults (other):   {counts['other']:,}")
    print(f"  Jobs (jobs):            {counts['jobs']:,}")
    print(f"  Total features:         {total:,}")
    print(f"  File size:              {size_mb:.1f} MB  ({out_path})")


if __name__ == "__main__":
    main()
