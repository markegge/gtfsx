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

# ─── The same six constraints, RE-GROUPED so their forced zeros are EXACT ─────
#
# The six constraints look like six overlapping halves of the 16 cells. They are
# not: four of them are RIGID. Split the flags into the PROP pair (carless,
# low_income — the two prop_all is the union of) and the NEED-ONLY pair (senior,
# disability). A cell is then a (prop-pattern, need-only-pattern) pair, and the
# four constraints carless / low_income / prop_all / need_all — together with the
# row total, which IPF conserves anyway — pin down the five PROP-PATTERN GROUPS
# exactly, with no iteration at all:
#
#   no flag at all              →  pop − need_all      (the backdrop cell)
#   senior|disability, no c/l   →  need_all − prop_all
#   carless, not low_income     →  prop_all − low_income
#   low_income, not carless     →  prop_all − carless
#   carless AND low_income      →  carless + low_income − prop_all
#
# Read it back: carless = (carless only) + (both) = (P−L) + (C+L−P) = C. ✓ Same
# for low_income; prop_all is the three c|l groups; need_all is pop minus the
# backdrop cell. The five groups are DISJOINT, they cover all 16 cells, and their
# targets sum to pop — so scaling each group to its target is a single exact
# multiplication that leaves the row total untouched, not something to converge to.
#
# Every one of those five targets is ≥ 0 EXACTLY when reconcile's clamps hold
# (max(C,L) ≤ P ≤ C+L, P ≤ N ≤ pop). They are not new assumptions — they are
# reconcile's Fréchet invariants, rearranged. Which also means: the partition is
# non-negative iff the system is feasible. Feasibility stops being a hope and
# becomes an arithmetic identity the fit performs.
#
# WHY THIS MATTERS — IT IS THE WHOLE CONVERGENCE STORY
# ───────────────────────────────────────────────────
# A Fréchet clamp that BINDS drives one of these targets to zero:
#   prop_all == max(C,L)  ⇒ "carless only" or "low_income only" is empty
#   prop_all == C + L     ⇒ "carless AND low_income" is empty (they are disjoint)
#   need_all == prop_all  ⇒ nobody is a senior/disabled non-prop person
#   need_all == pop       ⇒ the backdrop cell is empty
# and a binding clamp is COMMON — it is what the clamp is for. The old
# formulation asked IPF to DISCOVER those zeros as an implication of six
# overlapping constraints, and multiplicative updates can only approach zero, at
# O(1/k). California, Florida, New Jersey, New York and Texas each had a handful
# of block groups still carrying ~0.1 of a person in a group that must be empty
# after 40,000 iterations; the residual was, to the digit, exactly that leaked
# mass. Scaling the group straight to its target of zero annihilates it in one
# multiplication instead.
#
# This is a RE-GROUPING, not a different fit: the five group equalities and the
# four constraints they replace define the SAME linear family, so cyclic
# I-projection still converges to the same maximum-entropy solution (Csiszár) —
# the seed is projected onto the same set. Only the conditioning changes.
_CARLESS, _LOW_INCOME = HAS_FLAG["carless"], HAS_FLAG["low_income"]
PARTITION_MASKS = [
    NO_FLAGS,                        # pop − need_all
    ~IN_PROP & IN_NEED,              # need_all − prop_all
    _CARLESS & ~_LOW_INCOME,         # prop_all − low_income
    _LOW_INCOME & ~_CARLESS,         # prop_all − carless
    _CARLESS & _LOW_INCOME,          # carless + low_income − prop_all
]
PARTITION_LABELS = [
    "(none)", "senior|disability only", "carless only", "low_income only",
    "carless+low_income",
]
assert sum(m.astype(int) for m in PARTITION_MASKS).tolist() == [1] * N_CELLS, \
    "PARTITION_MASKS must be a partition of the 16 cells"

# The two constraints the PROP partition does NOT absorb.
RESIDUAL_FLAGS = ["senior", "disability"]

