"""Conservation + invariant tests for coverage-pipeline/build_coverage_blocks.py.

This targets the CANONICAL coverage-pipeline/build_coverage_blocks.py — the
implementation (with the Connecticut ACS pin) that actually builds the live
us.fgb served in production — via an explicit sys.path insert, NOT a local copy
in demand-dots/. Do not repoint it at one.

WHAT IS BEING DEFENDED HERE
───────────────────────────
Three things, in ascending order of how badly a regression would hurt:

  1. CONSERVATION. Apportioning a block group's attributes down to its blocks
     must not lose people. It used to: each column was rounded independently, so
     a rare attribute spread thinly across many blocks rounded to zero in every
     one of them and simply evaporated. Montana lost 10.2% of its zero-vehicle
     households and 5.7% of its carless residents that way, into a column the
     Title VI panel reports. Largest-remainder apportionment fixed it, and
     test_rare_attribute_is_not_rounded_away is the regression test — it fails
     loudly against the old code.

  2. THE UNION INVARIANTS. A segment can never out-number the union that contains
     it, and a union can never exceed the population. These hold at block group by
     construction (puma_union.reconcile), but INDEPENDENT ROUNDING AT BLOCK LEVEL
     CAN BREAK THEM — and a one-block rural walkshed would then print "Carless 12,
     Ridership propensity 11" on screen. reconcile_blocks() re-clamps; these tests
     prove it.

  3. THE ESTIMATE / COUNT DISTINCTION. `prop_all` / `need_all` are PUMS-derived
     statistical estimates; every other column is a straight ACS count. The schema
     itself has to keep them apart, because three separate UIs render that split.

Run:  ./.venv/bin/python test_apportion.py
"""

import os
import sys

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "coverage-pipeline"))
from build_coverage_blocks import (  # noqa: E402
    ATTR_KEYS,
    COUNT_KEYS,
    UNION_KEYS,
    apportion_state,
    reconcile_blocks,
)
from build_dots import build_bg_to_blocks_index  # noqa: E402
import puma_union  # noqa: E402


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


# ─── The schema ───────────────────────────────────────────────────────────────

def test_schema_separates_estimates_from_counts():
    # The two unions are the ONLY estimates. Everything else is an ACS count, and
    # the frontend badges them differently on three surfaces (the dot-map layer
    # control, the Coverage summary cards, the walkshed profile table). A column
    # that silently migrated from one list to the other would ship a statistical
    # estimate labelled as a headcount.
    assert UNION_KEYS == ["prop_all", "need_all"], UNION_KEYS
    assert set(COUNT_KEYS) & set(UNION_KEYS) == set()
    assert ATTR_KEYS == [*COUNT_KEYS, *UNION_KEYS]

    # The retired ×0.6 model's column is gone and must not come back: it is a
    # DIFFERENT, abandoned definition of the same headline number, and shipping it
    # beside prop_all would put two contradictory answers in one file.
    assert "riders" not in ATTR_KEYS

    # The four segments the two composites are built from all have to be present,
    # or the UI cannot show a segment breakdown beneath its union.
    for seg in ("carless", "lowinc", "senior", "disability"):
        assert seg in COUNT_KEYS, seg

    # `carless` (PEOPLE) and `zeroveh_hh` (HOUSEHOLDS) are different units and both
    # ship. Collapsing them would silently change the Title VI denominator.
    assert "zeroveh_hh" in COUNT_KEYS
    print("ok: schema keeps the 2 union ESTIMATES apart from the ACS COUNTS")


# ─── Conservation ─────────────────────────────────────────────────────────────

def test_pop_weighted_conservation():
    # One BG (12-char prefix 300010001001) with three blocks, POP20 60/30/10.
    bg = "300010001001"
    blocks = _blocks_gdf([
        (bg + "000", 60, 20, 1000),
        (bg + "001", 30, 10, 5000),
        (bg + "002", 10, 5, 90000),
    ])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(
        bg, pop=1000, workers=500, carless=60, lowinc=300,
        senior=150, disability=100, prop_all=330, need_all=520,
    )])

    result = apportion_state(bg_data, bg_index)
    assert len(result) == 3
    # 60/30/10 split of pop=1000 → 600/300/100, sums back to 1000.
    pops = sorted(r["pop"] for r in result.values())
    assert pops == [100, 300, 600], pops
    # EXACT conservation, every column — not "within rounding". Largest remainder
    # gives back the block group's own total to the person.
    for key in ATTR_KEYS:
        want = int(bg_data.iloc[0][key])
        got = sum(r[key] for r in result.values())
        assert got == want, (key, got, want)
    print("ok: POP20-weighted apportionment conserves EVERY column exactly")


