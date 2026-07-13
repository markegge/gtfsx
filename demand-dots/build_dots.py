"""Build a synthetic population dot map for transit demand analysis.

ONE DOT = ONE PERSON. NOT ONE DOT PER (PERSON, CLASS).
─────────────────────────────────────────────────────
Every dot in the population universe is a PERSON carrying four BOOLEAN
MEMBERSHIP FLAGS, packed into a single integer `d` attribute:

    bit 1  carless       people in zero-vehicle households      (B25044)
    bit 2  low_income    people under 200% of the poverty line  (C17002)
    bit 4  senior        adults 65+                             (B01001)
    bit 8  disability    civilian adults 18+ with a disability  (C21007)

so `d` is 0-15 (0 = none of the four; 15 = all four), and one further code:

    d = 16  jobs         LODES WAC C000 — a WORKPLACE universe. A job is not a
                         person: it is never deduped against, mixed into, or
                         drawn from the residential population. It keeps its own
                         code and its own color, forever.

All of them live in ONE vector source-layer (`demand`), so the frontend filters
and colors client-side off ['get','d'] and never refetches a tile.

WHY THIS, AND NOT A CLASS PER SEGMENT (the bug this schema exists to kill)
─────────────────────────────────────────────────────────────────────────
The previous schema emitted a separate dot CLASS per segment (`carless`,
`low_income`, …) plus composites (`prop_all`, `need_all`) and backdrops
(`backdrop_prop`, `backdrop_need`). A carless low-income person was FOUR dots.
Worse, the backdrop was `population − composite`, so with the Carless segment
selected the map drew:

    carless (blue)  +  population − (carless ∪ low_income) (gray)

and the low-income-but-not-carless people — ~24% OF THE POPULATION — were drawn
NOWHERE. Nothing was double-counted, but a quarter of the town silently vanished
and a planner reading gray as "everyone else" was misled.

With flags on the dot, the UI RECOLORS instead of RECLASSING:

    segment selected     dots with that flag        → strong blue
                         dots in the composite but
                         WITHOUT that flag          → muted (the missing people)
                         everyone else              → gray
    ALL selected         any composite flag         → strong blue
                         everyone else              → gray

Every person is drawn EXACTLY ONCE in every view. Double-counting and vanishing
are now STRUCTURALLY IMPOSSIBLE rather than maintained by careful bookkeeping —
there is no representation of "the same person twice" left in the tiles.

The composites fall out of the flags at RENDER time, so they are no longer tile
classes at all:

    propensity composite = carless OR low_income
    need composite       = carless OR low_income OR senior OR disability

`prop_all`, `need_all`, `backdrop_prop` and `backdrop_need` are GONE from the
tiles. That also makes the archive much smaller: the old schema wrote ~2.65 dots
per person (both partitions, plus one per segment membership); this writes 1.

THE UNION IS STILL MEASURED, AND STILL BINDING
──────────────────────────────────────────────
Dropping the composite CLASSES did not drop the composite NUMBERS. The ACS
publishes MARGINALS at block group and no joint distribution below PUMA, so
"how many distinct people are carless OR low-income" is still an estimate — the
independence backbone × a PUMA correction measured from PUMS person records,
Fréchet-clamped (see puma_union.py, unchanged).

That union is now a CONSTRAINT on the flags rather than a class: the number of
dots with ANY flag set reproduces `need_all` exactly, and the number with a
propensity flag reproduces `prop_all` exactly. Which combination of flags each
dot gets is fitted from the PUMS-measured 16-cell JOINT distribution for that
block's PUMA (data/puma_joint.csv), not rolled independently — rolling
independently would silently reimpose the very independence assumption the
correction exists to remove. See joint_flags.py, which owns the fit and states
its limits honestly.

The predecessor of the union multiplied the sum of its marginals by an invented
0.6. The true factor was 0.824, so the headline number shipped 27% short. Do not
re-introduce a hand-picked dedup constant.

Race/ethnicity is DELIBERATELY EXCLUDED: it is not a transit-propensity
predictor, using it as one is ethically fraught, and the Title VI equity panel
already serves that need properly. Do not add a minority flag.

DENSITY IS ZOOM-SCALED — AND THE STRIDE MUST BE THE *ONLY* THINNING
───────────────────────────────────────────────────────────────────
"1 dot = N people" varies with zoom: coarse when zoomed out, fine when zoomed
in. Mapbox GL forbids ["zoom"] inside a filter expression, so this CANNOT be
done in the client — it has to be baked into the tiles. Every dot is stamped
with an ordinal and gets a per-feature `tippecanoe: {minzoom}` from
ZOOM_DENSITY_LADDER; the ladder is emitted into the legend so the frontend can
report the effective ratio for the zoom the user is actually at.

That only works if OUR stride is the only thing thinning the tiles. It wasn't.
tippecanoe drops features on its own in two ways, and both were silently
compounding on top of the ladder, so the legend stated a ratio the map did not
honor:

  --drop-rate (default 2.5, below --base-zoom)
        A GLOBAL geometric thinning applied in every tile, everywhere — nothing
        to do with tile size. With --base-zoom=12 it kept only 1/2.5^(12-z) of
        the dots that had no explicit per-feature minzoom. Measured over a fixed
        Missoula footprint, the z8 tiles carried 2% of what the legend claimed
        (1 dot ≈ 1,850 people, not the advertised 40). Now pinned to
        TIPPECANOE_DROP_RATE = 1 (no dropping) with --base-zoom=TILE_MIN_ZOOM,
        so there is no zoom below base zoom for it to apply to; and every
        feature carries an explicit minzoom, which is immune to it regardless.

  --drop-densest-as-needed (tile size / feature-count limits)
        A LOCAL thinning, only in tiles over the limit. It is kept as a safety
        net, but the ladder is now tuned so it never has to fire: see
        ZOOM_DENSITY_LADDER for the measurement that sized it.

verify_tiles.py re-decodes the built archive and proves retained == emitted for
every zoom and every tile code. Run it after every build; the legend's honesty is
a CHECKED property, not a hoped-for one.

ACS variables are fetched at block-group granularity and apportioned to blocks
by POP20 → HOUSING20 → ALAND20 → even split. LODES WAC is already block-level.
Block geometries come from TIGER/Line TABBLOCK20.

Usage:
    # Whole state (preferred for nationwide builds):
    uv run python build_dots.py --state MT --output dots_mt.ldjson --ldjson

    # Emit just the class/density legend the frontend reads (no build):
    uv run python build_dots.py --emit-legend ../tiles/demand-legend.json

    # Regenerate the PUMS-measured overlap table the estimator reads:
    uv run python build_puma_corrections.py

    # Single county (legacy):
    uv run python build_dots.py --county 30031 --output dots.geojson
"""

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

import geopandas as gpd
import numpy as np
import pandas as pd
import requests
import shapely
from shapely.geometry import Point

import joint_flags
import puma_union
from acs_vintage import census_key, resolve_latest_acs_year
from joint_flags import FLAG_BITS, FLAGS, N_CELLS

CENSUS_API_BASE = "https://api.census.gov/data"

# The ACS vintage is NOT hardcoded — acs_vintage.resolve_latest_acs_year()
# probes the Census API for the newest published 5-year release. The same module
# emits src/generated/acsVintage.ts, so the frontend reads the identical year.
# Regenerate that constant with: ./.venv/bin/python acs_vintage.py --emit

# Connecticut (FIPS 09) replaced its 8 counties with 9 "planning regions" as
# county-equivalents starting with the ACS 2022 5-yr release (county codes
# 110-190). But the 2020 census BLOCKS in TIGER/Line still carry the OLD county
# codes (001-015), so a current-vintage CT block-group GEOID can't prefix-match
# the blocks -> 0 apportioned blocks and CT ships with no population dots at all.
# Pin CT to the ACS 2021 5-yr (old counties), which does prefix-match the TIGER
# blocks. One year older for CT ONLY; every other state uses the probed year.
# (CT is the only state that did this.) Same pin as
# coverage-pipeline/build_coverage_blocks.py — keep them in sync.
ACS_YEAR_BY_STATE = {"09": 2021}


def acs_year(state_fips: str) -> int:
    """ACS 5-year vintage for a state: the newest published release, unless the
    state is pinned (see ACS_YEAR_BY_STATE). The probe is memoized."""
    pinned = ACS_YEAR_BY_STATE.get(state_fips)
    return pinned if pinned is not None else resolve_latest_acs_year()


def acs_dataset(state_fips: str) -> str:
    return f"{CENSUS_API_BASE}/{acs_year(state_fips)}/acs/acs5"


TIGER_YEAR = 2025
LODES_BASE = "https://lehd.ces.census.gov/data/lodes/LODES8"
# LODES WAC: probe downwards from this year until a file exists. LODES lags
# ACS/TIGER by ~2 years so the actual data year used will usually be older.
LODES_PROBE_START = 2024

CACHE_DIR = Path("cache")