# ─── The SAME trick on the other axis: |senior ∪ disability| ──────────────────
#
# The prop partition leaves senior and disability to iterate on, and they have
# the identical disease one level down. There is a quantity the constraints never
# name — u = |senior ∪ disability| — and the cells group by it just as cleanly:
#
#   no flag at all                     →  pop − need_all      (the same pinned cell)
#   carless|low_income, no senior/disab →  need_all − u
#   senior, not disabled                →  u − disability
#   disabled, not senior                →  u − senior
#   senior AND disabled                 →  senior + disability − u
#
# (Read back: senior = (u−D) + (S+D−u) = S ✓, disability = D ✓, and the five sum
# to pop. Perfectly symmetric with the prop partition above.)
#
# u is NOT free. Arithmetic alone bounds it:
#   u ≥ senior, u ≥ disability                      (a union contains its parts)
#   u ≥ need_all − prop_all                         (the needy who are not prop
#                                                    people are senior or disabled
#                                                    — that is what need_all MEANS)
#   u ≤ senior + disability                         (inclusion–exclusion)
#   u ≤ need_all                                    (senior ∪ disab ⊆ need)
# The interval is non-empty exactly under reconcile's clamps — it is the same
# Fréchet argument, and every u inside it is realisable by some assignment.
#
# WHEN THAT INTERVAL COLLAPSES TO A POINT, u IS DETERMINED. Then so are all five
# groups above, and any of them that comes out zero is a cell block that must be
# EMPTY — the second family of boundary zeros, and the one that survived the prop
# partition. It is not rare: 170 of California's 25,607 block groups, and it is
# what "every needy person here is a senior" (senior == need_all) looks like in
# arithmetic. Pinning u there ADDS NO CONSTRAINT — every feasible point already
# has that u — so the fitted answer is unchanged; it just stops being crawled to.
#
# When the interval is genuinely an interval, u is a real degree of freedom, the
# maximum-entropy fit picks it, there are no forced zeros on this axis, and the
# ordinary two-sided senior/disability updates converge geometrically. So the
# partition is applied only where it is implied, and nowhere else.
_SENIOR, _DISABILITY = HAS_FLAG["senior"], HAS_FLAG["disability"]
SD_PARTITION_MASKS = [
    NO_FLAGS,                                  # pop − need_all (the same cell)
    IN_PROP & ~_SENIOR & ~_DISABILITY,         # need_all − u
    _SENIOR & ~_DISABILITY,                    # u − disability
    _DISABILITY & ~_SENIOR,                    # u − senior
    _SENIOR & _DISABILITY,                     # senior + disability − u
]
SD_PARTITION_LABELS = [
    "(none)", "prop only, no senior/disability", "senior only", "disability only",
    "senior+disability",
]
assert sum(m.astype(int) for m in SD_PARTITION_MASKS).tolist() == [1] * N_CELLS, \
    "SD_PARTITION_MASKS must be a partition of the 16 cells"

# ─── And the OVERLAP the two partitions imply but neither one names ───────────
#
# Pin u and a third quantity falls out with it — how many people are in BOTH the
# prop set and the senior/disability set:
#
#     |(senior ∪ disability) ∩ prop|  =  u − (need_all − prop_all)
#
# because need = prop ∪ senior ∪ disability, so the need_all − prop_all people
# who are needy-but-not-prop are EXACTLY the senior/disabled ones outside prop —
# and whatever is left of u must therefore be inside it. Which cuts the 16 cells
# four ways, again with every total determined:
#
#   no flag at all                  →  pop − need_all
#   senior|disability, not prop     →  need_all − prop_all
#   prop, no senior/disability      →  need_all − u
#   prop AND senior|disability      →  prop_all + u − need_all
#
# The two partitions above imply this one — the four totals follow from theirs by
# subtraction. But IMPLIED IS NOT TARGETED, and that distinction is the entire
# bug: neither partition ever scales the nine prop∩(senior|disability) cells as a
# group, so when their total must be ZERO (u == need_all − prop_all: every senior
# and every disabled person is outside the prop set) IPF can only creep towards
# it. That is the last family of stragglers — a block group like CA 060014228001
# (1,013 prop people, 11 seniors, 24 disabled, need 1,048 = 1,013 + 35) where the
# arithmetic leaves no senior or disabled person free to also be poor or carless.
# Naming the group scales it to zero in one multiplication.
BLOCK_MASKS = [
    NO_FLAGS,                                  # pop − need_all
    ~IN_PROP & IN_NEED,                        # need_all − prop_all
    IN_PROP & ~_SENIOR & ~_DISABILITY,         # need_all − u
    IN_PROP & (_SENIOR | _DISABILITY),         # prop_all + u − need_all
]
BLOCK_LABELS = [
    "(none)", "senior|disability, not prop", "prop, no senior/disability",
    "prop AND senior|disability",
]
assert sum(m.astype(int) for m in BLOCK_MASKS).tolist() == [1] * N_CELLS, \
    "BLOCK_MASKS must be a partition of the 16 cells"


