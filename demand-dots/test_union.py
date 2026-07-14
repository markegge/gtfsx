"""Invariant tests for the demand-dot union estimator (puma_union) and for the
class vocabulary / zoom ladder in build_dots.

What is being defended here is the one property the whole two-mode dot map rests
on: a dot is a PERSON. If `prop_all + backdrop_prop` ever exceeds `total_pop`,
the map has invented people; if a segment ever exceeds the union that contains
it, the map is double-plotting them. Neither can be caught by eye on a national
map of 200 million dots, so it is asserted — here on adversarial fixtures, and
in build_dots.main() on every real block of every state that gets built.

Run:  ./.venv/bin/python test_union.py
      (or: uv run python test_union.py)
"""

import numpy as np

import build_dots as B
import joint_flags as J
import puma_union as U


def _fixtures():
    """Adversarial block groups. Each row is (pop, carless, low_income, senior,
    disability) — including the shapes that actually break naive code."""
    return np.array([
        # pop  carless  low_inc  senior  disab
        [1000,     100,     300,    150,    120],   # ordinary
        [   0,       0,       0,      0,      0],   # empty block group
        [   0,      50,      10,      0,      0],   # marginals with NO population
        [ 100,     100,     100,    100,    100],   # every marginal == pop
        [ 100,     150,      90,     20,     10],   # carless OVER-counts pop
        [   1,       1,       0,      1,      0],   # a one-person block group
        [5000,       0,       0,      0,      0],   # nobody in any segment
        [ 500,     499,     498,    497,    496],   # nearly everyone in all four
        [ 800,       3,       0,      0,      1],   # tiny marginals, big pop
    ], dtype=float).T


def test_invariants_hold_on_adversarial_fixtures():
    pop, carless, low_income, senior, disability = _fixtures()
    n = len(pop)
    # Sweep the whole plausible range of PUMA corrections, including the rails.
    for c_prop in (0.5, 0.77, 0.9485, 1.18, 1.2):
        for c_need in (0.5, 0.776, 0.9085, 1.02, 1.2):
            cls = U.estimate(pop, carless, low_income, senior, disability,
                             np.full(n, c_prop), np.full(n, c_need))
            v = U.check_invariants(cls)
            assert not v, f"c_prop={c_prop} c_need={c_need}: {v}"
    print("ok: invariants hold on adversarial fixtures across the c() range")


def test_partition_and_ordering_explicitly():
    pop, carless, low_income, senior, disability = _fixtures()
    n = len(pop)
    cls = U.estimate(pop, carless, low_income, senior, disability,
                     np.full(n, 0.9485), np.full(n, 0.9085))
    p = cls["total_pop"]
    assert np.array_equal(cls["prop_all"] + cls["backdrop_prop"], p)
    assert np.array_equal(cls["need_all"] + cls["backdrop_need"], p)
    assert np.all(cls["prop_all"] <= cls["need_all"])
    for seg in B.COMPOSITES["propensity"]:
        assert np.all(cls[seg] <= cls["prop_all"]), seg
    for seg in B.COMPOSITES["need"]:
        assert np.all(cls[seg] <= cls["need_all"]), seg
    assert np.all(cls["backdrop_need"] <= cls["backdrop_prop"])
    print("ok: partition, ordering and subset relations")


def test_frechet_bounds():
    pop, carless, low_income, senior, disability = _fixtures()
    n = len(pop)
    # A deliberately absurd correction must NOT be able to push the union out of
    # its arithmetic bounds — that is the entire point of the clamp.
    for c in (0.01, 100.0):
        cls = U.estimate(pop, carless, low_income, senior, disability,
                         np.full(n, c), np.full(n, c))
        cl, li = cls["carless"], cls["low_income"]
        se, di = cls["senior"], cls["disability"]
        assert np.all(cls["prop_all"] >= np.maximum(cl, li))
        assert np.all(cls["prop_all"] <= np.minimum(cl + li, cls["total_pop"]))
        assert np.all(cls["need_all"] >= np.maximum.reduce([cl, li, se, di]))
        # The CONDITIONAL upper bound, not min(Sum m, pop): need can only add
        # seniors and disabled people to prop, so it can never exceed
        # prop_all + senior + disability. min(Sum m, pop) is looser by exactly the
        # carless-and-low-income overlap that prop_all already deduplicated, and
        # clamping to it produced union counts NO SET SYSTEM REALIZES. That was
        # invisible while the union was just a class; it is fatal now that it is a
        # constraint on the flag fit, which is how it was finally caught.
        assert np.all(cls["need_all"] <= cls["prop_all"] + se + di)
        assert np.all(cls["need_all"] <= np.minimum(cl + li + se + di,
                                                    cls["total_pop"]))
        assert not U.check_invariants(cls)
    print("ok: Fréchet bounds survive an absurd c() (incl. the conditional need bound)")