# Zoom envelope of the published tileset. This is THE definition of it: the
# tippecanoe command that builds the archive is generated from these constants
# (tippecanoe_command() below, which build_all_states.sh calls), and the legend
# the frontend reads reports them. Nothing hand-types a zoom flag anywhere, so
# the three can no longer drift apart.
#
# They did drift, and it broke the layer. The legend declared max_zoom 16 while
# build_all_states.sh built `--maximum-zoom=15`; the frontend passed 16 to
# Mapbox as the source maxzoom, so from z16 in, Mapbox asked for z16 tiles that
# do not exist, got nothing back, and drew NOTHING — a blank layer at exactly
# the zoom a planner does stop-level work at. The source maxzoom has to be the
# DEEPEST ZOOM ACTUALLY BUILT: Mapbox then overzooms those tiles and the dots
# persist at z16, z17, z18…
#
# The old 16 came from `--extend-zooms-if-still-dropping`, which silently
# extended the pyramid past --maximum-zoom whenever tiles were still dropping.
# That flag is GONE: the ladder is now sized so nothing drops (see
# ZOOM_DENSITY_LADDER), which makes the built maxzoom deterministic and equal to
# TILE_MAX_ZOOM. verify_tiles.py asserts the built archive's header agrees.
TILE_MIN_ZOOM = 8
TILE_MAX_ZOOM = 15

# The published tileset archive these dots belong to. The frontend builds its
# tile URL as /_demand-tiles/<archive>/{z}/{x}/{y}.pbf and reads this name out of
# demand-legend.json — it will NOT guess, because guessing 404s every tile and
# paints a plausible-looking empty map. So: bump this whenever the tile schema
# changes (a us-2026d tile has a string `class`, not an integer `d`), publish
# under the new name, and the two move together.
#   us-2026b = the 10-class vocabulary with the invented x0.6 dedup
#   us-2026c = the 9-class PUMS-union vocabulary + the zoom-density ladder
#   us-2026d = ...with the ladder actually HONORED: no tippecanoe drop-rate, no
#              tile-size drops, z8-15 (see ZOOM_DENSITY_LADDER).
#   us-2026e = ATTRIBUTE DOTS. One dot per person carrying flag bits in `d`,
#              instead of one dot per (person, class) pair in `class`. The
#              composites and backdrops stop being classes and become render-time
#              expressions, so a us-2026d tile and a us-2026e tile share not one
#              attribute name or value — this is a schema change, not a reissue.
TILESET_ARCHIVE = "us-2026e"

# ─── The tile schema: ONE integer attribute, `d` ─────────────────────────────
#
# Population dots carry the bitwise OR of their flags (FLAG_BITS, imported from
# joint_flags — the module that owns the bit assignment and the joint fit that
# populates it). Jobs carry JOBS_CODE.
#
# A SINGLE PACKED INTEGER rather than four boolean properties, on purpose. In the
# MVT wire format a feature's properties cost a (key index, value index) varint
# pair EACH — so four booleans cost ~4x what one small integer does, per feature,
# across ~200M features. The values 0..16 all fit in one byte of varint and the
# key name is pooled once per layer, so `d` is very nearly free.
#
# The cost of packing is that Mapbox GL expressions have NO BITWISE OPERATORS: the
# frontend cannot ask for "dots where bit 1 is set". It doesn't have to — the set
# of codes matching any predicate over 4 flags is computable at build time and is
# at most 16 literals, so the frontend enumerates them into an ['in', …] filter
# and a ['match', …] color. demandCategories.ts does exactly that, from these same
# bit values, which it reads out of the legend.
TILE_ATTR = "d"
JOBS_CODE = 1 << len(FLAG_BITS)          # 16 — one past the population codes
POPULATION_CODES = list(range(N_CELLS))  # 0..15
TILE_CODES = [*POPULATION_CODES, JOBS_CODE]


# ─── The legend vocabulary: what the UI can NAME (not what the tiles carry) ───
#
# The tiles carry 17 integer codes. The UI does not name codes — it names the four
# FLAGS, the two COMPOSITES built from them, the backdrop, and jobs. Those are
# render-time roles now, so this table is legend metadata, not a tile schema:
# nothing here decides what goes into a tile except `per_dot`.
#
# `per_dot` — how many people (or jobs) one dot represents at FULL density (z15).
#             ONE number for every population dot, because a population dot is a
#             PERSON and people do not come in grains. (Under the old schema this
#             was a per-class field and had to be kept uniform by hand or the map
#             lied about relative density. It is now uniform by construction —
#             there is only one population universe left.) If the archive needs to
#             be smaller, move --density-scale or the zoom ladder.
#
# `minzoom` — GONE as a per-class concept, and its removal is a feature. The old
#             schema held the four segments back to z9 (OVERLAY_MINZOOM) because
#             they were extra dots competing for the tile budget; that meant
#             selecting "Carless" at z8 drew nothing. A flag is not an extra dot —
#             it rides on a person who is in the z8 tile anyway — so every segment
#             now works at every zoom the layer draws at, for free.
PEOPLE_PER_DOT = 5

# The four flags, in bit order. `modes` is the claim that a mode's composite
# CONTAINS this flag: senior/disability are need-only, and putting them in
# propensity would make a car-owning senior render as a likely rider. The
# frontend mirrors this as a compile-time type (PropensitySegment) and refuses to
# start if the two disagree.
FLAG_DEFS: dict[str, dict] = {
    "carless": {
        "bit": FLAG_BITS["carless"], "modes": ["propensity", "need"],
        "label": "Carless",
        "desc": "People in households with no vehicle available (B25044, scaled "
                "by the PUMA's measured zero-vehicle household size)",
    },
    "low_income": {
        "bit": FLAG_BITS["low_income"], "modes": ["propensity", "need"],
        "label": "Low income",
        "desc": "People below 200% of the federal poverty line (C17002)",
    },
    "senior": {
        "bit": FLAG_BITS["senior"], "modes": ["need"],
        "label": "Age 65+",
        "desc": "Adults aged 65 and over (B01001)",
    },
    "disability": {
        "bit": FLAG_BITS["disability"], "modes": ["need"],
        "label": "Civilian adults 18+ living with a disability (C21007)",
    },
}
# (the label/desc pair above must both exist — asserted below, because a missing
#  `desc` would ship an empty tooltip rather than fail)
FLAG_DEFS["disability"] = {
    "bit": FLAG_BITS["disability"], "modes": ["need"],
    "label": "Disability",
    "desc": "Civilian adults 18+ living with a disability (C21007)",
}

# The two composites, as flag sets. These are the ONLY definition of them left in
# the pipeline: they are not classes, not columns, not tiles. The frontend builds
# its filters from the same sets (via the legend) so the two cannot drift.
COMPOSITES: dict[str, list[str]] = {
    "propensity": ["carless", "low_income"],
    "need": ["carless", "low_income", "senior", "disability"],
}

UNITS: dict[str, dict] = {
    "population": {
        "per_dot": PEOPLE_PER_DOT, "unit": "people", "source": "acs",
        "label": "Residents",
        "desc": "One dot = one person (at full density), carrying their "
                "membership flags. Every resident is drawn exactly once.",
    },
    "jobs": {
        "per_dot": PEOPLE_PER_DOT, "unit": "jobs", "source": "lodes",
        "label": "Jobs",
        "desc": "All jobs at the workplace (LODES WAC C000). A workplace "
                "universe — never deduped against residents.",
    },
}

for _f, _d in FLAG_DEFS.items():
    assert _d.get("label") and _d.get("desc"), f"flag {_f} needs a label and a desc"
assert set(FLAG_DEFS) == set(FLAGS), "FLAG_DEFS must cover exactly joint_flags.FLAGS"
assert all(set(v) <= set(FLAG_DEFS) for v in COMPOSITES.values())
for _mode, _segs in COMPOSITES.items():
    for _s in _segs:
        assert _mode in FLAG_DEFS[_s]["modes"], (
            f"{_s} is in the {_mode} composite but its modes say otherwise")

# ─── Block-group attributes (the ACS fetch + the union estimator) ─────────────
#
# These are NOT dot classes any more — they are the CONSTRAINTS the flag fit is
# solved against (joint_flags.fit). The union columns stay exactly as they were,
# produced by exactly the same estimator: dropping the composite tile classes did
# not drop the composite numbers.
POP_KEY = "total_pop"
MARGINALS = list(FLAGS)                      # carless, low_income, senior, disability
UNIONS = ["prop_all", "need_all"]
BACKDROPS = {"prop_all": "backdrop_prop", "need_all": "backdrop_need"}

# Every column the derived block-group CSV carries (== puma_union.reconcile keys).
ACS_ATTRS = [POP_KEY, *MARGINALS, *UNIONS, *BACKDROPS.values()]

# Apportioned block group -> block. The backdrops are NOT apportioned — they are
# re-derived from (pop - union) at BLOCK level, after the split, because rounding
# each column independently would otherwise leave `union + backdrop != total_pop`
# in a block here and there.
APPORTION_KEYS = [POP_KEY, *MARGINALS, *UNIONS]