def partition_targets(pop, carless, low_income, prop_all, need_all) -> np.ndarray:
    """(n, 5) people per PARTITION_MASKS group — closed form, no iteration.

    Non-negative exactly when puma_union.reconcile's clamps hold; each row sums
    to pop identically. See the derivation above.
    """
    pop, carless, low_income, prop_all, need_all = (
        np.asarray(a, dtype=np.float64)
        for a in (pop, carless, low_income, prop_all, need_all))
    return np.stack([
        pop - need_all,
        need_all - prop_all,
        prop_all - low_income,
        prop_all - carless,
        carless + low_income - prop_all,
    ], axis=1)


def sd_union_bounds(senior, disability, prop_all, need_all
                    ) -> tuple[np.ndarray, np.ndarray]:
    """Fréchet bounds on u = |senior ∪ disability|, per geography. See above."""
    senior, disability, prop_all, need_all = (
        np.asarray(a, dtype=np.float64)
        for a in (senior, disability, prop_all, need_all))
    lo = np.maximum.reduce([senior, disability, need_all - prop_all])
    hi = np.minimum(senior + disability, need_all)
    return lo, hi


def sd_partition_targets(pop, senior, disability, need_all, u) -> np.ndarray:
    """(n, 5) people per SD_PARTITION_MASKS group, GIVEN u. Only meaningful where
    u is determined (sd_union_bounds lo == hi); elsewhere the caller must not use
    it, because pinning a free u would over-constrain the fit."""
    pop, senior, disability, need_all, u = (
        np.asarray(a, dtype=np.float64)
        for a in (pop, senior, disability, need_all, u))
    return np.stack([
        pop - need_all,
        need_all - u,
        u - disability,
        u - senior,
        senior + disability - u,
    ], axis=1)


