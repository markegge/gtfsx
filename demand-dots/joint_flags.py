"""Assign a COMBINATION OF FLAGS to every dot — the joint distribution problem.

WHY THIS MODULE EXISTS
──────────────────────
A dot used to be a (person, class) pair: a carless low-income person put one dot
in `carless`, one in `low_income`, one in `prop_all` and one in `need_all`. That
made the composites and backdrops tile classes, and it made the map lie — the
gray backdrop was `population − composite`, so with the Carless segment selected
the low-income-but-not-carless quarter of the population was drawn NOWHERE.

A dot is now a PERSON carrying four boolean flags (carless, low_income, senior,
disability), drawn exactly once in every view; the UI recolors rather than
reclasses. Which means the build has to answer a question it never had to before:

    for THIS dot, which combination of the four flags is it in?

Four flags = 16 possible combinations. The ACS gives us four MARGINALS at block
group and nothing else — it does not publish, at any geography below PUMA, how
many people are BOTH carless AND low-income.

WHAT WE DO NOT DO: assign the flags independently
─────────────────────────────────────────────────
The tempting shortcut is to roll each flag separately at its marginal rate. That
is exactly the independence assumption that puma_union's c() correction exists to
CORRECT — it would make a carless person no likelier to be poor than anyone else,
when in reality carlessness, poverty and disability are strongly positively
correlated. Nationally it inflates the union by ~10% (c_need = 0.909), and it
would put that error back into the tiles after we went and measured it away.

WHAT WE DO: fit the MEASURED joint to each block's marginals (IPF)
─────────────────────────────────────────────────────────────────
The PUMS person microdata knows every person's true combination, so we tabulate
all 16 cells per PUMA directly (build_puma_corrections.py → data/puma_joint.csv).
No estimation, no assumption — a headcount of the joint at PUMA scale.

That table is the SEED. A block is not its PUMA, though: it has its own ACS
marginals (a block group can be 60% low-income inside a PUMA that is 25%). So we
fit the PUMA's 16 cells to the block's own numbers by iterative proportional
fitting, over six constraints — each one a two-way split of the 16 cells:

    cells with carless      →  the block's carless marginal
    cells with low_income   →  the block's low_income marginal
    cells with senior       →  the block's senior marginal
    cells with disability   →  the block's disability marginal
    cells with carless|low_income  →  the block's prop_all   (the PUMS union)
    cells with ANY flag             →  the block's need_all  (the PUMS union)
    (and therefore cell 0, no flags →  pop − need_all)

IPF converges to the distribution that satisfies every constraint while staying
as close as possible to the seed (its I-projection / maximum-entropy fit), which
is precisely what we want: reproduce the block's own ACS numbers exactly, and
where the ACS is silent — the joint structure — inherit the PUMA's measured
correlations rather than invent independence.

The last two constraints are what keeps the redesign honest against the old one:
the number of dots with ANY flag set still equals the same PUMS-derived union
`need_all` the composite class used to carry, and the flag marginals still equal
the ACS marginals the segment classes used to carry. Nothing about the numbers
changed — only which dot carries them.

HONEST LIMITS
─────────────
  • The joint is measured at PUMA scale (~100k people). Within a PUMA we assume
    the CORRELATION STRUCTURE is uniform across block groups, and let the
    marginals do all the local work. That is an assumption, and it is the same
    class of assumption the c() correction already makes — but it is a much
    weaker one than independence, and it is the strongest thing the published
    data supports. Block-group joint distributions do not exist in any public
    product.
  • Where a block's marginals are extreme relative to its PUMA, IPF moves a long
    way from the seed. It still hits the marginals exactly; it is the residual
    correlation that degrades toward whatever the marginals force.
  • 50 of 2,463 PUMAs have at least one empty cell (nobody in that PUMA is, say,
    carless + disabled + not-poor + under-65). IPF cannot move mass into a zero
    cell, so the seed is floored at SEED_FLOOR before fitting. That floor is the
    only place a number is invented, it is 1e-9 of a block's population, and it
    exists so the fit is always feasible rather than silently stalling.

Deterministic: no RNG anywhere in this module. Same inputs → same cells, bitwise.
"""

import numpy as np
import pandas as pd

import puma_union