def test_marginals_clipped_to_population():
    # A zero-vehicle household count scaled by a household size can exceed the
    # block group's population; it must be clipped, not allowed to leak into the
    # union and out the other side as more people than exist.
    cls = U.estimate([100], [150], [90], [20], [10], [0.95], [0.91])
    assert cls["carless"][0] == 100
    assert cls["prop_all"][0] == 100          # max(carless, low_income) == pop
    assert cls["backdrop_prop"][0] == 0
    assert not U.check_invariants(cls)
    print("ok: marginals clipped to population")


def test_reconcile_is_idempotent():
    pop, carless, low_income, senior, disability = _fixtures()
    n = len(pop)
    a = U.estimate(pop, carless, low_income, senior, disability,
                   np.full(n, 0.95), np.full(n, 0.91))
    b = U.reconcile(a["total_pop"], a["carless"], a["low_income"], a["senior"],
                    a["disability"], a["prop_all"], a["need_all"])
    for k in a:
        assert np.array_equal(a[k], b[k]), k
    print("ok: reconcile is idempotent (safe to re-run after apportionment)")


def test_union_beats_the_shipped_dedup_constant():
    # The bug this vocabulary replaces: sum(marginals) x 0.6. On a block group
    # where the segments barely overlap, 0.6 under-counts badly; the estimator
    # tracks the independence structure instead.
    pop = np.array([1000.0])
    carless, low_income = np.array([100.0]), np.array([300.0])
    zero = np.zeros(1)
    cls = U.estimate(pop, carless, low_income, zero, zero,
                     np.array([0.9485]), np.array([0.9085]))
    old = round((100 + 300) * 0.6)                     # = 240
    indep = 1000 * (1 - 0.9 * 0.7)                     # = 370
    assert cls["prop_all"][0] >= max(100, 300)         # ...and 240 is not
    assert abs(cls["prop_all"][0] - 0.9485 * indep) <= 1
    assert cls["prop_all"][0] > old
    print(f"ok: union={cls['prop_all'][0]} vs the old x0.6 constant={old} "
          f"(floor is max(m)=300)")


def test_dot_apportionment_is_exact_and_unbiased():
    """The dot split across the 16 flag cells must conserve the budget EXACTLY
    and be UNBIASED in every cell. Getting only the first is the trap.

    Largest-remainder gives an exact total and is BADLY BIASED here: the cell
    shares are fixed and wildly unequal, so the same rare cells lose the leftover
    units in every single block, forever. Measured on Gallatin County it cost
    -50.7% of the carless dots and -31.9% of the disability dots while every total
    balanced perfectly. This test is the regression guard.
    """
    rng = np.random.default_rng(0)
    shares = np.array([
        .5459, .0173, .1805, .0197, .0887, .0025, .0226, .0032,
        .0341, .0017, .0232, .0055, .0321, .0027, .0148, .0054,
    ])
    shares = shares / shares.sum()

    # 1. exact conservation, always
    for _ in range(500):
        budget = int(rng.integers(0, 400))
        out = B._apportion_dots(budget, shares, rng)
        assert out.sum() == budget, (budget, out.sum())
        assert np.all(out >= 0)

    # 2. UNBIASED. Sum many small blocks (25 dots each — exactly the size where
    #    every rare cell wants a FRACTION of a dot, which is where a biased
    #    rounder does its damage) and score each cell as a Z-SCORE against its
    #    theoretical standard error. A z-score is the right instrument here and a
    #    raw percentage is not: the rarest cell (0.25% of people) gets a quarter
    #    of a dot per block, so its count is dominated by sampling noise and a few
    #    percent of drift means nothing. Bias shows up as a z that does NOT shrink
    #    as the trials grow; noise does.
    trials, budget = 40_000, 25
    tot = np.zeros(16, dtype=np.int64)
    for _ in range(trials):
        tot += B._apportion_dots(budget, shares, rng)
    want = shares * budget * trials
    assert tot.sum() == budget * trials          # still exact, every time

    frac = (shares * budget) % 1.0               # each cell rounds up w.p. frac
    se = np.sqrt(trials * frac * (1 - frac))
    z = (tot - want) / np.maximum(se, 1e-9)
    assert np.abs(z).max() < 5.0, dict(zip(range(16), np.round(z, 2)))

    # 3. and largest-remainder really would have failed it, catastrophically.
    #    Pin the bug so nobody "simplifies" this back into existence.
    lr = np.zeros(16, dtype=np.int64)
    v = shares * budget
    base = np.floor(v).astype(np.int64)
    short = budget - int(base.sum())
    if short > 0:
        base[np.argsort(-(v - base), kind="stable")[:short]] += 1
    lr = base * trials                            # deterministic: the SAME every block
    lr_err = (lr - want) / np.maximum(want, 1)
    assert lr_err.min() < -0.90, (
        "largest-remainder is supposed to starve the rare cells here; if it no "
        "longer does, this regression guard has stopped guarding anything")
    print(f"ok: dot apportionment exact + unbiased (worst |z| = {np.abs(z).max():.2f} "
          f"over {trials:,} blocks); largest-remainder would starve a cell by "
          f"{lr_err.min()*100:.0f}%")


