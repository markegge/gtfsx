"""Deduplicated UNION estimation for the demand-dot classes.

THE PROBLEM
───────────
The ACS publishes MARGINALS at block group — carless people, low-income people,
seniors, people with a disability — and no joint distribution below PUMA. But
the dot map needs the UNION ("how many distinct people are in at least one of
these groups"), because a dot must stand for a PERSON, not for a membership. A
carless low-income senior is ONE dot, not three.

Summing marginals double-counts. The shipped pipeline "solved" this by
multiplying the sum by an invented 0.6. The true factor for that composite is
0.824 — the shipped map under-counted its own headline class by 27%.

THE ESTIMATOR (measured, not invented)
──────────────────────────────────────
    share_i   = m_i / pop
    indep     = pop * (1 - Π(1 - share_i))      independence backbone
    union_hat = clamp(c(PUMA) * indep, lo, hi)  c() measured from PUMS

`indep` is what the union would be if the segments were independent. They are
not (poverty, carlessness and disability are all positively correlated), so a
single national fudge factor is exactly the mistake the 0.6 was. c(PUMA) is the
LOCAL correction on that backbone, measured from PUMS person records — see
build_puma_corrections.py — and shipped as data/puma_corrections.csv.

Hold-out validation (fit on the state, predict its PUMAs, score against PUMS
truth — a far larger extrapolation than the PUMA→block-group one made here):
  1.66% MAPE for prop, ~2% for need, vs 34% for the incumbent ×0.6.

THE FRÉCHET CLAMP IS NOT OPTIONAL
─────────────────────────────────
Any union is bounded by arithmetic alone:
    max(m_i)  ≤  union  ≤  min(Σ m_i, pop)
Clamping to those bounds is what makes the map's invariants hold BY
CONSTRUCTION rather than on average: a segment can never out-number the union
that contains it, a union can never exceed the population, and the backdrop
(pop − union) can never go negative. `reconcile()` is the single choke point
where that is enforced — at block group AND again after apportionment to
blocks, since rounding each class independently can otherwise break them.
"""

import hashlib
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
CORRECTIONS_PATH = HERE / "data" / "puma_corrections.csv"
JOINT_PATH = HERE / "data" / "puma_joint.csv"
XWALK_PATH = HERE / "data" / "2020_Census_Tract_to_2020_PUMA.txt"

DEFAULT_KEY = "__default__"


@lru_cache(maxsize=1)
def corrections() -> pd.DataFrame:
    """PUMA → (hh_size_carless, c_prop, c_need), indexed by 7-char PUMA id."""
    df = pd.read_csv(CORRECTIONS_PATH, dtype={"puma_id": str})
    df["puma_id"] = df["puma_id"].str.strip()
    return df.set_index("puma_id")


@lru_cache(maxsize=1)
def joint_table() -> pd.DataFrame:
    """PUMA → the 16-cell JOINT distribution of the four flags, as shares.

    Tabulated straight from PUMS person records (build_puma_corrections.py), so
    it is a measurement of the joint, not an inference from marginals. It is the
    seed joint_flags.py fits to each block's own ACS marginals — which is how a
    dot gets to BE a person carrying flags rather than one dot per membership.
    """
    df = pd.read_csv(JOINT_PATH, dtype={"puma_id": str})
    df["puma_id"] = df["puma_id"].str.strip()
    return df.set_index("puma_id")


@lru_cache(maxsize=1)
def corrections_hash() -> str:
    """Content hash of the PUMS-derived tables — folded into the ACS cache key so
    a regen can't silently reuse block-group CSVs derived from the old tables (the
    derived columns would be stale, with no error anywhere). Covers the joint as
    well as the corrections: they are regenerated together and a build that mixed
    vintages would fit last month's correlations to this month's unions."""
    h = hashlib.sha1(CORRECTIONS_PATH.read_bytes())
    h.update(JOINT_PATH.read_bytes())
    return h.hexdigest()[:8]


@lru_cache(maxsize=1)
def tract_to_puma() -> dict[str, str]:
    """11-char tract GEOID → 7-char PUMA id (2020 tracts → 2020 PUMAs).

    Block group → tract → PUMA is a clean nesting: a block group never straddles
    a tract and a tract never straddles a PUMA, so this is exact, not a spatial
    approximation. Connecticut works too: the 2020 crosswalk carries the OLD
    county codes (001-015), which is exactly what the CT-pinned ACS 2021 block
    group GEOIDs use (see ACS_YEAR_BY_STATE in build_dots.py).
    """
    df = pd.read_csv(XWALK_PATH, dtype=str, encoding="utf-8-sig")
    df.columns = [c.strip().upper() for c in df.columns]
    tract = df["STATEFP"] + df["COUNTYFP"] + df["TRACTCE"]
    puma = df["STATEFP"] + df["PUMA5CE"]
    return dict(zip(tract, puma))