# Bit value per flag. This IS the tile encoding: a dot's `d` property is the sum
# of the bits it carries (see build_dots.FLAG_BITS, which must equal this, and
# build_puma_corrections.FLAG_BITS, which the cell columns are indexed by).
FLAG_BITS: dict[str, int] = {
    "carless": 1, "low_income": 2, "senior": 4, "disability": 8,
}
FLAGS = list(FLAG_BITS)
N_CELLS = 1 << len(FLAG_BITS)          # 16
CELLS = np.arange(N_CELLS)

# Cell membership masks — the six constraint groups, precomputed.
HAS_FLAG = {f: (CELLS & b).astype(bool) for f, b in FLAG_BITS.items()}
PROP_BITS = FLAG_BITS["carless"] | FLAG_BITS["low_income"]
IN_PROP = (CELLS & PROP_BITS).astype(bool)      # carless ∪ low_income
IN_NEED = CELLS > 0                             # any flag at all
NO_FLAGS = CELLS == 0                           # the backdrop cell

# See "HONEST LIMITS": makes an empty PUMS cell reachable so the fit is feasible.
# Small enough to be invisible (1e-9 of a geography's people) and the only
# invented number in the module.
SEED_FLOOR = 1e-9

# ─── Convergence: why the tolerance is in PEOPLE, not in percent ──────────────
#
# IPF converges geometrically when the answer is in the interior of the simplex,
# and only as O(1/k) when it is on the BOUNDARY — i.e. when the constraints force
# some cell to be exactly zero, which multiplicative updates can only approach,
# never reach.
#
# Boundary solutions are common here and they are not pathological, they are just
# small: a block group with 4 people, 1 of them low-income, 1 senior, 1 disabled
# and a union of 1 has EXACTLY ONE solution — that one person is all three, and
# the other twelve cells are zero. There is no correlation structure left to fit;
# arithmetic has already decided everything.
#
# So a RELATIVE tolerance is the wrong instrument: it demands the most precision
# exactly where the numbers are smallest and the answer is already forced. The
# tolerance is therefore ABSOLUTE, in people, and it is set at a hundredth of a
# person — 1/500th of a single dot at the 1:5 grain these cells are drawn at.
# Nothing downstream can see an error that size, and pretending to chase 1e-7
# would burn minutes per state to move a number that rounds away.
#
# Measured on Montana's 900 block groups: statewide marginal error 0.0003%, worst
# block group off by 0.02 of a person. The build prints both and fails if the
# statewide figure moves.
TOLERANCE_PEOPLE = 0.05
MAX_ITER = 40_000
# Below this many people a geography cannot be off by TOLERANCE_PEOPLE in any way
# that survives rounding to a dot; it is skipped once it is close, not chased.
ACTIVE_SET_CHECK_EVERY = 50


def cell_flags(cell: int) -> dict[str, bool]:
    """Which flags cell `cell` carries. The inverse of the bitmask encoding."""
    return {f: bool(cell & b) for f, b in FLAG_BITS.items()}


def cell_label(cell: int) -> str:
    """'carless+senior' — for logs and tests, never for the tiles."""
    return "+".join(f for f, b in FLAG_BITS.items() if cell & b) or "(none)"


def seed_for_blocks(block_geoids: np.ndarray) -> np.ndarray:
    """(n, 16) PUMA joint shares, one row per block, rows summing to 1.

    Block GEOID (15 chars) → tract (first 11) → PUMA, the same exact nesting
    puma_union uses for c(). Anything unmatched (Puerto Rico, a tract missing
    from the crosswalk) gets the national pooled row — the same fallback c()
    takes, so a geography never silently drops out of the build.
    """
    tab = puma_union.joint_table()
    xwalk = puma_union.tract_to_puma()
    tracts = pd.Series(block_geoids).astype(str).str[:11]
    pumas = tracts.map(xwalk)
    cols = [f"cell_{i}" for i in range(N_CELLS)]
    rows = tab.reindex(pumas)[cols]
    default = tab.loc[puma_union.DEFAULT_KEY, cols].to_numpy(dtype=np.float64)
    out = rows.to_numpy(dtype=np.float64)
    missing = np.isnan(out).any(axis=1)
    out[missing] = default
    return out