def test_zoom_ladder_nests_and_thins():
    slots = B.LADDER_SLOTS
    period = B.LADDER_PERIOD
    assert period == max(B.ZOOM_DENSITY_LADDER.values())
    for z, stride in B.ZOOM_DENSITY_LADDER.items():
        present = [r for r in range(period) if slots[r] <= z]
        assert len(present) == period // stride, (z, stride, present)
    # Nesting: the set of dots at zoom z must be a SUBSET of the set at z+1, or
    # dots would vanish as you zoom in.
    zs = sorted(B.ZOOM_DENSITY_LADDER)
    for a, b in zip(zs, zs[1:]):
        sa = {r for r in range(period) if slots[r] <= a}
        sb = {r for r in range(period) if slots[r] <= b}
        assert sa <= sb, (a, b)
    assert B.zoom_stride(B.TILE_MIN_ZOOM) == 32
    assert B.zoom_stride(B.FULL_DENSITY_ZOOM) == 1
    assert B.zoom_stride(B.TILE_MAX_ZOOM) == 1
    # FULL_DENSITY_ZOOM is the SHALLOWEST full-density rung, not the deepest zoom
    # on the ladder — the frontend stops scaling its "1 dot = N" from here in, so
    # naming z15 while the tiles are already full at z13 would under-report the
    # density the map is actually drawing at z13 and z14.
    assert B.FULL_DENSITY_ZOOM == 13
    assert all(s == 1 for z, s in B.ZOOM_DENSITY_LADDER.items()
               if z >= B.FULL_DENSITY_ZOOM)
    assert B.ZOOM_DENSITY_LADDER[B.FULL_DENSITY_ZOOM - 1] > 1
    # Full density has to land ON a zoom the archive actually has, or the legend
    # promises a 1:5 ratio at a zoom whose tiles were never built.
    assert B.FULL_DENSITY_ZOOM <= B.TILE_MAX_ZOOM
    print(f"ok: zoom ladder nests and thins {B.ZOOM_DENSITY_LADDER}")


def test_tippecanoe_flags_let_the_ladder_be_the_only_thinning():
    """The ladder is only an honest ratio if nothing ELSE drops dots.

    Two regressions live here, both of which shipped:

    1. tippecanoe's DEFAULT --drop-rate (2.5, below --base-zoom) thinned every
       tile by a further 1/2.5 per zoom on top of our stride. The z8 tiles ended
       up carrying 2% of what the legend claimed — 1 dot per ~1,850 people where
       the legend said 40. Nothing in the client can detect this; it has to be
       prevented at build time.
    2. --extend-zooms-if-still-dropping silently built a z16 the legend didn't
       know about... and then the legend was hand-edited to say 16 while the build
       still said 15, so the frontend asked Mapbox for tiles that did not exist
       and the layer went BLANK from z16 in.
    """
    cmd = B.tippecanoe_command()
    assert "--drop-rate=1" in cmd, cmd
    # No zoom below base zoom == no zoom a drop rate could apply to, belt and braces.
    assert f"--base-zoom={B.TILE_MIN_ZOOM}" in cmd, cmd
    assert f"--minimum-zoom={B.TILE_MIN_ZOOM}" in cmd, cmd
    assert f"--maximum-zoom={B.TILE_MAX_ZOOM}" in cmd, cmd
    # The flag that made the built maxzoom non-deterministic. It must stay gone.
    assert "--extend-zooms" not in cmd, cmd
    # The one number the frontend hands Mapbox as the source maxzoom.
    assert B.legend_payload()["max_zoom"] == B.TILE_MAX_ZOOM
    assert B.legend_payload()["min_zoom"] == B.TILE_MIN_ZOOM
    print(f"ok: tippecanoe flags keep the stride the only thinning (z{B.TILE_MIN_ZOOM}"
          f"-{B.TILE_MAX_ZOOM}, drop-rate 1)")