# ─── Zoom-scaled dot density ─────────────────────────────────────────────────
#
# "1 dot = N people" has to get coarser as you zoom out: at z8 a state is a few
# hundred pixels across and every dot in it lands on top of every other one.
#
# This CANNOT be done in the client. Mapbox GL rejects ["zoom"] inside a filter
# expression (it is only legal at the top level of a paint/layout property), so
# there is no way to say "draw every 128th dot at z8" from the style. It has to
# be baked into the tiles: each dot carries an ordinal, and its per-feature
# `tippecanoe.minzoom` comes from that ordinal's slot in this ladder. A feature
# with minzoom 10 is simply not written into the z8 and z9 tiles — which also
# makes the low-zoom tiles substantially smaller.
#
# The strides must form a nesting chain (each divides the one before it): that
# is what makes the z8 dots a SUBSET of the z9 dots, so dots never pop out of
# existence as you zoom IN. Asserted below.
#
#   zoom   stride   effective ratio (at PEOPLE_PER_DOT = 5)
#   8      128      1 dot = 640 people
#   9      64       1 dot = 320
#   10     32       1 dot = 160
#   11     16       1 dot = 80
#   12     8        1 dot = 40
#   13     4        1 dot = 20
#   14     2        1 dot = 10
#   15     1        1 dot = 5 people   (full density; overzoomed at z16+)
#
# WHY THESE NUMBERS — the ladder is sized so tippecanoe never has to drop
# ─────────────────────────────────────────────────────────────────────────────
# The stride is only an honest ratio if it is the ONLY thinning. Whenever a tile
# goes over --maximum-tile-bytes / --maximum-tile-features, --drop-densest-as-
# needed thins THAT tile on top of the stride, and the legend's number quietly
# becomes fiction in whatever city the user happens to be looking at.
#
# So the ladder is sized against the DENSEST TILE IN THE COUNTRY, not against a
# comfortable one. Measured (every state's dots binned into web-mercator tiles;
# see the report in the ladder-fix change) at 5.0 bytes/feature, the full-density
# feature count of the worst tile in the US is:
#
#     z8  10.1M    z9  9.4M    z10  5.0M    z11  2.8M    z12  1.2M    z13  0.47M
#
# (all of them Manhattan/Midtown, where ~900k residents and ~2M jobs land in one
# z12 tile). The tile carries ~3 dots per person — the propensity partition, the
# need partition, and the four segments — plus jobs, so those are big numbers.
#
# With the OLD ladder (8,4,2,2,1) the worst z8 tile came out at 1.27M features /
# 6.3 MB against a 500 KB limit. tippecanoe therefore thinned it — and it thinned
# the z8 tile of every metro in the country: 59% OF THE US POPULATION lived in a
# z8 tile that got dropped. The legend was fiction for most Americans.
#
# This ladder is the shallowest nesting chain under which NO tile in the country
# exceeds the limits below — 0 over-budget tiles at every zoom, worst tile
# 177k features / 0.89 MB (Manhattan, z11). Nothing drops, so the legend is
# honest BY CONSTRUCTION, and verify_tiles.py proves it after each build.
#
# The cost is real and worth stating: full density (1:5) now arrives at z15
# rather than z12, so a rural city at z12 draws 8x fewer dots than the old
# (over-claimed) tiles did. That is the price of a true number — a shallower
# ladder cannot be honored in any dense metro. If this is ever retuned, retune
# it against the same measurement, and re-run verify_tiles.py.
ZOOM_DENSITY_LADDER: dict[int, int] = {
    8: 128, 9: 64, 10: 32, 11: 16, 12: 8, 13: 4, 14: 2, 15: 1,
}
FULL_DENSITY_ZOOM = max(ZOOM_DENSITY_LADDER)

# ─── tippecanoe: the flags the archive is actually built with ────────────────
#
# Generated into the build command by tippecanoe_command(), so the runbook and
# build_all_states.sh cannot hand-type a zoom that disagrees with the legend.
#
# TIPPECANOE_DROP_RATE = 1 is the fix for the big lie. tippecanoe's DEFAULT of
# 2.5 thins every tile below --base-zoom by 1/2.5 per zoom level — a global
# thinning that has nothing to do with tile size and that the legend knew nothing
# about. --base-zoom is pinned to TILE_MIN_ZOOM as well, so there is no zoom
# below base zoom for a drop rate to apply to even if someone changes it back.
TIPPECANOE_DROP_RATE = 1
# Headroom over the 0.89 MB worst tile the ladder allows, so the model's ~20%
# uncertainty (it is calibrated from one state's floor-rounding loss) cannot push
# a real tile over the limit and silently reintroduce dropping. These are CAPS,
# not targets: the archive's actual tiles are far below them.
TIPPECANOE_MAX_TILE_BYTES = 1_500_000
TIPPECANOE_MAX_TILE_FEATURES = 300_000


def _validate_ladder() -> None:
    zs = sorted(ZOOM_DENSITY_LADDER)
    assert zs[0] == TILE_MIN_ZOOM, "the ladder must start at the tileset minzoom"
    assert zs[-1] <= TILE_MAX_ZOOM, (
        f"the ladder reaches full density at z{zs[-1]}, deeper than the deepest "
        f"zoom built (z{TILE_MAX_ZOOM}) — the tiles would never carry every dot, "
        "so the legend's full-density ratio would name a zoom that does not exist")
    strides = [ZOOM_DENSITY_LADDER[z] for z in zs]
    assert strides[-1] == 1, "the ladder must reach full density"
    for a, b in zip(strides, strides[1:]):
        assert b <= a and a % b == 0, (
            f"ladder strides must be a non-increasing nesting chain; {a} -> {b} "
            "is not, so a dot visible at one zoom would vanish at the next")


def tippecanoe_command(inputs: str = "../tiles/ldjson/*.ldjson",
                       output: str | None = None) -> str:
    """The exact tippecanoe invocation the published archive is built with.

    Generated from the constants above rather than written out in the runbook, so
    the zoom envelope in the tiles, in the legend and in the build script are one
    number. (They weren't: the legend said z16, the script built z15, and the
    frontend asked Mapbox for a z16 tile that has never existed — a blank layer
    from z16 in.)
    """
    out = output or f"../tiles/{TILESET_ARCHIVE}.pmtiles"
    return (
        f"cat {inputs} | tippecanoe --output={out} \\\n"
        f"    --layer=demand --minimum-zoom={TILE_MIN_ZOOM} "
        f"--maximum-zoom={TILE_MAX_ZOOM} \\\n"
        # No drop-rate thinning: our stride IS the density ladder (see above).
        f"    --drop-rate={TIPPECANOE_DROP_RATE} --base-zoom={TILE_MIN_ZOOM} \\\n"
        f"    --maximum-tile-bytes={TIPPECANOE_MAX_TILE_BYTES} "
        f"--maximum-tile-features={TIPPECANOE_MAX_TILE_FEATURES} \\\n"
        # Safety net only. The ladder is sized so this never fires; verify_tiles.py
        # fails the build if it ever does, rather than letting the legend lie.
        f"    --drop-densest-as-needed \\\n"
        f"    --read-parallel --force"
    )


_validate_ladder()


def _ladder_slots() -> list[int]:
    """ordinal % period -> the minzoom that ordinal is first written at.

    Slot r goes to the coarsest zoom whose stride divides r, so exactly
    1/stride(z) of all ordinals are present at zoom z, and the sets nest.
    """
    period = max(ZOOM_DENSITY_LADDER.values())
    zs = sorted(ZOOM_DENSITY_LADDER)
    return [next(z for z in zs if r % ZOOM_DENSITY_LADDER[z] == 0)
            for r in range(period)]


LADDER_SLOTS = _ladder_slots()
LADDER_PERIOD = len(LADDER_SLOTS)


def zoom_stride(zoom: int) -> int:
    """The people-per-dot multiplier in force at a given zoom."""
    if zoom >= FULL_DENSITY_ZOOM:
        return 1
    return ZOOM_DENSITY_LADDER.get(zoom, ZOOM_DENSITY_LADDER[TILE_MIN_ZOOM])


def unit_per_dot(unit: str, scale: float = 1.0) -> int:
    """People per population dot / jobs per job dot, after --density-scale.

    Two universes, one grain each. There is no per-CLASS grain any more and there
    must not be one again: a population dot is a person, and mixing grains inside
    the population would make the map lie about relative density (a 1:15 segment
    over a 1:5 backdrop draws a poor neighbourhood as if two thirds of it were
    not poor). The old schema had to keep nine per_dot values equal by hand.
    """
    return max(1, int(round(UNITS[unit]["per_dot"] * scale)))


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
#
# One table per concept, all available AT BLOCK GROUP. That last part is not a
# given and it is worth stating why these tables and not the obvious ones:
#
#   disability — C21007, NOT B18101/B18105/C18108. The B18xxx family and C18108
#     are published at TRACT and above ONLY. Ask the API for them at block group
#     and it does not error: it returns rows with NULLs, which coerce to zero and
#     ship as a silently empty class. C21007 ("Age by Veteran Status by Poverty
#     Status by Disability Status, civilian population 18+") IS block-group
#     available; its universe is civilian, 18+, poverty-determined, and
#     puma_union's PUMS flags reproduce exactly that universe so the correction
#     table is measured against the same concept the tiles carry.
#
#   carless — B25044 counts HOUSEHOLDS with no vehicle, not people. The shipped
#     pipeline turned it into people by multiplying by B25010, the block group's
#     AVERAGE household size (~2.43) — but a zero-vehicle household is not an
#     average household. It is much smaller: 1.80 persons nationally, so the
#     class over-counted by ~35%. It is now scaled by the PUMA's own measured
#     zero-vehicle household size (puma_union / data/puma_corrections.csv).
#
#   low_income — C17002 is a poverty-status universe, which EXCLUDES people for
#     whom poverty status is not determined (institutional GQ, dorms, barracks).
#     Do not "fix" that by scaling a share up to the total population; that is
#     the bug that made the old `renter` class over-count by 11.5%.
#
# B03002 (race/ethnicity) is fetched by the coverage builder for the Title VI
# panel; it is deliberately NOT fetched here (see the module docstring).