def puma_params(bg_geoids: pd.Series) -> pd.DataFrame:
    """Look up (hh_size_carless, c_prop, c_need) for each block-group GEOID.

    Anything the table doesn't cover — Puerto Rico (no PUMS person file is
    published for it) or a tract missing from the crosswalk — falls back to the
    population-weighted national row rather than dropping out of the build.
    """
    tab = corrections()
    xwalk = tract_to_puma()
    pumas = bg_geoids.astype(str).str[:11].map(xwalk)
    cols = ["hh_size_carless", "c_prop", "c_need"]
    default = tab.loc[DEFAULT_KEY, cols]
    out = tab.reindex(pumas)[cols]
    out.index = bg_geoids.index
    return out.fillna(default)


# ─── The estimator ────────────────────────────────────────────────────────────

def independence(pop: np.ndarray, marginals: list[np.ndarray]) -> np.ndarray:
    """pop * (1 - Π(1 - m_i/pop)). Zero-population geographies yield 0."""
    pop = np.asarray(pop, dtype=np.float64)
    safe = np.where(pop > 0, pop, 1.0)
    keep = np.ones_like(pop)
    for m in marginals:
        share = np.clip(np.asarray(m, dtype=np.float64) / safe, 0.0, 1.0)
        keep *= (1.0 - share)
    return np.where(pop > 0, pop * (1.0 - keep), 0.0)


def _i(a) -> np.ndarray:
    return np.rint(np.asarray(a, dtype=np.float64)).astype(np.int64)


def reconcile(pop, carless, low_income, senior, disability,
              prop_est, need_est) -> dict[str, np.ndarray]:
    """Turn raw marginals + two raw union estimates into an INVARIANT-CLEAN set
    of integer class counts. This is the only place the invariants are created,
    and it is idempotent — running it again on its own output changes nothing.

    Establishes, per geography:
        prop_all + backdrop_prop == pop
        need_all + backdrop_need == pop
        prop_all <= need_all
        carless, low_income                     <= prop_all
        carless, low_income, senior, disability <= need_all
        max(m) <= union <= min(Σm, pop)         (Fréchet)

    All arguments are array-likes of counts; everything is returned as int64.
    """
    pop = np.maximum(_i(pop), 0)
    # A marginal can exceed the population it is drawn from — the ACS estimates
    # the numerator and the denominator from different samples, and the carless
    # count is a HOUSEHOLD count scaled by a household size. Clip first, or the
    # Fréchet lower bound would push the union above the population.
    carless = np.clip(_i(carless), 0, pop)
    low_income = np.clip(_i(low_income), 0, pop)
    senior = np.clip(_i(senior), 0, pop)
    disability = np.clip(_i(disability), 0, pop)

    prop_lo = np.maximum(carless, low_income)
    prop_hi = np.minimum(carless + low_income, pop)
    prop_all = np.clip(_i(prop_est), prop_lo, prop_hi)

    # need ⊇ prop by definition, so prop_all is part of need's lower bound —
    # that is what makes `prop_all <= need_all` true by construction and not by
    # luck of the rounding.
    need_lo = np.maximum.reduce([prop_all, senior, disability])

    # THE UPPER BOUND IS CONDITIONAL ON prop_all, NOT ON THE MARGINALS ALONE.
    #
    # The obvious bound is Fréchet on all four marginals, min(Σm, pop). It is not
    # tight, and the slack is not harmless:
    #
    #     need = prop ∪ (senior ∪ disability)
    #          ⇒ |need| ≤ |prop| + |senior| + |disability|
    #
    # because the only people need can add to prop are seniors and disabled ones.
    # Σm = carless + low_income + senior + disability can exceed prop_all + senior
    # + disability by min(carless, low_income) — exactly the carless∩low_income
    # overlap that prop_all already deduplicated. Bounding need by Σm therefore
    # lets need_all be clamped to a number that COUNTS THAT OVERLAP TWICE, and no
    # set system on earth realizes it: you would need more non-prop union members
    # than there are seniors and disabled people to supply them.
    #
    # Under the old class-per-segment schema this was invisible — need_all was
    # just a count, nothing cross-checked it against the others, and every
    # disjointness invariant still passed. Under attribute dots it is fatal and
    # LOUD: need_all is a constraint on the 16-cell fit, and joint_flags.fit()
    # simply cannot converge on an infeasible system. It didn't. That is how this
    # was found, and it is the good kind of failure — the schema made a latent
    # arithmetic lie impossible to hold.
    #
    # (min(Σm, pop) is subsumed: prop_all ≤ carless + low_income always, so
    # prop_all + senior + disability ≤ Σm. The tighter bound is the only one left.)
    need_hi = np.minimum(prop_all + senior + disability, pop)
    need_all = np.clip(_i(need_est), need_lo, need_hi)

    return {
        "total_pop": pop,
        "carless": carless,
        "low_income": low_income,
        "senior": senior,
        "disability": disability,
        "prop_all": prop_all,
        "need_all": need_all,
        "backdrop_prop": pop - prop_all,
        "backdrop_need": pop - need_all,
    }


