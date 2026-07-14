"""Tests for the ZOOM-DENSITY LADDER's phase — the guard that keeps "1 dot = N
people" true when the archive is built out of 52 independently-built states.

WHAT IS BEING DEFENDED HERE
───────────────────────────
The ladder's promise is arithmetic, not aspiration: at zoom z, exactly 1/stride(z)
of each code's dots are in the tiles. It keeps that promise with a SYSTEMATIC
sample — dot k of a code goes in at LADDER_SLOTS[k % 128] — which is exact to
within one dot. verify_tiles.py checks the built archive against exactly that
arithmetic (expected_at_zoom), so the emitter and the checker have to be counting
the same thing or the guard is measuring nothing.

They were not. `k` is a running count, and the nationwide build runs one process
per state, so k restarted at 0 in all 52 of them. Slot 0 is the z8 slot — the
rarest rung — so every state independently rounded its z8 count UP to
ceil(N_s/128), and 52 half-dot excesses accumulated:

    carless+disability, z8:  expected 947, the archive carried 975  (+2.9%)

Six times the verify tolerance, on the codes that matter most (the rare ones —
their z8 count is small, so a whole extra dot per state is a big share) and only
at the low zooms (only there is the stride big enough to have a remainder worth
rounding). Nothing was thinning the tiles; the emitter was over-counting them.
The fix (restride_lines) re-phases the whole archive onto ONE ordinal per code at
the concatenation, the only point where all 52 states exist at once.

The tests:

  1. The ladder slots nest and hit their stride exactly — the arithmetic the
     legend's "1 dot = N" is quoting.
  2. A ONE-file archive is unchanged by the re-phase (the per-state .ldjson is
     still self-sufficient — the re-tag is the identity there).
  3. THE REGRESSION: a 52-state archive carries exactly the dots the ladder
     promises, per code, at every zoom — byte-for-byte equal to what
     verify_tiles.expected_at_zoom() will demand of it. Run against the old
     per-state ordinal this fails by +28 dots on the rare codes at z8, which is
     the bug that shipped.
  4. The old per-state-ordinal scheme is exhibited and shown to be biased, so
     nobody "simplifies" the re-phase back out again.
  5. The bias is a CEILING, not noise: it is strictly positive, it is worst for
     the rare codes, and it vanishes at high zooms. That signature is what a
     future reader will be looking at in a verify_tiles failure.
  6. A per-dot HASH — the obvious "just make it stateless" fix — is 30x LESS
     accurate than the running ordinal, and would fail verify_tiles outright.
     Pinned so the ordinal is not traded away for one.

Run: ./.venv/bin/python test_ladder.py
"""

import hashlib
import json
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

from build_dots import (
    LADDER_PERIOD,
    LADDER_SLOTS,
    TILE_MAX_ZOOM,
    TILE_MIN_ZOOM,
    ZOOM_DENSITY_LADDER,
    config_hash,
    restride_lines,
)
from verify_tiles import expected_at_zoom

HERE = Path(__file__).parent
PY = str(HERE / ".venv" / "bin" / "python")

# 52 states, shaped like the real ones: two common codes, two RARE ones, jobs —
# and a per-state count that VARIES and is never a multiple of the 128-period.
# Both of those matter. A multiple of the period has no remainder to round up, and
# equal states would all round up by the same amount, which is a tidier bug than
# the real one (there, the 52 remainders are scattered and average about half a
# dot each).
STATES = [f"S{i:02d}" for i in range(52)]
CODE_BASE = {0: 9_137, 2: 3_001, 9: 2_331, 13: 337, 16: 5_555}
# {state: {code: dots}} — deterministic, varied, coprime-ish with the period.
STATE_COUNTS = {
    st: {code: base + (i * 37 + code * 11) % 113 for code, base in CODE_BASE.items()}
    for i, st in enumerate(STATES)
}
TOTALS = {code: sum(c[code] for c in STATE_COUNTS.values()) for code in CODE_BASE}


def _feature(code: int, i: int) -> str:
    """One dot, tagged with the minzoom a STATE-LOCAL ordinal gives it — i.e.
    exactly what build_dots.py writes into a per-state .ldjson."""
    mz = LADDER_SLOTS[i % LADDER_PERIOD]
    return (f'{{"type": "Feature", "properties": {{"d": {code}}}, '
            f'"geometry": {{"type": "Point", "coordinates": [-112.0, 47.0]}}, '
            f'"tippecanoe": {{"minzoom": {mz}}}}}')


def _write_states(d: Path) -> None:
    """52 per-state .ldjson + sidecars, each one built the way the real per-state
    processes build them: its own ordinal, starting at 0."""
    for st, counts in STATE_COUNTS.items():
        lines = []
        for code, n in counts.items():
            lines += [_feature(code, i) for i in range(n)]
        (d / f"dots_{st}.ldjson").write_text("\n".join(lines) + "\n")
        (d / f"dots_{st}.ldjson.meta.json").write_text(json.dumps({
            "config_hash": config_hash(),
            "code_dots": {str(c): n for c, n in counts.items()},
            "schema": "attribute-dots-v1",
        }))