ACS_TOTAL_POP = "B01001_001E"
ACS_NO_VEHICLE_NUM = ["B25044_003E", "B25044_010E"]   # owner + renter, no vehicle
ACS_LOW_INCOME_NUM = [
    "C17002_002E", "C17002_003E", "C17002_004E",
    "C17002_005E", "C17002_006E", "C17002_007E",      # < 2.00 x poverty
]
ACS_SENIOR_NUM = [
    "B01001_020E", "B01001_021E", "B01001_022E",
    "B01001_023E", "B01001_024E", "B01001_025E",                 # male 65+
    "B01001_044E", "B01001_045E", "B01001_046E",
    "B01001_047E", "B01001_048E", "B01001_049E",                 # female 65+
]
ACS_DISABILITY_NUM = [
    # C21007 "with a disability" cells, across the 8 age x veteran x poverty
    # branches of the table. Summing the branches gives the whole 18+ civilian
    # disabled population of the block group.
    "C21007_005E", "C21007_008E", "C21007_012E", "C21007_015E",
    "C21007_020E", "C21007_023E", "C21007_027E", "C21007_030E",
]

ACS_VARS = [
    ACS_TOTAL_POP,
    *ACS_NO_VEHICLE_NUM,
    *ACS_LOW_INCOME_NUM,
    *ACS_SENIOR_NUM,
    *ACS_DISABILITY_NUM,
]

# Bump when the DERIVATION below changes in a way that invalidates cached CSVs
# but the raw variable list does not (e.g. retuning the union estimator).
# The cache key hashes this together with ACS_VARS, the class list AND the
# content of data/puma_corrections.csv — so adding a variable, adding a class or
# regenerating the corrections all bust the cache on their own, which is the
# whole point: a stale cache from the old vocabulary would otherwise be silently
# reused and every new class would come back as zeros.
#   v3 = the PUMS-derived union vocabulary (was: the invented x0.6 composite)
#   v4 = attribute dots: the union columns survive unchanged, but they are now
#        CONSTRAINTS on a 16-cell flag fit rather than classes of their own, and
#        the joint table joins the cache key (see puma_union.corrections_hash).
DERIVED_VERSION = 4


def _acs_cache_key() -> str:
    """Short hash of everything that determines the shape/content of a cached
    ACS CSV: the requested variables, the derived columns, the PUMS-derived
    tables (corrections AND the 16-cell joint), and the derivation version."""
    payload = "|".join([
        ",".join(ACS_VARS),
        ",".join(ACS_ATTRS),
        puma_union.corrections_hash(),
        str(DERIVED_VERSION),
    ])
    return hashlib.sha1(payload.encode()).hexdigest()[:8]


def _census_api_get(dataset_url: str, get_vars: list[str], geo: dict) -> pd.DataFrame:
    params = {"get": ",".join(get_vars)}
    params.update(geo)
    # Same key resolution as the vintage probe: CENSUS_API_KEY, else the repo .env.
    api_key = census_key()
    if api_key:
        params["key"] = api_key
    resp = requests.get(dataset_url, params=params)
    resp.raise_for_status()
    # A missing/invalid key or a bad variable name returns an HTML error page
    # (200 OK, text/html), not JSON. Surface it instead of a deep JSONDecodeError.
    if "json" not in resp.headers.get("content-type", "").lower():
        first = " ".join(resp.text.split())[:200]
        raise RuntimeError(
            f"Census API returned non-JSON (check CENSUS_API_KEY and the variable "
            f"list). Got: {first}"
        )
    data = resp.json()
    return pd.DataFrame(data[1:], columns=data[0])


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    """Numeric column with Census negative sentinels (-666666666, -999999999 …)
    coerced to 0. A missing column yields zeros."""
    if col not in df.columns:
        return pd.Series(0.0, index=df.index)
    vals = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return vals.where(vals >= 0, 0)