def test_the_tile_schema_is_seventeen_integer_codes():
    """ONE DOT = ONE PERSON. The tiles carry an integer `d`, not a class string."""
    assert B.TILE_ATTR == "d"
    assert B.FLAG_BITS == {"carless": 1, "low_income": 2, "senior": 4, "disability": 8}
    assert B.JOBS_CODE == 16
    assert B.POPULATION_CODES == list(range(16))
    assert B.TILE_CODES == [*range(16), 16]
    # The composites and backdrops are NOT tile classes any more — they are
    # unions of flags, evaluated at render time. That is what makes the backdrop
    # "population minus the SELECTION" instead of "population minus the
    # composite", which is what left a quarter of the population undrawn.
    assert not hasattr(B, "DOT_CLASSES")

    legend = B.legend_payload()
    assert legend["schema"] == "attribute-dots-v1"
    assert legend["attribute"] == "d"
    assert legend["flags"] == B.FLAG_BITS
    assert legend["jobs_code"] == 16
    assert legend["zoom_ladder"]["strides"]["8"] == 32
    assert legend["zoom_ladder"]["full_density_zoom"] == 13
    # The frontend builds its tile URL from this and refuses to guess; without it
    # the whole demand-dots layer stays disabled.
    assert legend["archive"] == B.TILESET_ARCHIVE and legend["archive"]
    # demandLegend.ts THROWS at import time if this block disagrees with the
    # frontend's own model — senior/disability are NEED-ONLY, because a
    # car-owning senior must never render as "propensity".
    assert legend["modes"]["propensity"]["segments"] == ["carless", "low_income"]
    assert legend["modes"]["need"]["segments"] == [
        "carless", "low_income", "senior", "disability"]
    assert B.FLAG_DEFS["senior"]["modes"] == ["need"]
    assert B.FLAG_DEFS["disability"]["modes"] == ["need"]
    # One grain for the whole population universe: a dot is a person, and people
    # do not come in grains. (The old schema had to keep nine per_dot values equal
    # by hand or the map lied about relative density.)
    assert B.unit_per_dot("population") == B.PEOPLE_PER_DOT
    assert legend["units"]["population"]["per_dot"] == B.PEOPLE_PER_DOT
    print(f"ok: 17-code attribute-dot schema, all population dots 1:{B.PEOPLE_PER_DOT}")


def test_flag_bits_agree_across_every_module():
    """The bit values are load-bearing in four places. Mapbox GL has no bitwise
    operators, so the frontend ENUMERATES the codes matching each flag from these
    bits — a mismatch does not break the map, it colors the wrong people."""
    import build_puma_corrections as BPC
    assert B.FLAG_BITS == J.FLAG_BITS == BPC.FLAG_BITS
    assert J.N_CELLS == BPC.N_CELLS == 16
    # The cell columns in data/puma_joint.csv are INDEXED by this bit order.
    assert [J.cell_label(i) for i in (0, 1, 2, 3, 15)] == [
        "(none)", "carless", "low_income", "carless+low_income",
        "carless+low_income+senior+disability"]
    print("ok: flag bits identical in build_dots, joint_flags, build_puma_corrections")