def _old_scheme_at_zoom(code: int, zoom: int) -> int:
    """What the PRE-FIX emitter put in the z tiles: each state's own ordinal,
    starting at 0, rounded up in each of the 52 states independently."""
    return sum(expected_at_zoom(c[code], zoom) for c in STATE_COUNTS.values())


def _histogram(lines) -> dict[int, dict[int, int]]:
    """{code: {minzoom: count}} out of a stream of .ldjson bytes."""
    hist: dict[int, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for line in lines:
        f = json.loads(line)
        hist[f["properties"]["d"]][f["tippecanoe"]["minzoom"]] += 1
    return hist


def _at_zoom(hist: dict[int, dict[int, int]], code: int, zoom: int) -> int:
    """Dots of `code` that the z tiles carry: every slot at or below z."""
    return sum(n for mz, n in hist[code].items() if mz <= zoom)


# ─── tests ────────────────────────────────────────────────────────────────────

def test_ladder_slots_hit_their_stride_exactly():
    """One period of the ladder puts exactly period/stride(z) dots in the z
    tiles, and the sets NEST (a dot in z8 is in every zoom above it — dots must
    never pop out of existence as you zoom in)."""
    for z, stride in ZOOM_DENSITY_LADDER.items():
        got = sum(1 for slot in LADDER_SLOTS if slot <= z)
        assert got == LADDER_PERIOD // stride, (
            f"z{z}: {got}/{LADDER_PERIOD} slots, but stride {stride} promises "
            f"{LADDER_PERIOD // stride} — the legend's '1 dot = N' is a lie by "
            f"a factor of {got / (LADDER_PERIOD / stride):.2f}")
    for z in range(TILE_MIN_ZOOM, TILE_MAX_ZOOM):
        lo = {r for r, s in enumerate(LADDER_SLOTS) if s <= z}
        hi = {r for r, s in enumerate(LADDER_SLOTS) if s <= z + 1}
        assert lo <= hi, f"the z{z} dots are not a subset of the z{z+1} dots"
    print("ok: one ladder period carries exactly 1/stride of the dots, and nests")