def estimate(pop, carless, low_income, senior, disability,
             c_prop, c_need) -> dict[str, np.ndarray]:
    """The full estimator: independence backbone → PUMA correction → Fréchet."""
    pop = np.asarray(pop, dtype=np.float64)
    marg = [np.asarray(x, dtype=np.float64)
            for x in (carless, low_income, senior, disability)]
    prop_est = np.asarray(c_prop, dtype=np.float64) * independence(pop, marg[:2])
    need_est = np.asarray(c_need, dtype=np.float64) * independence(pop, marg)
    return reconcile(pop, *marg, prop_est, need_est)


def check_invariants(cls: dict[str, np.ndarray], atol: float = 0.0) -> list[str]:
    """Return a list of violated-invariant descriptions (empty == all hold).
    Used by the unit tests AND asserted over every real block in a build.

    `atol` is an ABSOLUTE slack, in people. It defaults to 0, because the
    estimator's output is integer counts and the invariants are then exact — do
    not relax that.

    It exists for the one caller whose counts are legitimately FLOATS: the block
    level, where a block's cells are its block group's cells times a fractional
    weight (see build_dots.apportion_state_dots). There the invariants hold
    exactly in real arithmetic and only fail in IEEE754 — `(pop - prop) + prop`
    is not bit-identical to `pop` — so a strict `!=` reports thousands of
    "violations" that are all 2e-13 of a person. Pass atol=1e-6 there. It is a
    float-noise allowance and nothing else; anything a real bug does to these
    numbers is many orders of magnitude larger.
    """
    v: list[str] = []
    pop, prop, need = cls["total_pop"], cls["prop_all"], cls["need_all"]
    segs_prop = ("carless", "low_income")
    segs_need = ("carless", "low_income", "senior", "disability")

    def bad(name: str, mask: np.ndarray) -> None:
        n = int(np.count_nonzero(mask))
        if n:
            v.append(f"{name}: {n:,} geographies")

    def over(a, b) -> np.ndarray:
        """a > b, allowing atol of slack."""
        return np.asarray(a) > np.asarray(b) + atol

    def ne(a, b) -> np.ndarray:
        return np.abs(np.asarray(a) - np.asarray(b)) > atol

    bad("prop_all + backdrop_prop != total_pop", ne(prop + cls["backdrop_prop"], pop))
    bad("need_all + backdrop_need != total_pop", ne(need + cls["backdrop_need"], pop))
    bad("prop_all > need_all", over(prop, need))
    bad("need_all > total_pop", over(need, pop))
    bad("negative count", np.any([cls[k] < -atol for k in cls], axis=0))
    for s in segs_prop:
        bad(f"{s} > prop_all", over(cls[s], prop))
    for s in segs_need:
        bad(f"{s} > need_all", over(cls[s], need))
    # Fréchet
    bad("prop_all < max(carless, low_income)",
        over(np.maximum(cls["carless"], cls["low_income"]), prop))
    bad("prop_all > min(sum, pop)",
        over(prop, np.minimum(cls["carless"] + cls["low_income"], pop)))
    # The CONDITIONAL bound (see reconcile): need can only add seniors and
    # disabled people to prop, so it cannot exceed prop_all + senior + disability.
    # This is what makes the counts REALIZABLE — i.e. what guarantees there exists
    # an assignment of people to flag combinations that produces them. It is not a
    # nicety: it is the feasibility condition of joint_flags.fit(), and a build
    # whose blocks violate it cannot produce tiles at all.
    bad("need_all > prop_all + senior + disability",
        over(need, prop + cls["senior"] + cls["disability"]))
    bad("need_all > min(sum, pop)",
        over(need, np.minimum(sum(cls[s] for s in segs_need), pop)))
    return v