def test_rare_attribute_is_not_rounded_away():
    """THE REGRESSION TEST. The old code rounded each block independently, so a
    small count spread over many blocks vanished entirely: 24 carless people over
    100 equal blocks is 0.24 per block, and round(0.24) == 0, one hundred times.

    This is not hypothetical — it cost the shipped us.fgb 10.2% of Montana's
    zero-vehicle households and 5.7% of its carless residents.
    """
    bg = "300010001009"
    blocks = _blocks_gdf([(f"{bg}{i:03d}", 10, 4, 500) for i in range(100)])
    bg_index = build_bg_to_blocks_index(blocks)
    # 24 carless / 21 zero-vehicle households across 100 identical blocks. Under
    # independent rounding EVERY block gets round(0.24) = 0 and both vanish.
    bg_data = pd.DataFrame([_bg_row(
        bg, pop=1000, carless=24, zeroveh_hh=21, lowinc=250,
        senior=120, disability=80, prop_all=265, need_all=400,
    )])
    result = apportion_state(bg_data, bg_index)

    assert sum(r["carless"] for r in result.values()) == 24
    assert sum(r["zeroveh_hh"] for r in result.values()) == 21
    assert sum(r["disability"] for r in result.values()) == 80
    # And they land in real blocks, not smeared into fractions.
    assert sum(1 for r in result.values() if r["carless"] > 0) == 24
    print("ok: a rare attribute survives apportionment (the -5.7%/-10.2% bug)")


def test_residence_columns_land_only_where_people_landed():
    """Only blocks with pop>0 (or jobs>0) are written to the .fgb. If a residence
    column's last unit were apportioned into a block that ended up with pop=0, that
    block gets dropped at emit and the person disappears — re-opening the leak from
    a different direction. Population is apportioned first and gates the rest."""
    bg = "300010001010"
    # 50 blocks, but the BG only has 3 people: at most 3 blocks can be peopled.
    blocks = _blocks_gdf([(f"{bg}{i:03d}", 1, 1, 100) for i in range(50)])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(
        bg, pop=3, carless=2, lowinc=3, senior=1, disability=1,
        prop_all=3, need_all=3, occ_hh=2, zeroveh_hh=1,
    )])
    result = apportion_state(bg_data, bg_index)

    emitted = {g: r for g, r in result.items() if r["pop"] > 0}
    assert len(emitted) == 3, len(emitted)
    # Nothing residential is stranded in a block that will be dropped.
    for g, r in result.items():
        if r["pop"] == 0:
            for k in ATTR_KEYS:
                assert r[k] == 0, (g, k, r[k])
    # …so the emitted blocks still carry the block group's whole total.
    for k in ATTR_KEYS:
        assert sum(r[k] for r in emitted.values()) == int(bg_data.iloc[0][k]), k
    print("ok: residence columns never strand units in blocks that get dropped")


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


# ─── The union invariants, at BLOCK level ─────────────────────────────────────

def _invariants(blocks: dict) -> list[str]:
    """Run puma_union's own invariant checker over an apportioned block dict."""
    g = list(blocks)
    cls = {
        "total_pop": np.array([blocks[k]["pop"] for k in g]),
        "carless": np.array([blocks[k]["carless"] for k in g]),
        "low_income": np.array([blocks[k]["lowinc"] for k in g]),
        "senior": np.array([blocks[k]["senior"] for k in g]),
        "disability": np.array([blocks[k]["disability"] for k in g]),
        "prop_all": np.array([blocks[k]["prop_all"] for k in g]),
        "need_all": np.array([blocks[k]["need_all"] for k in g]),
    }
    cls["backdrop_prop"] = cls["total_pop"] - cls["prop_all"]
    cls["backdrop_need"] = cls["total_pop"] - cls["need_all"]
    return puma_union.check_invariants(cls)