def test_single_state_archive_is_unchanged():
    """The re-phase must be the IDENTITY on a one-state archive: with one input
    the archive-wide ordinal IS that state's own 0-based ordinal. A per-state
    .ldjson stays self-sufficient — you can still tile one state on its own."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_states(d)
        raw = (d / f"dots_{STATES[0]}.ldjson").read_bytes().splitlines(keepends=True)
        assert list(restride_lines(iter(raw))) == raw, (
            "restride_lines changed a single-state archive — the per-state "
            "minzoom and the archive-wide one must agree when there is one state")
    print("ok: a one-state archive is untouched by the re-phase (identity)")


def test_multistate_archive_carries_what_the_ladder_promises():
    """THE REGRESSION. 52 states through the real --cat-verified path: every code
    at every zoom must carry EXACTLY the number of dots verify_tiles.py is about
    to demand of the built archive. Zero tolerance — this is arithmetic.

    Against the pre-fix emitter (each state's ordinal starting at 0) this fails
    on every rare code at the low zooms — the same signature, and for the same
    reason, as the +2.9% the real nationwide archive was carrying.
    """
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_states(d)
        proc = subprocess.run(
            [PY, str(HERE / "build_dots.py"), "--cat-verified", str(d / "*.ldjson")],
            capture_output=True)
        assert proc.returncode == 0, proc.stderr.decode()[:800]
        hist = _histogram(proc.stdout.splitlines())

        for code, total in TOTALS.items():
            assert sum(hist[code].values()) == total, "the concat lost dots"
            for z in range(TILE_MIN_ZOOM, TILE_MAX_ZOOM + 1):
                want = expected_at_zoom(total, z)
                got = _at_zoom(hist, code, z)
                assert got == want, (
                    f"z{z} code {code}: the archive carries {got:,} dots, the "
                    f"ladder promises {want:,} ({(got - want) / want * 100:+.1f}%). "
                    f"verify_tiles.py fails this archive. Each of the {len(STATES)} "
                    f"states is rounding its own z{z} count instead of the "
                    f"archive rounding once — see restride_lines().")
    print(f"ok: a {len(STATES)}-state archive carries EXACTLY the ladder's dots, "
          f"per code, at every zoom (what verify_tiles.py demands)")


def test_the_old_per_state_ordinal_was_biased():
    """Exhibit the bug so the fix cannot be quietly reverted. Summing per-state
    0-based ordinals over-counts z8 for EVERY code — it is a ceiling, so it can
    only ever be positive — and it does it worst for the rare ones."""
    worst = 0.0
    for code, total in TOTALS.items():
        promised = expected_at_zoom(total, TILE_MIN_ZOOM)
        old = _old_scheme_at_zoom(code, TILE_MIN_ZOOM)      # 52 ordinal restarts
        assert old > promised, (
            f"code {code}: the per-state ordinal did not over-count, so this "
            "test is no longer exhibiting the bug it was written for")
        worst = max(worst, (old - promised) / promised)
    assert worst > 0.005, (
        f"the pre-fix bias is only {worst:.2%} here — under verify's 0.5% "
        "tolerance, so this fixture would not have caught the real bug. Make the "
        "rare codes rarer.")
    print(f"ok: the old per-state ordinal over-counts z{TILE_MIN_ZOOM} by up to "
          f"{worst:.1%} (a ceiling — always positive, worst on the rare codes)")


def test_the_bias_signature_is_rare_codes_at_low_zooms():
    """The failure verify_tiles.py reported had a shape: only rare codes, only
    low zooms, always positive. Pin the shape — it is what tells a future reader
    they are looking at a ladder-phase bug and not at tippecanoe thinning
    (thinning REMOVES features, so it can never over-count).

    The law: each state rounds its own count up by <1 dot, so the archive's excess
    is ~n_states/2 dots at every zoom — a FIXED number of dots, spread over the
    N/stride dots that zoom carries. The relative bias is therefore proportional to
    the STRIDE (128x worse at z8 than at z15) and inversely proportional to the
    code's population (worst on the rarest). It is exactly zero at full density,
    where the stride is 1 and there is no remainder to round.
    """
    rare, common = 13, 0
    prev = {}
    for z in range(TILE_MIN_ZOOM, TILE_MAX_ZOOM + 1):
        bias = {}
        for code in (rare, common):
            promised = expected_at_zoom(TOTALS[code], z)
            bias[code] = (_old_scheme_at_zoom(code, z) - promised) / promised
            assert bias[code] >= 0, f"z{z} code {code}: a ceiling cannot under-count"
            if z in (TILE_MIN_ZOOM, TILE_MAX_ZOOM):
                continue
            assert bias[code] <= prev[code] + 1e-12, (
                f"z{z} code {code}: the bias must shrink with the stride")
        assert bias[rare] >= bias[common], (
            f"z{z}: the rare code must be hit at least as hard as the common one")
        prev = bias
    assert bias[rare] == 0 and bias[common] == 0, (
        f"z{TILE_MAX_ZOOM} is full density (stride 1): every dot is in, so there "
        "is no remainder and the bias must be exactly zero")
    print("ok: the bias signature is pinned — positive, rare-codes-first, "
          "shrinking with the stride, exactly zero at full density")


def test_a_per_dot_hash_would_be_far_worse_than_the_ordinal():
    """The tempting "just make it stateless" fix: drop the running ordinal and
    take the slot from a hash of the dot's own identity. It is unbiased — and it
    is 30x less accurate, because an independent draw per dot has multinomial
    variance where a systematic every-128th sample has none.

    sd = sqrt(N x p x (1-p)) with p = 1/128. For the real rarest code
    (carless+disability, 121,221 dots) that is ±31 dots on the 947 the z8 tiles
    should carry — ±3.2%, six times verify's tolerance, and WORSE than the +2.9%
    bug it would be replacing. Measured here on the real N, with a real hash.
    """
    n = 121_221                                # real: carless+disability
    ideal = n / LADDER_PERIOD
    at_z8 = sum(
        1 for i in range(n)
        if LADDER_SLOTS[int.from_bytes(
            hashlib.blake2b(b"%d" % i, digest_size=8).digest(), "big"
        ) % LADDER_PERIOD] <= TILE_MIN_ZOOM)
    hash_err = abs(at_z8 - ideal) / ideal
    ordinal_err = abs(expected_at_zoom(n, TILE_MIN_ZOOM) - ideal) / ideal
    assert ordinal_err < 0.002, ordinal_err
    assert hash_err > ordinal_err * 5, (
        f"a per-dot hash drew {at_z8:,} z8 dots against an ideal {ideal:,.0f} "
        f"({hash_err:.2%}) and the ordinal is off by {ordinal_err:.2%} — if the "
        "hash is now competitive, re-derive the variance before trusting it")
    print(f"ok: a per-dot hash misses z8 by {hash_err:.2%} where the running "
          f"ordinal misses by {ordinal_err:.2%} — the ordinal is not optional")


if __name__ == "__main__":
    test_ladder_slots_hit_their_stride_exactly()
    test_single_state_archive_is_unchanged()
    test_multistate_archive_carries_what_the_ladder_promises()
    test_the_old_per_state_ordinal_was_biased()
    test_the_bias_signature_is_rare_codes_at_low_zooms()
    test_a_per_dot_hash_would_be_far_worse_than_the_ordinal()
    print("\nall ladder tests passed")