def test_the_joint_fit_reproduces_the_marginals_and_the_union():
    """THE CLAIM OF THE REDESIGN: turning classes into flags moved nobody.

    Every dot is a person carrying flags. So the count of dots with flag f must
    still be the ACS marginal, and the count with ANY flag must still be the same
    PUMS-derived union the old `need_all` class carried. Asserted here on the
    adversarial fixtures, and in build_dots.main() on every real block group.
    """
    pop, carless, low_income, senior, disability = _fixtures()
    n = len(pop)
    cls = U.estimate(pop, carless, low_income, senior, disability,
                     np.full(n, 0.9485), np.full(n, 0.9085))
    # A realistic PUMA seed (the national row), same for every fixture.
    seed = np.tile(U.joint_table().loc[U.DEFAULT_KEY,
                                       [f"cell_{i}" for i in range(16)]].to_numpy(float), (n, 1))
    cells, diag = J.fit(cls["total_pop"], cls["carless"], cls["low_income"],
                        cls["senior"], cls["disability"], cls["prop_all"],
                        cls["need_all"], seed)
    assert diag["converged"], diag

    got = J.marginals_from_cells(cells)
    for key in ("carless", "low_income", "senior", "disability", "prop_all", "need_all"):
        assert np.allclose(got[key], cls[key], atol=J.TOLERANCE_PEOPLE), (
            key, got[key], cls[key])
    # The cells are a PARTITION: every person is in exactly one of the 16, so
    # nobody can be drawn twice and nobody can vanish.
    assert np.allclose(cells.sum(axis=1), cls["total_pop"], atol=1e-9)
    assert np.all(cells >= -1e-12)
    assert np.allclose(got["backdrop"], cls["total_pop"] - cls["need_all"],
                       atol=J.TOLERANCE_PEOPLE)
    print("ok: the 16-cell fit reproduces every ACS marginal AND both PUMS unions")


def _real_boundary_block_groups():
    """The block groups that made the nationwide build fail, with their real ACS
    numbers. CA/FL/NJ/NY/TX all died the same way; these are the exact rows.

        GEOID, pop, carless, low_income, senior, disability, prop_all, need_all
    """
    return [
        # ── prop_all pinned to its Fréchet FLOOR: prop_all == low_income, so
        #    every carless person is also low-income and the "carless but not
        #    low-income" cells MUST be empty. (Texas, worst residual 0.0557.)
        ("481410103582", 12348, 114, 2911, 198, 579, 2911, 3250),
        ("482090109093", 9056, 230, 3325, 321, 681, 3325, 3633),
        # ── prop_all pinned to its Fréchet CEILING: prop_all == carless +
        #    low_income, so the two groups are DISJOINT and the "carless AND
        #    low-income" cells must be empty.
        ("481576732023", 23964, 102, 2831, 2246, 1156, 2933, 5360),
        # ── need_all == prop_all as well: nobody is a senior/disabled person
        #    outside the prop set either. TWO empty groups at once. (Worst
        #    residual in the country: 0.1173.)
        ("482917003022", 19209, 81, 11249, 596, 938, 11249, 11249),
        # ── |senior ∪ disability| FORCED: senior == need_all, so every needy
        #    person is a senior and nobody is disabled-but-not-senior. This is
        #    the second family — the prop partition alone does not catch it.
        ("060014044001", 2162, 0, 40, 503, 32, 40, 503),
        ("060014212003", 726, 0, 10, 290, 24, 10, 290),
        # ── the OVERLAP forced to zero: need_all - prop_all == senior +
        #    disability, so every senior and every disabled person is outside the
        #    prop set and NO ONE is both needy-by-age/disability and poor/carless.
        #    The third family. (California.)
        ("060014228001", 4422, 544, 738, 11, 24, 1013, 1048),
        ("360710150033", 2328, 505, 1439, 19, 19, 1446, 1484),
    ]


