"""Regenerate the PUMS-measured tables the demand-dot pipeline reads:

    data/puma_corrections.csv   per-PUMA union corrections + carless HH size
    data/puma_joint.csv         per-PUMA 16-CELL JOINT DISTRIBUTION of the four
                                membership flags — the table that lets a dot BE a
                                person carrying flags, instead of a class

WHY THESE ARE COMMITTED DATA FILES AND NOT A BUILD STEP
───────────────────────────────────────────────────────
The tables come from the ACS PUMS person microdata: ~3.5M weighted person
records per pull, ~1.2 GB of JSON across 51 states. Nothing about them changes
between state builds, so making `build_dots.py` depend on that download would
add an hour and a gigabyte to every run. The tables are generated here,
committed, and read by `puma_union.py`. Re-run this script when the ACS vintage
rolls over (or never — the overlap structure is extremely stable year to year).

WHAT IT MEASURES
────────────────
For every 2020 PUMA:

  hh_size_carless   persons per ZERO-VEHICLE household.
                    The shipped pipeline multiplied zero-vehicle households by
                    the block group's AVERAGE household size (B25010, ~2.43),
                    which over-counts carless people by ~35%: a zero-vehicle
                    household is much smaller than an average one (1.80 persons
                    nationally). Measured here as
                      PUMS persons in a 0-veh housing unit / ACS B25044 0-veh HHs
                    so it calibrates the exact formula the pipeline applies.

  c_prop, c_need    the correction on the independence backbone:
                      indep = pop * (1 - Π(1 - m_i/pop))
                      union_hat = c(PUMA) * indep
                    c() is what the independence assumption gets wrong locally
                    (segments are positively correlated, so c < 1 as a rule).
                    Measured as TRUE union (PUMS, person-level, exact) over the
                    independence estimate built from that PUMA's PUBLISHED ACS
                    marginals — the same numbers the block groups roll up to —
                    so c() absorbs the residual ACS-vs-PUMS derivation bias too.

    prop = carless ∪ low_income
    need = carless ∪ low_income ∪ senior ∪ disability     (youth is NOT in it)

  cell_0 … cell_15  THE JOINT. Four binary flags have 16 possible combinations,
                    and the PUMS person file KNOWS which one each person is in —
                    so there is no need to infer the joint from marginals and
                    pairwise overlaps (which cannot pin 16 cells anyway). We
                    tabulate all 16 directly, weighted by PWGTP, per PUMA, and
                    ship them as shares of the PUMA's population.

                    Bit order (same as build_dots.FLAG_BITS):
                        1 carless   2 low_income   4 senior   8 disability
                    so cell 0 = no flags, cell 5 = carless+senior, cell 15 = all
                    four. The 16 shares sum to 1.

                    This is what a dot needs. A dot is a PERSON now, carrying
                    boolean membership flags, rather than one dot per
                    (person, class) pair — so the build has to decide, for each
                    dot, WHICH COMBINATION of flags it has. Assigning the flags
                    independently at random would silently reimpose the very
                    independence assumption the c() correction exists to remove
                    (it would make a carless person no more likely to be poor
                    than anyone else, which is badly false). The block-level
                    assignment is an IPF fit of THESE cells to the block's own
                    ACS marginals — see joint_flags.py.

Validated (hold-out: fit on the state, predict its PUMAs, score against PUMS
truth — a far bigger extrapolation than the PUMA→block-group one we actually
make): 1.66% MAPE for prop, ~2% for need, against 34% for the shipped ×0.6.

POVPIP SENTINEL
───────────────
PUMS encodes "poverty status not determined" as POVPIP = -1, not as null.
Institutional group quarters, college dorms and military barracks all carry it,
and `-1 < 200` is True — so a naive low-income filter sweeps every one of them
in (+7.6M nationally). `POVPIP >= 0` is the C17002/C21007 universe. Guarded.

Usage:
    uv run python build_puma_corrections.py                 # full regen
    uv run python build_puma_corrections.py --states 30,25  # spot-check subset
"""