def block_targets(pop, prop_all, need_all, u) -> np.ndarray:
    """(n, 4) people per BLOCK_MASKS group, GIVEN u. Same gate as sd_partition_targets."""
    pop, prop_all, need_all, u = (
        np.asarray(a, dtype=np.float64) for a in (pop, prop_all, need_all, u))
    return np.stack([
        pop - need_all,
        need_all - prop_all,
        need_all - u,
        prop_all + u - need_all,
    ], axis=1)

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
# forced: a block group where every carless person is also low-income (prop_all ==
# low_income, the Fréchet clamp binding at its floor) has NOBODY in the
# carless-but-not-low-income cells, and no amount of fitting will change that.
#
# We do not iterate towards those zeros any more. The three PARTITIONS below name
# every one of them and scale it to zero exactly, in one multiplication.
#
# THE GUARD AND THE TARGET ARE DIFFERENT NUMBERS, AND THAT IS THE POINT.
#
# TOLERANCE_PEOPLE is the GUARD — the build refuses to publish above it. It is
# ABSOLUTE, in people, because a RELATIVE tolerance is the wrong instrument here:
# it would demand the most precision exactly where the numbers are smallest and
# the answer is already forced by arithmetic. 0.05 people is 1/100th of a single
# dot at the 1:5 grain these cells are drawn at — nothing downstream can see it.
#
# FIT_TARGET_PEOPLE is what the fit actually CHASES. It is 50,000x tighter, and
# it is affordable now (California: 3,750 sweeps, 4s — it used to hit the 40,000
# cap in 90s and fail). Driving the fit far past the guard is what makes a pass
# HONEST: the build reports the real margin instead of stopping the moment it
# scrapes under the bar, and a row sitting at 0.049 would now be visible as the
# anomaly it is rather than indistinguishable from a row that converged.
#
# Measured across all 51 cached state ACS extracts — 242,296 block groups, every
# state — the worst block group in the country lands at 1e-6 people. If this
# guard ever fires again it is a real infeasibility, not a slow fit.
TOLERANCE_PEOPLE = 0.05
FIT_TARGET_PEOPLE = 1e-6
MAX_ITER = 40_000
# Rows are only re-checked this often; the active set then drops them once they
# are inside FIT_TARGET_PEOPLE rather than chasing them further.
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
        tolerance: float = TOLERANCE_PEOPLE,
        target: float | None = None) -> tuple[np.ndarray, dict]:
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

    THE SWEEP is not the six constraints. It is:

        senior  →  disability  →  the FIVE-GROUP PARTITION (see above)

    The partition absorbs carless, low_income, prop_all and need_all into one
    exact, disjoint scaling — so those four are satisfied to float epsilon at
    every checkpoint, and any group the Fréchet clamp forces to be EMPTY is
    zeroed outright rather than crawled towards at O(1/k). Only senior and
    disability are left to iterate on, and they are applied first so that the
    rigid four are the last word before the residual is measured.

    ACTIVE SET: rows that already meet `target` stop being updated, so the few
    genuinely slow rows are cheap to chase instead of dragging every row.

    `tolerance` is the GUARD (what `converged` reports, and what the build refuses
    to publish above). `target` is what the fit chases, and it is far tighter —
    see FIT_TARGET_PEOPLE. A row that cannot reach `target` within max_iter is not
    an error; it is only an error if it is still outside `tolerance`.
    """
    pop = np.asarray(pop, dtype=np.float64)
    n = len(pop)
    target = FIT_TARGET_PEOPLE if target is None else target
    target = min(target, tolerance)   # a caller that loosens the guard gets a
                                      # correspondingly loose fit, never a tighter one
    # What the fit is JUDGED on: the six constraints as originally posed. The
    # re-grouping is an implementation detail of how we reach them — the guard
    # must keep checking the real thing, cell-by-cell, or it is checking itself.
    targets = [
        *(np.asarray(t, dtype=np.float64) for t in
          (carless, low_income, senior, disability)),
        np.asarray(prop_all, dtype=np.float64),
        np.asarray(need_all, dtype=np.float64),
    ]
    masks = [*(HAS_FLAG[f] for f in FLAGS), IN_PROP, IN_NEED]

    # What the fit is DRIVEN by: two overlapping constraints + the two partitions.
    by_flag = dict(zip(FLAGS, targets))          # targets[:4] are the four flags
    soft_masks = [HAS_FLAG[f] for f in RESIDUAL_FLAGS]
    soft_targets = [by_flag[f] for f in RESIDUAL_FLAGS]

    ptargets = partition_targets(pop, carless, low_income, prop_all, need_all)
    if (ptargets < -1e-9).any():
        bad = int((ptargets < -1e-9).any(axis=1).sum())
        raise AssertionError(
            f"the constraint system is INFEASIBLE for {bad:,} geograph(ies): a "
            "flag-partition group has a negative target, which means the marginals "
            "and the unions cannot be realised by ANY assignment of people to flag "
            "combinations. Run them through puma_union.reconcile() first — its "
            "Fréchet clamps are exactly the conditions that make these five targets "
            "non-negative.")
    ptargets = np.maximum(ptargets, 0.0)   # -0.0 / float dust only; see the guard

    # The senior∪disability partition, applied ONLY where u is determined. Where
    # it is not, `u_pinned` is False and the scaling below is a no-op — pinning a
    # free u would over-constrain the fit and move the answer.
    u_lo, u_hi = sd_union_bounds(senior, disability, prop_all, need_all)
    if (u_lo > u_hi + 1e-9).any():
        bad = int((u_lo > u_hi + 1e-9).sum())
        raise AssertionError(
            f"the constraint system is INFEASIBLE for {bad:,} geograph(ies): "
            "|senior ∪ disability| has an empty Fréchet interval "
            "(max(senior, disability, need_all - prop_all) > min(senior + "
            "disability, need_all)). Run them through puma_union.reconcile() first.")
    u_pinned = u_lo >= u_hi                       # the interval is a single point
    stargets = np.maximum(
        sd_partition_targets(pop, senior, disability, need_all, u_lo), 0.0)
    btargets = np.maximum(block_targets(pop, prop_all, need_all, u_lo), 0.0)

    x = np.where(seed > SEED_FLOOR, seed, SEED_FLOOR)
    x = x / x.sum(axis=1, keepdims=True)
    x = x * pop[:, None]

    def residual(block: np.ndarray, rows: np.ndarray) -> np.ndarray:
        """Largest violation of the SIX ORIGINAL constraints per row, in PEOPLE."""
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
        pt = ptargets[active]
        st = stargets[active]
        bt = btargets[active]
        pinned = u_pinned[active]
        chunk = min(ACTIVE_SET_CHECK_EVERY, max_iter - iters)
        for _ in range(chunk):
            # (a) senior and disability, two-sided. Each conserves the row total:
            #     the group goes to `t`, its complement to `pop - t`. This is the
            #     only genuinely iterative part of the fit, and it is only load-
            #     bearing where u is free — where u is pinned, (b) supersedes it.
            for smask, starget in zip(soft_masks, soft_targets):
                t = starget[active]
                inside = xa[:, smask].sum(axis=1)
                outside = xa[:, ~smask].sum(axis=1)
                # A zero denominator is only reachable when its target is zero
                # too (reconcile's clamps guarantee it). Guarded regardless: a
                # 0/0 would send a silent NaN all the way into the tiles.
                s_in = np.where(inside > 0, t / np.where(inside > 0, inside, 1.0), 0.0)
                s_out = np.where(outside > 0, (pa - t) / np.where(outside > 0, outside, 1.0), 0.0)
                xa[:, smask] *= s_in[:, None]
                xa[:, ~smask] *= s_out[:, None]
            # (b) the senior∪disability partition and (c) the prop∩(s|d) block
            #     partition — both only where u is DETERMINED. Rows where it is
            #     not are multiplied by 1.0 and left alone.
            for masks_, tg in ((SD_PARTITION_MASKS, st), (BLOCK_MASKS, bt)):
                for gi, gmask in enumerate(masks_):
                    t = tg[:, gi]
                    inside = xa[:, gmask].sum(axis=1)
                    ok = pinned & (inside > 0)
                    s = np.where(ok, t / np.where(inside > 0, inside, 1.0), 1.0)
                    xa[:, gmask] *= s[:, None]
            # (d) the prop partition. Disjoint groups whose targets sum to pop, so
            #     this is exact and total-preserving — and a zero target LANDS on
            #     zero, it is not approached. Applied LAST so carless, low_income,
            #     prop_all and need_all are exact whenever the residual is sampled.
            for gi, gmask in enumerate(PARTITION_MASKS):
                t = pt[:, gi]
                inside = xa[:, gmask].sum(axis=1)
                s = np.where(inside > 0, t / np.where(inside > 0, inside, 1.0), 0.0)
                xa[:, gmask] *= s[:, None]
        iters += chunk
        x[active] = xa
        keep = residual(xa, active) > target
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
        "target_people": target,
        # How many rows fell short of the (much tighter) fit target but are still
        # inside the guard. Not a failure — but if it ever climbs, the fit has
        # found a new boundary the partitions do not name, and that is worth
        # knowing BEFORE it grows into a guard failure.
        "rows_over_target": int((final > target).sum()),
        "u_pinned_rows": int(u_pinned[pop > 0].sum()),
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
