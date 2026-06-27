"""Focused conservation test for build_coverage_blocks.apportion_state.

Verifies that apportioning a block group's attributes down to its blocks
(POP20-weighted) conserves the totals within rounding, and that the weight
fallback chain (POP20 → HOUSING20 → ALAND20 → even) behaves as designed.

Run:  ./.venv/bin/python test_apportion.py
"""

import geopandas as gpd
import pandas as pd
from shapely.geometry import Point

from build_coverage_blocks import apportion_state, ATTR_KEYS
from build_dots import build_bg_to_blocks_index


def _blocks_gdf(rows):
    """rows: list of (geoid_block, pop20, housing20, aland20). Internal point is
    a throwaway coordinate (apportionment ignores geometry)."""
    df = pd.DataFrame(rows, columns=["GEOID_BLOCK", "POP20", "HOUSING20", "ALAND20"])
    df["INTPTLAT20"] = "+46.0000000"
    df["INTPTLON20"] = "-111.0000000"
    return gpd.GeoDataFrame(df, geometry=[Point(-111, 46)] * len(df), crs="EPSG:4326")


def _bg_row(geoid, **attrs):
    row = {"GEOID": geoid}
    for k in ATTR_KEYS:
        row[k] = attrs.get(k, 0)
    return row


def test_pop_weighted_conservation():
    # One BG (12-char prefix 300010001001) with three blocks, POP20 60/30/10.
    bg = "300010001001"
    blocks = _blocks_gdf([
        (bg + "000", 60, 20, 1000),
        (bg + "001", 30, 10, 5000),
        (bg + "002", 10, 5, 90000),
    ])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(bg, pop=1000, workers=500, jobs=0, riders=300)])

    result = apportion_state(bg_data, bg_index)
    assert len(result) == 3
    # 60/30/10 split of pop=1000 → 600/300/100, sums back to 1000.
    pops = sorted(r["pop"] for r in result.values())
    assert pops == [100, 300, 600], pops
    for key, bg_total in (("pop", 1000), ("workers", 500), ("riders", 300)):
        s = sum(r[key] for r in result.values())
        assert abs(s - bg_total) <= 3, (key, s, bg_total)
    print("ok: POP20-weighted conservation")


def test_housing_fallback_when_pop_zero():
    # All POP20 = 0 → falls back to HOUSING20 weights (3/1).
    bg = "300010001002"
    blocks = _blocks_gdf([
        (bg + "000", 0, 30, 1000),
        (bg + "001", 0, 10, 1000),
    ])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(bg, pop=400, hh=80)])
    result = apportion_state(bg_data, bg_index)
    pops = sorted(r["pop"] for r in result.values())
    assert pops == [100, 300], pops  # 1:3 housing split of 400
    print("ok: HOUSING20 fallback")


def test_even_split_when_no_weights():
    # POP20/HOUSING20/ALAND20 all zero → even split.
    bg = "300010001003"
    blocks = _blocks_gdf([
        (bg + "000", 0, 0, 0),
        (bg + "001", 0, 0, 0),
        (bg + "002", 0, 0, 0),
    ])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(bg, pop=90)])
    result = apportion_state(bg_data, bg_index)
    assert sorted(r["pop"] for r in result.values()) == [30, 30, 30]
    print("ok: even split")


if __name__ == "__main__":
    test_pop_weighted_conservation()
    test_housing_fallback_when_pop_zero()
    test_even_split_when_no_weights()
    print("\nAll apportionment conservation tests passed.")