def _sum(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    return sum((_num(df, c) for c in cols), start=pd.Series(0.0, index=df.index))


def _compute_acs_derived(df: pd.DataFrame) -> pd.DataFrame:
    """Derive one integer column per ACS-sourced dot class from the raw vars.

    The four marginals come straight out of the tables. The two unions do NOT —
    they are estimated per block group from that block group's PUMA overlap
    structure and then Fréchet-clamped, which is what makes every downstream
    invariant hold. See puma_union.
    """
    total_pop = _num(df, ACS_TOTAL_POP)

    # PUMA-specific parameters, joined block group -> tract -> PUMA (an exact
    # nesting, not a spatial approximation).
    params = puma_union.puma_params(df["GEOID"])

    # People in zero-vehicle households = 0-veh HOUSEHOLDS x the size of a
    # zero-vehicle household in this PUMA (~1.8, NOT the ~2.43 average household
    # size the old pipeline used — see the note on ACS_NO_VEHICLE_NUM).
    zero_veh_hh = _sum(df, ACS_NO_VEHICLE_NUM)
    carless = zero_veh_hh * params["hh_size_carless"].to_numpy()

    low_income = _sum(df, ACS_LOW_INCOME_NUM)
    senior = _sum(df, ACS_SENIOR_NUM)
    disability = _sum(df, ACS_DISABILITY_NUM)

    cls = puma_union.estimate(
        total_pop.to_numpy(), carless.to_numpy(), low_income.to_numpy(),
        senior.to_numpy(), disability.to_numpy(),
        params["c_prop"].to_numpy(), params["c_need"].to_numpy(),
    )
    violations = puma_union.check_invariants(cls)
    if violations:
        raise AssertionError(
            "block-group invariants violated by the union estimator: "
            + "; ".join(violations))

    out = pd.DataFrame({"GEOID": df["GEOID"], **{k: v for k, v in cls.items()}})
    for col in ACS_ATTRS:
        out[col] = out[col].round().clip(lower=0).astype(int)
    return out[["GEOID", *ACS_ATTRS]]


def _fetch_bg(state_fips: str, cache_file: Path, geo: dict, what: str) -> pd.DataFrame:
    if cache_file.exists():
        print(f"  Using cached ACS block group data: {cache_file}")
        return pd.read_csv(cache_file, dtype={"GEOID": str})
    year = acs_year(state_fips)
    note = " (pinned: CT planning-region transition)" if state_fips in ACS_YEAR_BY_STATE else ""
    print(f"  Fetching ACS {year} 5-yr block group data "
          f"({len(ACS_VARS)} vars, {what}){note}...")
    df = _census_api_get(acs_dataset(state_fips), ACS_VARS, geo)
    df["GEOID"] = df["state"] + df["county"] + df["tract"] + df["block group"]
    result = _compute_acs_derived(df)
    result.to_csv(cache_file, index=False)
    print(f"  Cached ACS data: {len(result)} block groups")
    return result


def fetch_block_group_data_county(state_fips: str, county_fips: str) -> pd.DataFrame:
    year = acs_year(state_fips)
    cache_file = cache_path(f"acs{year}_v{_acs_cache_key()}_bg_{state_fips}_{county_fips}.csv")
    return _fetch_bg(
        state_fips, cache_file,
        {"for": "block group:*", "in": f"state:{state_fips} county:{county_fips}"},
        f"county {state_fips}{county_fips}",
    )


def fetch_block_group_data_state(state_fips: str) -> pd.DataFrame:
    """Fetch ACS block group data for an entire state in one API call."""
    year = acs_year(state_fips)
    cache_file = cache_path(f"acs{year}_v{_acs_cache_key()}_bg_state_{state_fips}.csv")
    # ACS requires county:* alongside block group:* in the state-wide query.
    return _fetch_bg(
        state_fips, cache_file,
        {"for": "block group:*", "in": f"state:{state_fips} county:*"},
        f"state {state_fips}",
    )


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
        # AK and PR don't publish LODES WAC. Return empty so the jobs layer
        # is just absent for these; population dots still work.
        print(f"  No LODES WAC for {abbr.upper()} — continuing with no jobs data")
        empty = pd.DataFrame({"w_geocode": pd.Series(dtype=str),
                              "total_jobs": pd.Series(dtype=int)})
        cache_file = cache_path(f"lodes_wac_state_{state_fips}_EMPTY.csv")
        empty.to_csv(cache_file, index=False)
        return empty

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


def _block_weights(bg_blocks: pd.DataFrame) -> np.ndarray:
    """Per-block share of its block group.

    Weight preference: POP20 (actual 2020 decennial population per block) →
    HOUSING20 (housing unit count) → ALAND20 (land area) → even split.
    Using population instead of land area is a huge accuracy win in rural areas,
    where a single empty 500 km² block otherwise absorbs half the block group's
    residents. Same chain as coverage-pipeline/build_coverage_blocks.py.
    """
    for col in ("POP20", "HOUSING20", "ALAND20"):
        if col in bg_blocks.columns:
            total = bg_blocks[col].sum()
            if total > 0:
                return bg_blocks[col].to_numpy() / total
    n = len(bg_blocks)
    return np.full(n, 1.0 / n)


def apportion_bg_to_blocks(
    bg_geoid: str,
    bg_attrs: dict[str, float],
    bg_index: dict[str, pd.DataFrame],
) -> list[tuple[str, dict[str, int]]]:
    """Distribute one block group's attributes across its constituent blocks.

    Generalized to N attributes: the per-block fraction is computed once from
    the weight chain and applied to every attribute, so all classes are
    apportioned identically (and consistently with the coverage pipeline).
    """
    bg_blocks = bg_index.get(bg_geoid)
    if bg_blocks is None or len(bg_blocks) == 0:
        return []
    weights = _block_weights(bg_blocks)
    geoids = bg_blocks["GEOID_BLOCK"].to_numpy()
    return [
        (geoids[i], {k: max(0, int(round(v * weights[i]))) for k, v in bg_attrs.items()})
        for i in range(len(bg_blocks))
    ]


# Bump when the BG->block split changes in a way that changes the dots (it is
# folded into config_hash, so build_all_states.sh rebuilds instead of reusing
# a state whose .ldjson was apportioned by the old method).
#   v2 = largest-remainder (was: independent np.rint per class, which lost
#        5.7% of Montana's carless population to rounding)
#   v3 = attribute dots. BG->block is now an EXACT FLOAT split of the 16 flag
#        cells (nothing rounds there at all), and the single rounding step —
#        a block's dot budget across its 16 cells — is unbiased randomized
#        apportionment, NOT largest-remainder. See _apportion_dots.
APPORTION_VERSION = 3


def _apportion_dots(budget: int, shares: np.ndarray,
                    rng: np.random.Generator) -> np.ndarray:
    """Split a block's `budget` of dots across the 16 flag cells by `shares`.

    Conserves the budget EXACTLY (Σ out == budget) and is UNBIASED in every cell
    (E[out_c] == budget × shares_c). Both properties are required, and getting
    only the first is a trap that this pipeline fell into.

    WHY NOT LARGEST REMAINDER — it is BIASED HERE, and badly.
    ────────────────────────────────────────────────────────
    Largest-remainder (Hamilton) is the right tool for apportioning ONE quantity
    across MANY units, which is what the block-group→block split used it for: the
    remainders vary from block to block, so over a state the leftovers land
    fairly. It is the WRONG tool for splitting one block's dots across 16 cells
    whose shares are FIXED and wildly unequal, because then the same cells are
    small in every single block and they lose the leftovers every single time.

    Concretely: a block of 125 people gets 25 dots. The no-flags cell (~55% of
    people) wants 13.75 dots and the carless-only cell (~1.7%) wants 0.42. Floors
    hand out 13 and 0; the leftovers go to the biggest remainders, and 0.75 beats
    0.42 in that block, and in the next block, and in every block, forever. The
    rare cells are systematically starved and the common ones systematically fed.

    Measured, on Gallatin County, with largest-remainder here:
        carless      -50.7%      disability   -31.9%
        low_income    -6.6%      senior       -10.0%
    Every flag under-counted, the rarest ones catastrophically — a map whose
    "Carless" layer draws half the carless people it says it does. The totals all
    balanced perfectly, which is exactly why it would have shipped.

    WHAT THIS DOES INSTEAD — systematic (Cox) randomized apportionment.
    Walk the cumulative wanted-dots line and cut it at integer boundaries offset
    by ONE seeded uniform draw:

        cum   = cumsum(shares × budget)          (ends exactly at budget)
        out_c = floor(cum_c - u) - floor(cum_{c-1} - u)

    Each cell gets floor(v_c) or ceil(v_c), with the fractional part decided by
    where the cut lands, so E[out_c] = v_c exactly — no cell is ever
    systematically rounded down. The cuts are shared across all 16 cells rather
    than drawn independently, so the budget still comes back exact AND the
    variance is far below an independent multinomial draw.
    """
    if budget <= 0:
        return np.zeros(len(shares), dtype=np.int64)
    v = np.asarray(shares, dtype=np.float64) * budget
    # Guard the cumulative endpoint against float drift: it must land on `budget`
    # or the last cell inherits the error.
    cum = np.cumsum(v)
    cum[-1] = float(budget)
    u = float(rng.random())
    edges = np.floor(cum - u) + 1.0
    out = np.diff(np.concatenate(([0.0], edges))).astype(np.int64)
    return np.maximum(out, 0)


def fit_bg_cells(bg_data: pd.DataFrame) -> tuple[np.ndarray, dict]:
    """Turn each BLOCK GROUP's marginals + unions into 16 FLAG-CELL counts.

    This is where a dot stops being a class and becomes a person: the PUMS-
    measured joint for the block group's PUMA is fitted (IPF) to that block
    group's own ACS marginals and to both PUMS-derived unions, so

        Σ cells with flag f   == the block group's ACS marginal for f
        Σ cells with any flag == its need_all   (nobody vanishes)
        Σ all 16 cells        == its total_pop  (nobody is invented)

    FIT AT BLOCK GROUP, NOT AT BLOCK. The block group is the geography the ACS
    actually publishes: its marginals are DATA. A block's marginals are an
    artifact of our own apportionment — so fitting a joint distribution to them
    would be fitting to our own rounding, and would spend most of its effort on
    the degenerate 4-person blocks that rounding creates (where the answer is
    forced by arithmetic and there is no correlation structure left to fit). It
    is also ~150x fewer rows, which is what makes a tight tolerance affordable.

    The joint is then apportioned DOWN to blocks (apportion_state_dots), exactly
    as the marginals used to be — the same weight chain, applied to 16 columns
    instead of 7.
    """
    seed = joint_flags.seed_for_blocks(bg_data["GEOID"].to_numpy())
    cells, diag = joint_flags.fit(
        *(bg_data[k].to_numpy() for k in
          (POP_KEY, "carless", "low_income", "senior", "disability", *UNIONS)),
        seed,
    )
    return cells, diag


def apportion_state_dots(
    bg_data: pd.DataFrame,
    bg_cells: np.ndarray,
    bg_index: dict[str, pd.DataFrame],
) -> tuple[np.ndarray, np.ndarray]:
    """Apportion the 16 FLAG CELLS from block group down to block.

    Returns (block GEOIDs, (n_blocks, 16) float people-per-cell).

    APPORTIONING THE JOINT, NOT THE MARGINALS, is what makes every invariant hold
    EXACTLY and by construction rather than by clamping:

      • a block's cells are its block group's cells times one scalar weight, so
        they are non-negative and sum to the block's population;
      • therefore the block's marginals, both unions, and the backdrop are all
        roll-ups of a REAL SET SYSTEM. `carless <= prop_all <= need_all <= pop`
        and every Fréchet bound hold because they describe actual people in
        actual cells — not because anything clipped them;
      • and the weights sum to 1 within each block group, so the state's totals
        come back to the ACS totals EXACTLY.

    These are FLOATS on purpose. The old code apportioned each marginal to
    integers with largest-remainder, which was there to stop `np.rint` silently
    dropping small classes (it cost Montana 5.7% of its carless population). But
    integers at block level were only ever needed because a dot count was derived
    per class, per block. A dot count is now derived ONCE per block, from its
    population — so the only place rounding can happen is the dot allocation
    itself (iter_dot_features's call to _apportion_dots), which conserves the
    block's dot budget exactly via systematic (Cox) randomized apportionment, not
    largest-remainder — largest-remainder is biased for a 16-cell split with
    fixed, wildly unequal shares, and starves the rare cells in every block.
    Rounding twice was the bug; this rounds once.
    """
    geoid_col = bg_data["GEOID"].to_numpy()
    geoid_parts: list[np.ndarray] = []
    cell_parts: list[np.ndarray] = []
    for i in range(len(bg_data)):
        bg_blocks = bg_index.get(geoid_col[i])
        if bg_blocks is None or len(bg_blocks) == 0:
            continue
        weights = _block_weights(bg_blocks)          # sums to 1
        geoid_parts.append(bg_blocks["GEOID_BLOCK"].to_numpy())
        cell_parts.append(weights[:, None] * bg_cells[i][None, :])

    if not geoid_parts:
        return np.array([], dtype=object), np.zeros((0, N_CELLS))
    return np.concatenate(geoid_parts), np.vstack(cell_parts)


def random_points_in_polygon(polygon, n: int, rng: np.random.Generator) -> np.ndarray:
    """Rejection-sample n points inside polygon, with a hard attempt cap.

    Returns an (m, 2) float array of lon/lat, m <= n. For very elongated /
    low-acceptance polygons we'd otherwise loop forever, so attempts are capped
    at max(5000, n * 10). Any shortfall just means fewer dots for that block —
    at map scale a block with 30 dots looks the same as 28, and unbounded
    retries blocked the nationwide build on CA.

    Uses shapely's vectorized contains_xy, which accepts/rejects candidates in
    exactly the draw order the old per-Point loop did — so for a given RNG state
    the output is bit-identical to the scalar implementation.
    """
    if n <= 0 or polygon.is_empty:
        return np.empty((0, 2))
    minx, miny, maxx, maxy = polygon.bounds
    max_attempts = max(5000, n * 10)
    attempts = 0
    kept: list[np.ndarray] = []
    have = 0
    while have < n and attempts < max_attempts:
        batch_size = min((n - have) * 4, 5000)
        xs = rng.uniform(minx, maxx, batch_size)
        ys = rng.uniform(miny, maxy, batch_size)
        attempts += batch_size
        mask = shapely.contains_xy(polygon, xs, ys)
        if mask.any():
            pts = np.column_stack((xs[mask], ys[mask]))
            kept.append(pts)
            have += len(pts)
    if not kept:
        return np.empty((0, 2))
    return np.vstack(kept)[:n]


# Coordinate precision written to the ldjson. 6 decimal degrees is ~11 cm; a z15
# tile cell is ~30 cm, so this is well below anything tippecanoe can represent
# and it shrinks the intermediate ldjson (and therefore tippecanoe's read time)
# by roughly a third with zero effect on the output tiles.
COORD_PRECISION = 6


def iter_dot_features(
    blocks_gdf: gpd.GeoDataFrame,
    block_cells: dict[str, np.ndarray],
    block_jobs: dict[str, int],
    per_dot: dict[str, int],
    want_population: bool = True,
    want_jobs: bool = True,
    rounding: str = "stochastic",
) -> Iterator[dict]:
    """Yield GeoJSON Feature dicts one at a time; does not build a full list.

    Every feature goes into the single `demand` layer with one integer property,
    `d`: a population dot's flag bitmask (0-15), or JOBS_CODE (16).

    HOW A BLOCK'S PEOPLE BECOME DOTS
    ────────────────────────────────
    The block arrives as 16 CELL COUNTS that already sum to its population (see
    fit_block_cells). Turning them into dots is a two-step that is deliberately
    NOT "round each cell independently":

      1. the block's DOT BUDGET is drawn once, from its population:
             n = pop // per_dot,  +1 with probability (pop % per_dot) / per_dot
         so the number of dots is right in expectation for the block as a whole.
      2. that budget is split across the 16 cells by _apportion_dots — systematic
         (Cox) randomized apportionment, NOT largest remainder. Largest remainder
         is biased here: the same cells are small in every block (no-flags is
         common, carless-only is rare), so the common cell wins the leftover unit
         every time and the rare ones are starved for good. See _apportion_dots
         for the measured damage and the fix.

    Rounding the 16 cells independently would let a block's dots sum to more or
    fewer than its population dots, which is exactly the class of error this
    redesign exists to eliminate. This way `Σ dots == the block's dot budget`
    EXACTLY, every time: a person cannot be drawn twice and cannot vanish, at the
    dot level and not merely at the people level.

    PER-FEATURE MINZOOM — the zoom-density ladder.
    Each CODE keeps its own running ordinal, and the ordinal's slot in
    ZOOM_DENSITY_LADDER sets the earliest zoom that dot may appear at. Every
    128th dot is in the z8 tiles, every 64th in z9, … all of them from z15. So
    "1 dot = N people" scales with zoom — which cannot be done in the client,
    because Mapbox GL forbids ["zoom"] inside a filter. Striding per CODE (rather
    than over the population as a whole) is what keeps the flag mix intact at
    every zoom: each cell is thinned by the same factor, so the z8 sample has the
    same carless share as the z15 one, and the legend is true at both.

    There is no class-gating minzoom any more. A flag rides on a person who is in
    the z8 tile regardless, so every segment is selectable at every zoom the
    layer draws at — the old schema's segments simply did not exist below z9.

    Rounding (count -> number of dots) matters more than it looks:

      'floor'       n = pop // per_dot. It silently DISCARDS the remainder in
                    every block, so a block of 4 people at 1:5 contributes
                    nothing. The loss is proportional to per_dot and to how small
                    the blocks are, which biases hard against RURAL states.
      'stochastic'  n = floor(q) + 1 with probability frac(q). The dot count is
                    then correct IN EXPECTATION for every block, so "1 dot = N
                    people" is true everywhere instead of only in dense blocks.
                    The default. It uses its OWN RNG stream, so dot placement
                    stays identical to a floor build for whatever dots do emit.
    """
    rng = np.random.default_rng(42)
    round_rng = np.random.default_rng(1337)
    cell_rng = np.random.default_rng(2718)     # largest-remainder tie-breaks only
    stochastic = rounding == "stochastic"
    ordinal = {code: 0 for code in TILE_CODES}
    total_blocks = len(blocks_gdf)
    t0 = time.time()

    def _dot_budget(count: int, grain: int) -> int:
        q, rem = divmod(int(count), grain)
        return q + (1 if stochastic and round_rng.random() < rem / grain else 0)

    for i, block in enumerate(
        blocks_gdf[["GEOID_BLOCK", "geometry"]].itertuples(index=False, name="Block")
    ):
        if i and i % 10000 == 0:
            elapsed = time.time() - t0
            rate = i / elapsed
            eta = (total_blocks - i) / rate if rate > 0 else 0
            print(f"    block {i:,}/{total_blocks:,} ({i*100/total_blocks:.1f}%)"
                  f"  rate={rate:.0f}/s  eta={eta:.0f}s", flush=True)
        geoid = block.GEOID_BLOCK
        geom = block.geometry
        if geom is None or geom.is_empty:
            continue

        n_by_code: list[tuple[int, int]] = []
        total_needed = 0

        if want_population:
            cells = block_cells.get(geoid)
            if cells is not None:
                pop = float(cells.sum())
                budget = _dot_budget(round(pop), per_dot["population"]) if pop > 0 else 0
                if budget > 0:
                    # Split the budget across the 16 cells: exact total, and
                    # unbiased in every cell (largest-remainder is NOT — it
                    # starves the rare flag combinations; see _apportion_dots).
                    alloc = _apportion_dots(budget, cells / pop, cell_rng)
                    for code in POPULATION_CODES:
                        n = int(alloc[code])
                        if n:
                            n_by_code.append((code, n))
                            total_needed += n

        if want_jobs:
            jobs = block_jobs.get(geoid, 0)
            if jobs > 0:
                n = _dot_budget(jobs, per_dot["jobs"])
                if n:
                    n_by_code.append((JOBS_CODE, n))
                    total_needed += n

        if total_needed == 0:
            continue

        points = random_points_in_polygon(geom, total_needed, rng)
        idx = 0
        available = len(points)
        for code, n in n_by_code:
            take = min(n, available - idx)
            if take <= 0:
                break
            for _ in range(take):
                lon, lat = points[idx]
                mz = LADDER_SLOTS[ordinal[code] % LADDER_PERIOD]
                ordinal[code] += 1
                feat = {
                    "type": "Feature",
                    "properties": {TILE_ATTR: code},
                    "geometry": {
                        "type": "Point",
                        "coordinates": [round(float(lon), COORD_PRECISION),
                                        round(float(lat), COORD_PRECISION)],
                    },
                }
                # ALWAYS explicit, even when mz == TILE_MIN_ZOOM. A feature with
                # no `tippecanoe.minzoom` is one tippecanoe feels free to thin
                # with its own --drop-rate; the dots in the z8 slot are exactly
                # the ones that used to have no minzoom, which is why they were
                # the ones getting decimated (2% survived) while the rest of the
                # ladder came through. Stating the minzoom on every feature makes
                # the ladder the only thing that decides what a tile carries.
                feat["tippecanoe"] = {"minzoom": mz}
                yield feat
                idx += 1


# ─── Legend / metadata sidecar ────────────────────────────────────────────────

def config_hash(scale: float = 1.0) -> str:
    """Fingerprint of everything that determines the CONTENT of a dot file: the
    class vocabulary, each class's density and minzoom, the zoom-density ladder,
    the ACS variables, the PUMA correction table and the derivation version.

    build_all_states.sh writes this into each state's sidecar and refuses to
    reuse an existing .ldjson whose fingerprint doesn't match. Without that, a
    regen would silently skip the already-present files from the last build and
    cat them together with the new ones — a tileset with one class vocabulary in
    the states that happened to get rebuilt and another in the rest, with no
    error emitted anywhere.
    """
    payload = "|".join([
        _acs_cache_key(),
        str(scale),
        f"attr:{TILE_ATTR}",
        ";".join(f"{f}:{d['bit']}" for f, d in FLAG_DEFS.items()),
        f"jobs:{JOBS_CODE}",
        ";".join(f"{u}:{unit_per_dot(u, scale)}" for u in UNITS),
        ",".join(f"{z}:{s}" for z, s in sorted(ZOOM_DENSITY_LADDER.items())),
        f"apportion{APPORTION_VERSION}",
        f"z{TILE_MIN_ZOOM}-{TILE_MAX_ZOOM}",
    ])
    return hashlib.sha1(payload.encode()).hexdigest()[:12]


def legend_payload(scale: float = 1.0) -> dict:
    """The schema + density legend the frontend reads. This is the ONLY place the
    '1 dot = N people' numbers and the FLAG BIT VALUES come from — never hardcode
    either in the UI.

    `flags` is load-bearing, not documentation. Mapbox GL expressions have no
    bitwise operators, so the frontend cannot ask the tiles for "dots with bit 1
    set": it has to ENUMERATE the matching codes into an ['in', …] filter. It
    computes that enumeration from these bit values. Ship a legend whose bits
    disagree with the tiles and every filter silently selects the wrong people —
    so demandLegend.ts refuses to start unless the legend's flags, composites and
    jobs code match its own model exactly.

    `zoom_ladder` is what makes the ratio zoom-dependent. The effective ratio at
    zoom z is per_dot × strides[z] (1 at or beyond full_density_zoom), so at z8 a
    "1 dot = 5 people" tileset is really 1 dot = 640 people and the legend must
    say so.

    `max_zoom` is the deepest zoom the archive is BUILT to (TILE_MAX_ZOOM, which
    also generates tippecanoe's --maximum-zoom). The frontend hands it to Mapbox
    as the source maxzoom, so it has to be a zoom that exists: declare one deeper
    and Mapbox requests tiles that were never built and draws an empty layer from
    there in. Mapbox overzooms the deepest tiles by itself, so the dots persist
    at z16+ at their full-density ratio.
    """
    return {
        "archive": TILESET_ARCHIVE,
        "schema": "attribute-dots-v1",
        "source_layer": "demand",
        "attribute": TILE_ATTR,
        "min_zoom": TILE_MIN_ZOOM,
        "max_zoom": TILE_MAX_ZOOM,
        "density_scale": scale,
        "config_hash": config_hash(scale),
        "schema_note":
            "ONE DOT = ONE PERSON. Every population dot carries the bitwise OR of "
            "its membership flags in the integer attribute `d` (0-15); jobs carry "
            "`d` = jobs_code. There are no composite or backdrop CLASSES: the "
            "composites are unions of flags, evaluated at render time, so every "
            "person is drawn exactly once in every view and the 'everyone else' "
            "backdrop is population MINUS THE SELECTION, not population minus the "
            "composite. (It used to be the latter, which drew nobody at all for "
            "the ~24% of people who were in the composite but not the selected "
            "segment.) Mapbox GL has no bitwise operators — enumerate the codes.",
        "flags": {f: d["bit"] for f, d in FLAG_DEFS.items()},
        "jobs_code": JOBS_CODE,
        "population_codes": POPULATION_CODES,
        "zoom_ladder": {
            "strides": {str(z): s for z, s in sorted(ZOOM_DENSITY_LADDER.items())},
            "full_density_zoom": FULL_DENSITY_ZOOM,
            "note": "Effective people-per-dot at zoom z = per_dot x strides[z] "
                    "(1 at or above full_density_zoom). Baked into the tiles as "
                    "per-feature minzoom; it cannot be a client-side filter because "
                    "Mapbox GL forbids [\"zoom\"] in filters. The stride is the ONLY "
                    "thinning applied: tippecanoe is run with --drop-rate=1 and a "
                    "tile budget the ladder never exceeds, and verify_tiles.py "
                    "re-decodes the built archive to prove that retained == emitted "
                    "for every zoom and every code. That is what makes this ratio "
                    "true rather than aspirational. The stride is applied PER CODE, "
                    "so the flag mix is the same at z8 as at z15.",
        },
        # Which flags each mode's composite is the union of. This IS the
        # definition of the composites now — they exist nowhere else.
        "modes": {
            mode: {"segments": list(segs)}
            for mode, segs in COMPOSITES.items()
        },
        "units": {
            unit: {
                "label": cfg["label"],
                "description": cfg["desc"],
                "unit": cfg["unit"],
                "per_dot": unit_per_dot(unit, scale),
                "source": cfg["source"],
            }
            for unit, cfg in UNITS.items()
        },
        "segments": {
            flag: {
                "bit": cfg["bit"],
                "label": cfg["label"],
                "description": cfg["desc"],
                "modes": list(cfg["modes"]),
                "source": "acs",
                "unit": "people",
            }
            for flag, cfg in FLAG_DEFS.items()
        },
    }


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build transit demand dot map")
    parser.add_argument("--state", help="State FIPS ('30') or abbrev ('MT'). Whole-state build.")
    parser.add_argument("--county", help="5-char state+county FIPS ('30031'). Single-county build.")
    parser.add_argument("--output", help="Output path")
    parser.add_argument("--ldjson", action="store_true",
                        help="Line-delimited GeoJSON (one Feature per line). "
                             "Default is a single FeatureCollection.")
    parser.add_argument("--emit-legend", metavar="PATH",
                        help="Write the schema/density legend JSON and exit (no build).")
    parser.add_argument("--emit-tile-cmd", action="store_true",
                        help="Print the tippecanoe command the archive is built "
                             "with (generated from the zoom/ladder constants, so "
                             "the runbook can't drift from the legend) and exit.")
    parser.add_argument("--universes", default="population,jobs",
                        help="Comma-separated subset of the two dot UNIVERSES to "
                             "emit: population, jobs. (There are no classes to "
                             "select any more — a population dot carries its flags.)")
    parser.add_argument("--density-scale", type=float, default=1.0,
                        help="Multiply people-per-dot and jobs-per-dot. >1 = fewer, "
                             "coarser dots. Default 1.0 (use UNITS as-is).")
    parser.add_argument("--dots-per-person", type=int, default=None,
                        help="Override people-per-dot (ignores UNITS). Mainly for "
                             "baseline comparisons.")
    parser.add_argument("--dots-per-job", type=int, default=None,
                        help="Override jobs-per-dot (ignores UNITS).")
    parser.add_argument("--rounding", choices=("stochastic", "floor"), default="stochastic",
                        help="How a block's population becomes a dot count. "
                             "'stochastic' (default) is unbiased — see "
                             "iter_dot_features. 'floor' under-draws rural areas.")
    args = parser.parse_args()

    if args.emit_tile_cmd:
        print(tippecanoe_command())
        return

    if args.emit_legend:
        out = Path(args.emit_legend)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(legend_payload(args.density_scale), indent=2) + "\n")
        print(f"Wrote legend → {out}")
        return

    if not args.output:
        parser.error("--output is required (unless --emit-legend)")
    if bool(args.state) == bool(args.county):
        parser.error("Specify exactly one of --state or --county")

    universes = [u.strip() for u in args.universes.split(",") if u.strip()]
    unknown = [u for u in universes if u not in UNITS]
    if unknown:
        parser.error(f"Unknown universe(s): {unknown}. Known: {list(UNITS)}")
    want_population = "population" in universes
    want_jobs = "jobs" in universes

    per_dot = {
        "population": max(1, args.dots_per_person) if args.dots_per_person
        else unit_per_dot("population", args.density_scale),
        "jobs": max(1, args.dots_per_job) if args.dots_per_job
        else unit_per_dot("jobs", args.density_scale),
    }

    # 1-3. Fetch sources
    banner = (f"  universes: {', '.join(f'{u}=1:{per_dot[u]}' for u in universes)}"
              f"   flags: {', '.join(f'{f}={d['bit']}' for f, d in FLAG_DEFS.items())}")
    if args.state:
        state_fips, abbr = resolve_state(args.state)
        print(f"Building transit demand dots for state {abbr.upper()} (FIPS {state_fips})")
        print(banner)
        print("\n1. Fetching Census ACS block group data...")
        bg_data = fetch_block_group_data_state(state_fips)
        print("\n2. Fetching LODES employment data...")
        lodes_data = fetch_lodes_wac_state(state_fips) if want_jobs else pd.DataFrame(
            {"w_geocode": pd.Series(dtype=str), "total_jobs": pd.Series(dtype=int)})
        print("\n3. Fetching block geometries...")
        blocks_gdf = fetch_block_geometries_state(state_fips)
    else:
        state_fips, county_fips = args.county[:2], args.county[2:]
        abbr = FIPS_TO_ABBR.get(state_fips, state_fips)
        print(f"Building transit demand dots for county {state_fips}{county_fips} ({abbr.upper()})")
        print(banner)
        print("\n1. Fetching Census ACS block group data...")
        bg_data = fetch_block_group_data_county(state_fips, county_fips)
        print("\n2. Fetching LODES employment data...")
        lodes_data = fetch_lodes_wac_county(state_fips, county_fips) if want_jobs else pd.DataFrame(
            {"w_geocode": pd.Series(dtype=str), "total_jobs": pd.Series(dtype=int)})
        print("\n3. Fetching block geometries...")
        blocks_gdf = fetch_block_geometries_county(state_fips, county_fips)

    # 4. THE FLAG FIT, at block group — the geography the ACS publishes. Each
    #    block group's marginals + unions become 16 flag cells, seeded by the
    #    PUMS-measured joint for its PUMA. This is what lets a dot be a PERSON
    #    carrying flags rather than one dot per membership.
    print("\n4. Fitting the PUMS 16-cell joint to each block group (IPF)...")
    t0 = time.time()
    bg_cells, diag = fit_bg_cells(bg_data)
    print(f"  Fitted {len(bg_data):,} block groups in {time.time()-t0:.1f}s "
          f"({diag['iterations']:,} iterations; worst residual "
          f"{diag['max_residual_people']:.4f} people, "
          f"{diag['unconverged_rows']} row(s) over the "
          f"{diag['tolerance_people']} tolerance)")
    if not diag["converged"]:
        raise AssertionError(
            f"the flag fit did not converge: {diag['unconverged_rows']} block "
            f"group(s) still off by up to {diag['max_residual_people']:.4f} people. "
            "The tiles would not reproduce the ACS marginals or the PUMS union — "
            "do not publish them.")

    # Reconciliation at BLOCK GROUP: the 16 cells must roll back up to exactly
    # the numbers we fed them. This is the whole claim of the redesign — that
    # turning classes into flags moved nobody — CHECKED, not asserted.
    rolled = joint_flags.marginals_from_cells(bg_cells)
    print("\n  Cells → marginals (the fit reproduces the ACS it was fitted to):")
    for key in [POP_KEY, *MARGINALS, *UNIONS]:
        target = bg_data[key].to_numpy(dtype=float)
        err = np.abs(rolled[key] - target)
        tot_fit, tot_src = float(rolled[key].sum()), int(target.sum())
        rel = abs(tot_fit - tot_src) / max(tot_src, 1) * 100
        print(f"    {key:<12} fit {tot_fit:>13,.0f}   ACS {tot_src:>13,}   "
              f"({rel:+.5f}%, worst block group off by {err.max():.4f} people)")
        if rel > 0.05:
            raise AssertionError(
                f"the flag fit does not reproduce {key}: {tot_fit:,.0f} vs {tot_src:,}")

    # 5. Apportion the JOINT down to blocks. Float, so nothing rounds twice.
    print("\n5. Apportioning the flag cells to census blocks...")
    t0 = time.time()
    bg_index = build_bg_to_blocks_index(blocks_gdf)
    geoids, cells = apportion_state_dots(bg_data, bg_cells, bg_index)
    n_blocks = len(geoids)
    print(f"  Apportioned {n_blocks:,} blocks in {time.time()-t0:.1f}s")

    # The invariants, over EVERY BLOCK in the state — not sampled, not on
    # synthetic fixtures. They now hold EXACTLY (not to within a clamp), because
    # a block's cells are a real set system: its block group's cells scaled by one
    # weight. If this ever fires, the apportionment is not what it claims to be.
    block_marg = joint_flags.marginals_from_cells(cells)
    block_arrays = {
        POP_KEY: block_marg["total_pop"],
        **{f: block_marg[f] for f in MARGINALS},
        **{u: block_marg[u] for u in UNIONS},
        "backdrop_prop": block_marg["total_pop"] - block_marg["prop_all"],
        "backdrop_need": block_marg["total_pop"] - block_marg["need_all"],
    }
    violations = puma_union.check_invariants(block_arrays, atol=1e-6) if n_blocks else []
    if violations:
        raise AssertionError("block-level invariants violated: " + "; ".join(violations))
    print(f"  Invariants hold on all {n_blocks:,} blocks "
          f"(partition, ordering, subset, Fréchet) — by construction, not by clamp")

    block_jobs = {row["w_geocode"]: int(row["total_jobs"]) for _, row in lodes_data.iterrows()}
    block_cells = {g: cells[i] for i, g in enumerate(geoids)} if want_population else {}

    print(f"\n  Population blocks: {n_blocks:,}")
    print(f"  Employment blocks: {len(block_jobs):,}")
    pop_total = int(bg_data[POP_KEY].sum())
    totals: dict[str, int] = {
        k: int(round(float(block_marg[k].sum()))) for k in [*MARGINALS, *UNIONS]
    }
    totals[POP_KEY] = int(round(float(block_marg["total_pop"].sum())))
    if want_jobs:
        totals["jobs"] = sum(block_jobs.values())

    print("\n  Statewide universe (apportioned vs ACS block-group sum):")
    print(f"    {'(total pop)':<14} {totals[POP_KEY]:>12,}  (ACS {pop_total:,})")
    for key in [*MARGINALS, *UNIONS]:
        source_total = int(bg_data[key].sum())
        share = totals[key] / pop_total * 100 if pop_total else 0
        drift = abs(totals[key] - source_total)
        print(f"    {key:<14} {totals[key]:>12,}  ({share:>4.1f}% of pop; "
              f"ACS {source_total:,}, drift {drift:,})")
    if want_jobs:
        print(f"    {'jobs':<14} {totals['jobs']:>12,}  (LODES, block-level)")

    # 6. Stream features to disk
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    print(f"\n6. Writing dots → {out_path} [{'ldjson' if args.ldjson else 'FeatureCollection'}]")

    counts = {code: 0 for code in TILE_CODES}
    total = 0
    t0 = time.time()
    with open(out_path, "w") as f:
        if not args.ldjson:
            f.write('{"type":"FeatureCollection","features":[')
        first = True
        for feat in iter_dot_features(blocks_gdf, block_cells, block_jobs, per_dot,
                                      want_population, want_jobs, args.rounding):
            counts[feat["properties"][TILE_ATTR]] += 1
            total += 1
            if args.ldjson:
                f.write(json.dumps(feat))
                f.write("\n")
            else:
                if not first:
                    f.write(",")
                f.write(json.dumps(feat))
                first = False
            if total % 250000 == 0:
                print(f"    ... {total:,} features written", flush=True)
        if not args.ldjson:
            f.write(']}')
    elapsed = time.time() - t0

    size_mb = out_path.stat().st_size / 1024 / 1024

    # Per-flag DOT counts, rolled up from the codes. This is the number that has
    # to reproduce the ACS after the 1:5 quantisation — the legend's whole claim.
    pop_dots = sum(counts[c] for c in POPULATION_CODES)
    flag_dots = {
        f: sum(counts[c] for c in POPULATION_CODES if c & FLAG_DEFS[f]["bit"])
        for f in FLAGS
    }
    prop_bits = FLAG_DEFS["carless"]["bit"] | FLAG_DEFS["low_income"]["bit"]
    union_dots = {
        "prop_all": sum(counts[c] for c in POPULATION_CODES if c & prop_bits),
        "need_all": sum(counts[c] for c in POPULATION_CODES if c != 0),
    }

    # 7. Sidecar metadata — the legend's source of truth for "1 dot = N people".
    meta = legend_payload(args.density_scale)
    meta.update({
        "state": abbr.upper(),
        "fips": state_fips,
        "acs_year": acs_year(state_fips),
        "tiger_year": TIGER_YEAR,
        "rounding": args.rounding,
        "blocks": int(len(blocks_gdf)),
        "dots_total": total,
        # Per-CODE dot counts: what verify_tiles.py compares the archive against.
        "code_dots": {str(code): counts[code] for code in TILE_CODES},
        "flag_dots": flag_dots,
        "union_dots": union_dots,
        "population_dots": pop_dots,
        "joint_fit": diag,
    })
    for unit in list(meta["units"]):
        if unit not in universes:
            del meta["units"][unit]
            continue
        meta["units"][unit]["per_dot"] = per_dot[unit]
        meta["units"][unit]["dots"] = pop_dots if unit == "population" else counts[JOBS_CODE]
        meta["units"][unit]["universe"] = totals.get(
            POP_KEY if unit == "population" else "jobs", 0)
    for flag in meta["segments"]:
        meta["segments"][flag]["dots"] = flag_dots[flag]
        meta["segments"][flag]["universe"] = totals[flag]
    meta_path = out_path.with_suffix(out_path.suffix + ".meta.json")
    meta_path.write_text(json.dumps(meta, indent=2) + "\n")

    print("\nDot summary — ONE DOT = ONE PERSON (or one job):")
    print(f"  population   {pop_dots:>12,} dots   (1:{per_dot['population']}, "
          f"universe {totals[POP_KEY]:,})")
    if want_jobs:
        print(f"  jobs         {counts[JOBS_CODE]:>12,} dots   (1:{per_dot['jobs']}, "
              f"universe {totals['jobs']:,})")
    print(f"  {'TOTAL':<12} {total:>12,} dots")

    if want_population and pop_dots:
        grain = per_dot["population"]
        print("\n  Per-flag dot counts vs the ACS marginals they must reproduce")
        print("  (a dot carries 0-4 flags, so these OVERLAP — they are not a partition):")
        print(f"    {'flag':<12}{'dots':>12}{'x1:' + str(grain):>14}"
              f"{'ACS people':>14}{'error':>9}")
        for f in FLAGS:
            implied = flag_dots[f] * grain
            target = totals[f]
            err = (implied - target) / max(target, 1) * 100
            print(f"    {f:<12}{flag_dots[f]:>12,}{implied:>14,}{target:>14,}{err:>8.2f}%")
        print("\n  Union reproduction — the number the OLD prop_all/need_all classes carried:")
        for u in UNIONS:
            implied = union_dots[u] * grain
            target = totals[u]
            err = (implied - target) / max(target, 1) * 100
            print(f"    {u:<12}{union_dots[u]:>12,}{implied:>14,}{target:>14,}{err:>8.2f}%")
        backdrop_dots = counts[0]
        print("\n  THE PARTITION (what the map draws — every person exactly once):")
        print(f"    need composite {union_dots['need_all']:>12,} dots")
        print(f"    no flags       {backdrop_dots:>12,} dots")
        print(f"    sum            {union_dots['need_all'] + backdrop_dots:>12,} dots"
              f"   == population dots {pop_dots:,}"
              f"  {'OK' if union_dots['need_all'] + backdrop_dots == pop_dots else 'MISMATCH'}")

    print("\n  Zoom ladder (share of dots present, effective 1 dot = N people):")
    for z in sorted(ZOOM_DENSITY_LADDER):
        stride = ZOOM_DENSITY_LADDER[z]
        carried = sum(1 for r in LADDER_SLOTS if r <= z) / LADDER_PERIOD
        tag = "+" if z == FULL_DENSITY_ZOOM else " "
        print(f"    z{z}{tag}  every {stride} dot(s)  {carried*100:>5.1f}% carried  "
              f"1 dot = {PEOPLE_PER_DOT * stride} people")
    print(f"\n  File size:   {size_mb:.1f} MB  ({out_path})  in {elapsed:.0f}s")
    print(f"  Metadata:    {meta_path}")


if __name__ == "__main__":
    # Always unbuffered so progress prints reach the terminal / log tail.
    sys.stdout.reconfigure(line_buffering=True)
    main()