def test_reconcile_repairs_rounding_induced_violations():
    """Largest remainder conserves each COLUMN, but the leftover unit of `carless`
    and the leftover unit of `prop_all` can land in DIFFERENT blocks. That is
    enough to make a block claim more carless residents than likely riders — an
    arithmetic impossibility, and one a single-block rural walkshed renders on
    screen. reconcile_blocks() is what makes it impossible in the file."""
    bg = "300010001004"
    blocks = _blocks_gdf([
        (bg + "000", 7, 3, 100),
        (bg + "001", 3, 1, 100),
        (bg + "002", 1, 1, 100),
    ])
    bg_index = build_bg_to_blocks_index(blocks)
    # A REAL violating case, not a hypothetical one. These block-group numbers are
    # themselves invariant-clean (53 ≤ prop 59 ≤ 64; 59 ≤ need 98 ≤ 99), but the
    # 7/3/1 split rounds them into a block with
    #     pop 9, carless 1, lowinc 5, senior 2, disability 1, prop 5, need 9
    # whose need_all (9) exceeds prop_all + senior + disability (5+2+1 = 8). No
    # assignment of 9 people to flag combinations produces that: need can only add
    # seniors and disabled people to prop, and there are not enough of them. It is
    # the exact infeasibility that breaks the dot pipeline's 16-cell fit.
    bg_data = pd.DataFrame([_bg_row(
        bg, pop=101, carless=11, lowinc=53, senior=23, disability=17,
        prop_all=59, need_all=98,
    )])
    apportioned = apportion_state(bg_data, bg_index)
    assert _invariants(apportioned) != [], (
        "fixture no longer reproduces a rounding-induced violation — it must, or "
        "this test is asserting nothing about reconcile_blocks")

    fixed, n_changed = reconcile_blocks(dict(apportioned))
    assert n_changed > 0, "reconcile_blocks did not repair the violation it was handed"
    assert _invariants(fixed) == [], _invariants(fixed)
    # Every block individually realizable, too.
    for g, r in fixed.items():
        assert max(r["carless"], r["lowinc"]) <= r["prop_all"] <= r["need_all"] <= r["pop"], (g, r)
        assert r["senior"] <= r["need_all"] and r["disability"] <= r["need_all"], (g, r)
        # The conditional bound: need can only add seniors and disabled people to
        # prop, so it cannot exceed their sum. This is the feasibility condition
        # the dot pipeline's 16-cell fit depends on.
        assert r["need_all"] <= r["prop_all"] + r["senior"] + r["disability"], (g, r)
    print(f"ok: reconcile_blocks repairs rounding violations ({n_changed} blocks adjusted)")


def test_reconcile_is_idempotent():
    # Running it twice must change nothing — it is a clamp, not an iteration, and
    # a build that re-ran it must not drift.
    bg = "300010001005"
    blocks = _blocks_gdf([(bg + "000", 5, 2, 10), (bg + "001", 3, 1, 10)])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(
        bg, pop=57, carless=19, lowinc=23, senior=13, disability=9,
        prop_all=33, need_all=45,
    )])
    once, _ = reconcile_blocks(apportion_state(bg_data, bg_index))
    twice, n = reconcile_blocks({k: dict(v) for k, v in once.items()})
    assert n == 0, f"reconcile is not idempotent: {n} blocks moved on the second pass"
    assert once == twice
    print("ok: reconcile_blocks is idempotent")


def test_reconcile_only_ever_clamps_downward_and_by_rounding_error():
    """The clamp must be a rounding repair, not a model. If it were moving people
    by more than the ±1 that independent rounding can introduce, it would be
    silently rewriting the estimator's output."""
    bg = "300010001006"
    blocks = _blocks_gdf([(f"{bg}{i:03d}", 10 - i, 3, 50) for i in range(8)])
    bg_index = build_bg_to_blocks_index(blocks)
    bg_data = pd.DataFrame([_bg_row(
        bg, pop=997, carless=131, lowinc=289, senior=157, disability=113,
        prop_all=377, need_all=601,
    )])
    before = apportion_state(bg_data, bg_index)
    after, _ = reconcile_blocks({k: dict(v) for k, v in before.items()})

    for g in before:
        for k in ATTR_KEYS:
            moved = after[g][k] - before[g][k]
            # A couple of people at most, per block, per column: pure rounding.
            assert abs(moved) <= 2, (g, k, before[g][k], after[g][k])
    # And the unions never go UP — the clamp tightens bounds, it does not invent.
    for k in UNION_KEYS:
        assert sum(after[g][k] for g in after) <= sum(before[g][k] for g in before)
    print("ok: reconcile moves counts only by rounding error, and only downward")


if __name__ == "__main__":
    test_schema_separates_estimates_from_counts()
    test_pop_weighted_conservation()
    test_rare_attribute_is_not_rounded_away()
    test_residence_columns_land_only_where_people_landed()
    test_housing_fallback_when_pop_zero()
    test_even_split_when_no_weights()
    test_reconcile_repairs_rounding_induced_violations()
    test_reconcile_is_idempotent()
    test_reconcile_only_ever_clamps_downward_and_by_rounding_error()
    print("\nAll coverage-pipeline apportionment / invariant tests passed.")