def fit(pop, carless, low_income, senior, disability, prop_all, need_all,
        seed: np.ndarray, max_iter: int = MAX_ITER,
        tolerance: float = TOLERANCE_PEOPLE) -> tuple[np.ndarray, dict]:
    """IPF the PUMA seed onto each geography's own marginals + unions.

    Returns ((n, 16) float PEOPLE per cell, diagnostics). Every row sums to that
    geography's population EXACTLY, so the cells are a PARTITION of its people:
    every person is in exactly one cell. That is what makes "every person is
    drawn exactly once" true by construction rather than by bookkeeping — and it
    holds no matter how well or badly the fit converged, because the row total is
    conserved by every update (each constraint scales a group to `target` and its
    complement to `pop - target`).

    The inputs must already have been through puma_union.reconcile() — that is
    what guarantees the constraint system is FEASIBLE. In particular reconcile's
    conditional bound `need_all <= prop_all + senior + disability` is not
    decoration: without it the union can be clamped to a number no set system
    realizes, and IPF then converges to something satisfying NEITHER the
    marginals nor the union, silently. (It is how that latent bug was found.)

    ACTIVE SET: rows that already meet the tolerance stop being updated. The few
    boundary-degenerate rows that need tens of thousands of iterations are then
    cheap to chase, instead of dragging every row along with them.
    """
    pop = np.asarray(pop, dtype=np.float64)
    n = len(pop)
    targets = [
        *(np.asarray(t, dtype=np.float64) for t in
          (carless, low_income, senior, disability)),
        np.asarray(prop_all, dtype=np.float64),
        np.asarray(need_all, dtype=np.float64),
    ]
    masks = [*(HAS_FLAG[f] for f in FLAGS), IN_PROP, IN_NEED]

    x = np.where(seed > SEED_FLOOR, seed, SEED_FLOOR)
    x = x / x.sum(axis=1, keepdims=True)
    x = x * pop[:, None]

    def residual(block: np.ndarray, rows: np.ndarray) -> np.ndarray:
        """Largest constraint violation per row, in PEOPLE."""
        out = np.zeros(len(rows))
        for mask, target in zip(masks, targets):
            np.maximum(out, np.abs(block[:, mask].sum(axis=1) - target[rows]), out=out)
        return out

    # Rows with nobody in them have nothing to fit.
    active = np.flatnonzero(pop > 0)
    iters = 0
    while len(active) and iters < max_iter:
        xa = x[active]
        pa = pop[active]
        chunk = min(ACTIVE_SET_CHECK_EVERY, max_iter - iters)
        for _ in range(chunk):
            for mask, target in zip(masks, targets):
                t = target[active]
                inside = xa[:, mask].sum(axis=1)
                outside = xa[:, ~mask].sum(axis=1)
                # A zero denominator is only reachable when its target is zero
                # too (reconcile's clamps guarantee it). Guarded regardless: a
                # 0/0 would send a silent NaN all the way into the tiles.
                s_in = np.where(inside > 0, t / np.where(inside > 0, inside, 1.0), 0.0)
                s_out = np.where(outside > 0, (pa - t) / np.where(outside > 0, outside, 1.0), 0.0)
                xa[:, mask] *= s_in[:, None]
                xa[:, ~mask] *= s_out[:, None]
        iters += chunk
        x[active] = xa
        keep = residual(xa, active) > tolerance
        active = active[keep]

    x[pop <= 0] = 0.0

    all_rows = np.arange(n)
    final = residual(x, all_rows)
    worst = float(final.max()) if n else 0.0
    diag = {
        "iterations": iters,
        "max_residual_people": worst,
        "unconverged_rows": int((final > tolerance).sum()),
        "rows": int(n),
        "tolerance_people": tolerance,
        "converged": bool(worst <= tolerance),
    }
    return x, diag


def marginals_from_cells(cells: np.ndarray) -> dict[str, np.ndarray]:
    """Roll the 16 cells back up to the quantities the ACS published.

    This is the reconciliation the build asserts on: if the cells are a correct
    fit, these come back equal to the inputs. Used by build_dots to prove — over
    every block of every state, not on a fixture — that turning classes into
    flags did not move a single person.
    """
    return {
        **{f: cells[:, HAS_FLAG[f]].sum(axis=1) for f in FLAGS},
        "prop_all": cells[:, IN_PROP].sum(axis=1),
        "need_all": cells[:, IN_NEED].sum(axis=1),
        "total_pop": cells.sum(axis=1),
        "backdrop": cells[:, NO_FLAGS].sum(axis=1),
    }