def test_the_constraint_system_is_feasible_on_the_boundary_block_groups():
    """FEASIBILITY, not convergence — the question that had to be answered first.

    When the nationwide build failed, the live possibility was that the Fréchet
    clamp or the marginals were producing a constraint system that NO 16-cell
    distribution can satisfy. If so, a looser tolerance would have papered over a
    real arithmetic bug. It is not so, and this proves it CONSTRUCTIVELY: for each
    block group that failed, build an explicit INTEGER assignment of its people to
    flag combinations and check it reproduces all seven numbers exactly.

    An integer witness is a fortiori a non-negative real one, so the system is
    feasible and IPF was right to keep trying — it was just crawling.

    The witness is exactly reconcile()'s five partition targets, which is the
    point: those clamps ARE the feasibility conditions. If reconcile ever stops
    guaranteeing them, this test constructs a negative count and fails.
    """
    for geoid, pop, C, L, S, D, P, N in _real_boundary_block_groups():
        # reconcile's invariants — the conditions under which a witness exists
        assert max(C, L) <= P <= min(C + L, pop), geoid
        assert max(P, S, D) <= N <= min(P + S + D, pop), geoid

        # the five prop-partition groups, in people (joint_flags' closed form)
        groups = {
            "(none)": pop - N, "s|d only": N - P, "carless only": P - L,
            "low_income only": P - C, "carless+low_income": C + L - P,
        }
        assert all(v >= 0 for v in groups.values()), (geoid, groups)
        assert sum(groups.values()) == pop, (geoid, groups)

        # u = |senior ∪ disability| — its Fréchet interval must be non-empty
        u_lo, u_hi = max(S, D, N - P), min(S + D, N)
        assert u_lo <= u_hi, (geoid, u_lo, u_hi)

        # a witness at u = u_lo: the sd-partition and the overlap block
        u = u_lo
        assert pop - N >= 0 and N - u >= 0 and u - D >= 0 and u - S >= 0 \
            and S + D - u >= 0, (geoid, u)
        assert P + u - N >= 0, (geoid, u)   # |(senior ∪ disability) ∩ prop|

        # and now the real thing: joint_flags.fit must land on it
        seed = np.tile(U.joint_table().loc[
            U.DEFAULT_KEY, [f"cell_{i}" for i in range(16)]].to_numpy(float), (1, 1))
        cells, diag = J.fit([pop], [C], [L], [S], [D], [P], [N], seed)
        assert diag["converged"], (geoid, diag)
        got = J.marginals_from_cells(cells)
        for key, want in (("carless", C), ("low_income", L), ("senior", S),
                          ("disability", D), ("prop_all", P), ("need_all", N)):
            assert abs(got[key][0] - want) <= J.TOLERANCE_PEOPLE, (geoid, key,
                                                                   got[key][0], want)
        assert abs(cells.sum() - pop) < 1e-6, geoid
        assert (cells >= -1e-12).all(), geoid
    print(f"ok: all {len(_real_boundary_block_groups())} boundary block groups are "
          "FEASIBLE (explicit integer witness) and the fit lands on them")


def test_forced_empty_groups_are_exactly_zero_not_merely_small():
    """The bug, stated as a property.

    Every one of these block groups has at least one flag-combination group that
    the arithmetic forces to be EMPTY. The old six-constraint IPF could only
    approach those zeros — it converges O(1/k) on a boundary solution — and after
    40,000 iterations was still carrying ~0.18 of a person in cells that must hold
    nobody. That leaked mass WAS the residual, to the digit, and it is what failed
    the build on the five largest states.

    So: not "small". ZERO. If a future change reintroduces a formulation that has
    to discover these zeros rather than name them, this test fails immediately —
    at 1e-9 people, not at the 0.05 guard, so it fails long before a build does.
    """
    for geoid, pop, C, L, S, D, P, N in _real_boundary_block_groups():
        seed = np.tile(U.joint_table().loc[
            U.DEFAULT_KEY, [f"cell_{i}" for i in range(16)]].to_numpy(float), (1, 1))
        cells, _ = J.fit([pop], [C], [L], [S], [D], [P], [N], seed)
        row = cells[0]

        empty_groups = 0
        for masks, targets, labels in (
            (J.PARTITION_MASKS,
             J.partition_targets([pop], [C], [L], [P], [N])[0],
             J.PARTITION_LABELS),
        ):
            for mask, want, label in zip(masks, targets, labels):
                got = row[mask].sum()
                assert abs(got - want) < 1e-6, (geoid, label, got, want)
                if want == 0:
                    empty_groups += 1
                    assert got < 1e-9, (
                        f"{geoid}: the group '{label}' must hold NOBODY "
                        f"(target 0) but the fit left {got:.6f} people in it — "
                        "the fit is approaching the zero instead of landing on it")

        # the senior∪disability axis, where u is forced
        u_lo, u_hi = J.sd_union_bounds([S], [D], [P], [N])
        if u_lo[0] >= u_hi[0]:
            st = J.sd_partition_targets([pop], [S], [D], [N], u_lo)[0]
            for mask, want, label in zip(J.SD_PARTITION_MASKS, st,
                                         J.SD_PARTITION_LABELS):
                got = row[mask].sum()
                assert abs(got - want) < 1e-6, (geoid, label, got, want)
                if want == 0:
                    empty_groups += 1
                    assert got < 1e-9, (geoid, label, got)
            bt = J.block_targets([pop], [P], [N], u_lo)[0]
            for mask, want, label in zip(J.BLOCK_MASKS, bt, J.BLOCK_LABELS):
                got = row[mask].sum()
                assert abs(got - want) < 1e-6, (geoid, label, got, want)
                if want == 0:
                    empty_groups += 1
                    assert got < 1e-9, (geoid, label, got)

        assert empty_groups, f"{geoid} was meant to be a BOUNDARY case but no " \
                             "group is forced empty — the fixture is stale"
    print("ok: every arithmetically-forced-empty flag group is EXACTLY zero "
          "(<1e-9 people), not merely inside the guard")