# Bit value of each flag in the 16-cell joint. MUST stay identical to
# build_dots.FLAG_BITS — the cell columns written here are indexed by it, and the
# tiles encode the same bitmask into every dot. Asserted in test_union.py.
FLAG_BITS = {"carless": 1, "low_income": 2, "senior": 4, "disability": 8}
N_CELLS = 1 << len(FLAG_BITS)
CELL_COLS = [f"cell_{i}" for i in range(N_CELLS)]

import argparse
import io
import json
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from acs_vintage import census_key, resolve_latest_acs_year

HERE = Path(__file__).parent
DATA_DIR = HERE / "data"
PUMS_CACHE = HERE / "cache" / "pums"

# Puerto Rico (72) publishes no PUMS person file on this endpoint, so it gets the
# national default row. Its 2020 PUMAs are absent from the table by construction.
PUMS_STATES = [
    "01", "02", "04", "05", "06", "08", "09", "10", "11", "12", "13", "15", "16",
    "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29",
    "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42",
    "44", "45", "46", "47", "48", "49", "50", "51", "53", "54", "55", "56",
]

PUMS_VARS = "PWGTP,AGEP,VEH,TEN,POVPIP,TYPEHUGQ,DIS,MIL,PUMA"

# The published ACS tables at PUMA geography — deliberately the SAME variables
# build_dots.py fetches at block group, so c() is measured against the marginals
# the pipeline will actually feed it.
A_POP = "B01001_001E"
A_NOVEH = ["B25044_003E", "B25044_010E"]
A_LOWINC = [f"C17002_00{i}E" for i in range(2, 8)]
A_SENIOR = ["B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E",
            "B01001_024E", "B01001_025E", "B01001_044E", "B01001_045E",
            "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E"]
# C21007 "with a disability" cells, across the 8 age × veteran × poverty branches.
A_DIS = ["C21007_005E", "C21007_008E", "C21007_012E", "C21007_015E",
         "C21007_020E", "C21007_023E", "C21007_027E", "C21007_030E"]
ACS_PUMA_VARS = [A_POP, *A_NOVEH, *A_LOWINC, *A_SENIOR, *A_DIS]

XWALK_URL = ("https://www2.census.gov/geo/docs/maps-data/data/rel2020/"
             "2020_Census_Tract_to_2020_PUMA.txt")
XWALK_PATH = DATA_DIR / "2020_Census_Tract_to_2020_PUMA.txt"

# Sanity rails. A PUMA whose measured value lands outside these is a data
# pathology, not a signal; fall back to the national default rather than ship it.
C_BOUNDS = (0.50, 1.20)
HH_SIZE_BOUNDS = (1.00, 3.50)


def _key_params() -> dict:
    k = census_key()
    return {"key": k} if k else {}


def fetch_xwalk() -> Path:
    if XWALK_PATH.exists():
        return XWALK_PATH
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading tract→PUMA crosswalk: {XWALK_URL}")
    r = requests.get(XWALK_URL, timeout=120)
    r.raise_for_status()
    body = r.content
    if body[:2] == b"PK":  # served zipped on some mirrors
        with zipfile.ZipFile(io.BytesIO(body)) as z:
            body = z.read(z.namelist()[0])
    XWALK_PATH.write_bytes(body)
    return XWALK_PATH


def fetch_pums(state: str, year: int) -> Path:
    PUMS_CACHE.mkdir(parents=True, exist_ok=True)
    fp = PUMS_CACHE / f"p_{state}.json"
    if fp.exists() and fp.stat().st_size > 0:
        return fp
    url = f"https://api.census.gov/data/{year}/acs/acs5/pums"
    print(f"  downloading PUMS {state}...", flush=True)
    r = requests.get(url, params={"get": PUMS_VARS, "for": f"state:{state}",
                                  **_key_params()}, timeout=900)
    r.raise_for_status()
    if not r.content[:1] == b"[":
        raise RuntimeError(f"PUMS {state}: not a JSON array — {r.text[:200]}")
    fp.write_bytes(r.content)
    return fp