def test_the_fit_is_driven_far_past_the_guard():
    """The guard must pass with room, not by a whisker.

    A fit that stops the instant it scrapes under TOLERANCE_PEOPLE cannot tell a
    converged block group from a crawling one — which is precisely how the
    nationwide failure stayed invisible until it tipped over. The fit therefore
    chases FIT_TARGET_PEOPLE, tens of thousands of times tighter than the guard,
    and the guard is left to catch genuine infeasibility.
    """
    assert J.FIT_TARGET_PEOPLE < J.TOLERANCE_PEOPLE / 1000, (
        "the fit target must be orders of magnitude inside the guard, or a pass "
        "says nothing about how close the build came to failing")
    for geoid, pop, C, L, S, D, P, N in _real_boundary_block_groups():
        seed = np.tile(U.joint_table().loc[
            U.DEFAULT_KEY, [f"cell_{i}" for i in range(16)]].to_numpy(float), (1, 1))
        _, diag = J.fit([pop], [C], [L], [S], [D], [P], [N], seed)
        assert diag["max_residual_people"] <= J.FIT_TARGET_PEOPLE, (geoid, diag)
    print(f"ok: the boundary block groups converge to <= {J.FIT_TARGET_PEOPLE:g} "
          f"people, {J.TOLERANCE_PEOPLE / J.FIT_TARGET_PEOPLE:,.0f}x inside the guard")


def test_infeasible_constraints_are_rejected_not_fitted():
    """The guard the whole investigation was about.

    If the marginals and the unions are NOT jointly realisable — need_all above
    prop_all + senior + disability, say, which is the latent clamp bug reconcile's
    conditional bound exists to prevent — then no 16-cell distribution satisfies
    them and the fit must SAY SO, not converge to something plausible-looking.
    """
    seed = np.tile(U.joint_table().loc[
        U.DEFAULT_KEY, [f"cell_{i}" for i in range(16)]].to_numpy(float), (1, 1))
    # need_all = 100 but prop_all + senior + disability = 10 + 5 + 5 = 20.
    # There are not enough seniors and disabled people in existence to fill it.
    try:
        J.fit([1000], [10], [8], [5], [5], [10], [100], seed)
    except AssertionError as exc:
        assert "INFEASIBLE" in str(exc), exc
    else:
        raise AssertionError(
            "an unrealisable constraint system was FITTED instead of rejected")
    print("ok: an infeasible constraint system is rejected, not quietly fitted")


def test_the_joint_is_not_independence():
    """The whole reason the joint is MEASURED and not assumed.

    If the flags were assigned independently at random, the union would be the
    independence backbone — which is exactly what c() exists to correct. The PUMS
    joint must disagree with independence, and in the known direction (the traits
    are positively correlated, so the true union is SMALLER).
    """
    cells = U.joint_table().loc[U.DEFAULT_KEY, [f"cell_{i}" for i in range(16)]].to_numpy(float)
    marg = {f: cells[[i for i in range(16) if i & b]].sum()
            for f, b in B.FLAG_BITS.items()}
    true_union = 1.0 - cells[0]
    indep_union = 1.0 - np.prod([1 - m for m in marg.values()])
    assert true_union < indep_union, (true_union, indep_union)
    # Nationally the traits overlap enough that independence overstates the union
    # by ~10% — the same order as c_need (0.909).
    ratio = true_union / indep_union
    assert 0.85 <= ratio <= 0.95, ratio
    assert abs(ratio - U.corrections().loc[U.DEFAULT_KEY, "c_need"]) < 0.05
    print(f"ok: the measured joint is NOT independence "
          f"(true union / independence = {ratio:.4f}, c_need = "
          f"{U.corrections().loc[U.DEFAULT_KEY, 'c_need']:.4f})")


def test_joint_table_is_sane():
    tab = U.joint_table()
    cols = [f"cell_{i}" for i in range(16)]
    assert U.DEFAULT_KEY in tab.index
    assert len(tab) > 2000
    # Every row is a distribution over the 16 cells.
    assert np.allclose(tab[cols].sum(axis=1), 1.0, atol=1e-4)
    assert (tab[cols] >= 0).all().all()
    # The national row must reproduce the published marginals it was built from.
    nat = tab.loc[U.DEFAULT_KEY, cols].to_numpy(float)
    carless = nat[[i for i in range(16) if i & 1]].sum()
    low = nat[[i for i in range(16) if i & 2]].sum()
    assert 0.04 <= carless <= 0.08, carless      # ~5.8% of people nationally
    assert 0.24 <= low <= 0.31, low              # ~27.5% under 200% FPL
    print(f"ok: 16-cell joint table ({len(tab)} PUMAs), national carless "
          f"{carless*100:.1f}% / low-income {low*100:.1f}%")


def test_corrections_table_is_sane():
    tab = U.corrections()
    assert U.DEFAULT_KEY in tab.index
    d = tab.loc[U.DEFAULT_KEY]
    assert 1.7 <= d["hh_size_carless"] <= 1.9, d["hh_size_carless"]
    assert 0.8 <= d["c_prop"] <= 1.0
    assert 0.8 <= d["c_need"] <= 1.0
    assert len(tab) > 2000
    body = tab.drop(index=U.DEFAULT_KEY)
    assert body["hh_size_carless"].between(*B_HH).all()
    assert body["c_prop"].between(*B_C).all()
    assert body["c_need"].between(*B_C).all()
    # Puerto Rico publishes no PUMS person file, so it is NOT in the table and
    # must fall back to the national row rather than build with c() = NaN.
    pr = U.puma_params(__import__("pandas").Series(["72127001001"]))
    assert abs(pr["c_prop"].iloc[0] - d["c_prop"]) < 1e-9
    print(f"ok: corrections table ({len(tab)} rows), PR falls back to __default__")


def test_tract_to_puma_covers_connecticut_old_counties():
    # CT is pinned to the ACS 2021 vintage (old county codes 001-015) because
    # the TIGER 2020 blocks still carry them. The crosswalk must speak the same
    # dialect or every CT block group would miss its PUMA and silently take the
    # national default.
    x = U.tract_to_puma()
    ct = [t for t in x if t.startswith("09")]
    assert ct, "no CT tracts in the crosswalk"
    counties = {t[2:5] for t in ct}
    assert counties <= {"001", "003", "005", "007", "009", "011", "013", "015"}, counties
    print(f"ok: CT crosswalk uses the old county codes ({len(ct)} tracts)")


B_HH = (1.00, 3.50)
B_C = (0.50, 1.20)


if __name__ == "__main__":
    test_invariants_hold_on_adversarial_fixtures()
    test_partition_and_ordering_explicitly()
    test_frechet_bounds()
    test_marginals_clipped_to_population()
    test_reconcile_is_idempotent()
    test_union_beats_the_shipped_dedup_constant()
    test_dot_apportionment_is_exact_and_unbiased()
    test_zoom_ladder_nests_and_thins()
    test_tippecanoe_flags_let_the_ladder_be_the_only_thinning()
    test_the_tile_schema_is_seventeen_integer_codes()
    test_flag_bits_agree_across_every_module()
    test_the_joint_fit_reproduces_the_marginals_and_the_union()
    test_the_constraint_system_is_feasible_on_the_boundary_block_groups()
    test_forced_empty_groups_are_exactly_zero_not_merely_small()
    test_the_fit_is_driven_far_past_the_guard()
    test_infeasible_constraints_are_rejected_not_fitted()
    test_the_joint_is_not_independence()
    test_joint_table_is_sane()
    test_corrections_table_is_sane()
    test_tract_to_puma_covers_connecticut_old_counties()
    print("\nAll union / invariant / ladder tests passed.")