def pums_puma_stats(fp: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Per-PUMA weighted PUMS truth.

    Returns (stats, joint):
      stats  total pop, carless persons, exact unions — what c() is measured from
      joint  the 16-CELL JOINT: weighted people in each combination of the four
             flags. This is the real thing, tabulated from person records; it is
             not inferred from marginals, so it needs no assumption at all.
    """
    raw = json.loads(fp.read_text())
    df = pd.DataFrame(raw[1:], columns=raw[0])
    for c in ("PWGTP", "AGEP", "VEH", "TEN", "POVPIP", "TYPEHUGQ", "DIS", "MIL"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    puma_id = (df["state"] + df["PUMA"]).to_numpy()
    w = df["PWGTP"].to_numpy(dtype=np.float64)

    hu = (df["TYPEHUGQ"] == 1).to_numpy()          # in a housing unit, not GQ
    pov_det = (df["POVPIP"] >= 0).to_numpy()       # ← the -1 sentinel guard
    carless = hu & (df["VEH"] == 0).to_numpy()
    low_income = pov_det & (df["POVPIP"] < 200).to_numpy()
    senior = (df["AGEP"] >= 65).to_numpy()
    # C21007's universe: civilian (not active-duty), 18+, poverty-determined.
    disability = ((df["DIS"] == 1) & (df["AGEP"] >= 18) & (df["MIL"] != 1)).to_numpy() & pov_det

    u_prop = carless | low_income
    u_need = u_prop | senior | disability

    cols = {
        "pums_pop": np.ones(len(df), dtype=bool),
        "pums_carless": carless,
        "pums_u_prop": u_prop,
        "pums_u_need": u_need,
    }
    out = pd.DataFrame({k: pd.Series(w * v, index=puma_id).groupby(level=0).sum()
                        for k, v in cols.items()})
    out.index.name = "puma_id"

    # ── the 16-cell joint ────────────────────────────────────────────────────
    # Every person lands in EXACTLY ONE cell, so the cells sum back to the PUMA's
    # population by construction and the marginals fall out of them exactly. Same
    # flag definitions as above — one source of truth for what "carless" means.
    code = (carless * FLAG_BITS["carless"] + low_income * FLAG_BITS["low_income"]
            + senior * FLAG_BITS["senior"] + disability * FLAG_BITS["disability"])
    joint = pd.DataFrame(
        {c: pd.Series(w * (code == i), index=puma_id).groupby(level=0).sum()
         for i, c in enumerate(CELL_COLS)}
    )
    joint.index.name = "puma_id"
    return out, joint


def fetch_acs_puma(state: str, year: int) -> pd.DataFrame:
    base = f"https://api.census.gov/data/{year}/acs/acs5"
    frames = []
    for i in range(0, len(ACS_PUMA_VARS), 45):   # >50 vars per call is rejected
        chunk = ACS_PUMA_VARS[i:i + 45]
        r = requests.get(base, params={
            "get": ",".join(chunk), "for": "public use microdata area:*",
            "in": f"state:{state}", **_key_params()}, timeout=180)
        r.raise_for_status()
        d = r.json()
        f = pd.DataFrame(d[1:], columns=d[0])
        f["puma_id"] = f["state"] + f["public use microdata area"]
        frames.append(f.set_index("puma_id")[chunk])
    return pd.concat(frames, axis=1)


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    v = pd.to_numeric(df[col], errors="coerce").fillna(0)
    return v.where(v >= 0, 0)     # Census negative sentinels → 0


def _sum(df: pd.DataFrame, cols: list[str]) -> pd.Series:
    return sum((_num(df, c) for c in cols), start=pd.Series(0.0, index=df.index))


def independence(pop: np.ndarray, marginals: list[np.ndarray]) -> np.ndarray:
    """pop * (1 - Π(1 - m_i/pop)) — the independence backbone."""
    with np.errstate(divide="ignore", invalid="ignore"):
        keep = np.ones_like(pop, dtype=np.float64)
        for m in marginals:
            share = np.clip(np.where(pop > 0, m / np.where(pop > 0, pop, 1), 0.0), 0.0, 1.0)
            keep *= (1.0 - share)
    return pop * (1.0 - keep)


def write_joint(joint: pd.DataFrame, out: Path) -> None:
    """Write data/puma_joint.csv: per-PUMA 16-cell SHARES (they sum to 1).

    Shares, not counts, because the consumer rescales them to a census block's
    population anyway — and a share table is ~10x smaller and immune to the PUMS
    vs published-ACS population gap.

    A cell that is empty in a PUMA stays empty here, and that is correct as a
    MEASUREMENT — but it would be a trap as a SEED: iterative fitting can never
    move mass into a zero cell, so a block whose marginals require that
    combination (a rural PUMA with no recorded carless+disabled person, in a
    block group whose ACS marginals imply one) would be infeasible. joint_flags
    floors the seed before fitting; the table stays honest.
    """
    tot = joint.sum(axis=1).to_numpy()
    shares = joint.to_numpy(dtype=np.float64) / np.maximum(tot, 1e-9)[:, None]
    tab = pd.DataFrame(shares, columns=CELL_COLS, index=joint.index)
    tab.insert(0, "pop", np.rint(tot).astype(np.int64))

    # National pooled default: PR (no PUMS person file) and any tract missing from
    # the crosswalk fall back to it, exactly as they do for c_prop/c_need.
    nat = joint.sum(axis=0).to_numpy(dtype=np.float64)
    default = pd.DataFrame(
        [[int(round(nat.sum()))] + list(nat / max(nat.sum(), 1e-9))],
        columns=["pop"] + CELL_COLS, index=pd.Index(["__default__"], name="puma_id"),
    )
    tab = pd.concat([default, tab.sort_index()])
    tab[CELL_COLS] = tab[CELL_COLS].round(8)

    out.parent.mkdir(parents=True, exist_ok=True)
    tab.to_csv(out)

    print(f"\n16-cell joint → {out}  ({len(tab)} rows incl. __default__)")
    print("  national cell shares (bit 1=carless 2=low_income 4=senior 8=disability):")
    names = {v: k for k, v in FLAG_BITS.items()}
    for i, c in enumerate(CELL_COLS):
        flags = "+".join(n for b, n in sorted(names.items()) if i & b) or "(none)"
        share = float(default[c].iloc[0])
        print(f"    cell {i:>2}  {flags:<38} {share*100:>6.2f}%")
    empties = int((tab[CELL_COLS] == 0).any(axis=1).sum())
    print(f"  PUMAs with at least one empty cell: {empties} of {len(tab)} "
          "(floored at fit time, see joint_flags.py)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--states", help="Comma-separated FIPS subset (default: all)")
    ap.add_argument("--year", type=int, default=None,
                    help="ACS 5-yr vintage (default: newest published)")
    ap.add_argument("--out", default=str(DATA_DIR / "puma_corrections.csv"))
    ap.add_argument("--out-joint", default=str(DATA_DIR / "puma_joint.csv"))
    args = ap.parse_args()

    year = args.year or resolve_latest_acs_year()
    states = ([s.strip().zfill(2) for s in args.states.split(",")]
              if args.states else PUMS_STATES)
    fetch_xwalk()
    print(f"ACS/PUMS vintage: {year} 5-year · {len(states)} states")

    pums_parts, acs_parts, joint_parts = [], [], []
    for st in states:
        fp = fetch_pums(st, year)
        p, jt = pums_puma_stats(fp)
        a = fetch_acs_puma(st, year)
        print(f"  {st}: {len(p):>4} PUMAs   PUMS pop {p['pums_pop'].sum():>12,.0f}",
              flush=True)
        pums_parts.append(p)
        acs_parts.append(a)
        joint_parts.append(jt)

    pums = pd.concat(pums_parts)
    acs = pd.concat(acs_parts)
    joint = pd.concat(joint_parts)
    j = pums.join(acs, how="inner")
    print(f"\nJoined {len(j)} PUMAs (PUMS ∩ published ACS)")

    write_joint(joint, Path(args.out_joint))

    pop = _num(j, A_POP).to_numpy(dtype=np.float64)
    noveh_hh = _sum(j, A_NOVEH).to_numpy(dtype=np.float64)
    low_income = _sum(j, A_LOWINC).to_numpy(dtype=np.float64)
    senior = _sum(j, A_SENIOR).to_numpy(dtype=np.float64)
    disability = _sum(j, A_DIS).to_numpy(dtype=np.float64)

    pums_pop = j["pums_pop"].to_numpy(dtype=np.float64)
    pums_carless = j["pums_carless"].to_numpy(dtype=np.float64)

    # ── 1. persons per zero-vehicle household ────────────────────────────────
    # Calibrates the pipeline's own formula: carless_pop = B25044 0-veh HHs × k.
    with np.errstate(divide="ignore", invalid="ignore"):
        hh_size = np.where(noveh_hh > 0, pums_carless / np.maximum(noveh_hh, 1e-9), np.nan)

    # ── 2. c() on the independence backbone ──────────────────────────────────
    # The unions are PUMS truth, rescaled onto the published-ACS population base
    # (they differ by <1%) so c() corrects the ESTIMATOR, not a pop-base mismatch.
    with np.errstate(divide="ignore", invalid="ignore"):
        scale = np.where(pums_pop > 0, pop / np.maximum(pums_pop, 1e-9), 1.0)
    u_prop = j["pums_u_prop"].to_numpy(dtype=np.float64) * scale
    u_need = j["pums_u_need"].to_numpy(dtype=np.float64) * scale

    # The pipeline's carless marginal = 0-veh HHs × hh_size, which at PUMA level
    # is exactly the PUMS carless count. Feed the estimator the same thing.
    carless = np.where(np.isnan(hh_size), 0.0, noveh_hh * np.nan_to_num(hh_size))

    i_prop = independence(pop, [carless, low_income])
    i_need = independence(pop, [carless, low_income, senior, disability])
    with np.errstate(divide="ignore", invalid="ignore"):
        c_prop = np.where(i_prop > 0, u_prop / np.maximum(i_prop, 1e-9), np.nan)
        c_need = np.where(i_need > 0, u_need / np.maximum(i_need, 1e-9), np.nan)

    tab = pd.DataFrame({
        "puma_id": j.index.astype(str),
        "pop": np.rint(pop).astype(np.int64),
        "noveh_hh": np.rint(noveh_hh).astype(np.int64),
        "hh_size_carless": hh_size,
        "c_prop": c_prop,
        "c_need": c_need,
    })

    # National defaults: population-weighted, from the pooled totals (NOT a mean
    # of per-PUMA ratios — that would over-weight tiny PUMAs).
    d_hh = float(pums_carless.sum() / noveh_hh.sum())
    d_cp = float(u_prop.sum() / i_prop.sum())
    d_cn = float(u_need.sum() / i_need.sum())

    def rail(col: str, lo: float, hi: float, default: float) -> int:
        bad = tab[col].isna() | (tab[col] < lo) | (tab[col] > hi)
        tab.loc[bad, col] = default
        return int(bad.sum())

    n1 = rail("hh_size_carless", *HH_SIZE_BOUNDS, d_hh)
    n2 = rail("c_prop", *C_BOUNDS, d_cp)
    n3 = rail("c_need", *C_BOUNDS, d_cn)

    tab = pd.concat([
        pd.DataFrame([{"puma_id": "__default__", "pop": int(pop.sum()),
                       "noveh_hh": int(noveh_hh.sum()), "hh_size_carless": d_hh,
                       "c_prop": d_cp, "c_need": d_cn}]),
        tab.sort_values("puma_id"),
    ], ignore_index=True)
    for c in ("hh_size_carless", "c_prop", "c_need"):
        tab[c] = tab[c].round(5)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tab.to_csv(out, index=False)

    print(f"\nNational defaults (population-weighted):")
    print(f"  persons per zero-vehicle household : {d_hh:.3f}   "
          f"(the pipeline used to use the ~2.43 AVERAGE HH size → +{2.43/d_hh-1:.0%})")
    print(f"  c_prop (carless ∪ low_income)      : {d_cp:.4f}")
    print(f"  c_need (+ senior + disability)     : {d_cn:.4f}")
    print(f"Railed to default: hh_size {n1}, c_prop {n2}, c_need {n3} of {len(j)} PUMAs")
    q = tab[tab.puma_id != "__default__"][["hh_size_carless", "c_prop", "c_need"]]
    print("\nPer-PUMA spread:")
    print(q.describe(percentiles=[.1, .5, .9]).loc[["min", "10%", "50%", "90%", "max"]]
          .round(3).to_string())
    print(f"\nWrote {out}  ({len(tab)} rows incl. __default__)")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    sys.exit(main())
