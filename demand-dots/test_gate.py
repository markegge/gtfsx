"""Tests for build_dots.py's CONCATENATION GATE — the guard that stops a stale
.ldjson from being spliced into the nationwide archive.

WHAT IS BEING DEFENDED HERE
───────────────────────────
The nationwide tileset is one `cat` of ~52 per-state .ldjson files. That cat is
the exact moment a stale state stops being detectable: once the bytes are
concatenated, every downstream check sees one coherent stream and passes. The
resulting tiles are internally consistent and WRONG — the old schema in the
states that were reused, the new one in the states that were rebuilt — and
nothing raises. This has nearly shipped once already.

build_all_states.sh has a bash-level fingerprint check on the per-state skip.
That check is a FAST PATH, not the safety net: an earlier bash-only version of it
was silently dropped in a rewrite of the script. So the authority now lives in
Python, and these tests pin it there:

  1. A file whose sidecar matches the current config_hash is accepted (so that
     re-runs stay cheap — the guard must not cost us the skip).
  2. A file whose sidecar has a DIFFERENT config_hash is rejected.
  3. A file with NO sidecar is rejected (it predates the sidecar; its schema and
     density are unknowable).
  4. A PRE-ATTRIBUTE-DOTS sidecar — one with no `code_dots` key, i.e. the old
     class-string schema — is rejected. This is the shape of the ~50 real files
     that were sitting in tiles/ldjson/ when this guard was written.
  5. A MIXED set (one good file + one stale file) is rejected as a whole, and
     --cat-verified emits NOTHING. This is the case that matters: it is the one
     that produces a plausible-looking corrupt tileset.
  6. An empty input set is rejected (never build an empty tileset).
  7. The generated tippecanoe command routes through the gate rather than `cat`,
     so a runbook copy-paste cannot bypass it.

Run: ./.venv/bin/python test_gate.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import build_dots
from build_dots import (
    StaleInputError,
    config_hash,
    tippecanoe_command,
    validate_tile_inputs,
)

HERE = Path(__file__).parent
PY = str(HERE / ".venv" / "bin" / "python")


# ─── fixtures ─────────────────────────────────────────────────────────────────

def _write_state(d: Path, st: str, sidecar: dict | None) -> Path:
    """A minimal state .ldjson (+ optional sidecar) in dir `d`."""
    ld = d / f"dots_{st}.ldjson"
    ld.write_text(
        '{"type":"Feature","properties":{"d":1},'
        '"geometry":{"type":"Point","coordinates":[-112.0,47.0]}}\n')
    if sidecar is not None:
        (d / f"dots_{st}.ldjson.meta.json").write_text(json.dumps(sidecar))
    return ld


def _fresh_sidecar() -> dict:
    """What the CURRENT pipeline writes: has code_dots, current config_hash.

    code_dots must describe the ONE d=1 feature _write_state writes, or the
    concat's content-vs-sidecar cross-check warns (rightly) that this state's
    sidecar is lying about its own contents."""
    return {"config_hash": config_hash(), "code_dots": {"1": 1},
            "schema": "attribute-dots-v1"}


def _stale_sidecar() -> dict:
    """Right shape, wrong config — e.g. the density or flag bits changed."""
    return {"config_hash": "deadbeefcafe", "code_dots": {"0": 1},
            "schema": "attribute-dots-v1"}


def _pre_attribute_dots_sidecar() -> dict:
    """The real shape of the old files: a `classes` sidecar with NO code_dots.
    Note it even carries a config_hash — so a naive hash-only check that forgot
    to look for code_dots would still have to reject it on the hash. Both the
    hash and the schema key are checked; this fixture would fail either way."""
    return {"config_hash": "0aec3e55aff8", "classes": ["senior", "carless"]}


# ─── tests ────────────────────────────────────────────────────────────────────

def test_matching_fingerprint_is_accepted():
    """A re-run must still be cheap: a current file is not a false positive."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_state(d, "MT", _fresh_sidecar())
        ok = validate_tile_inputs([d / "dots_MT.ldjson"], quiet=True)
        assert len(ok) == 1, ok
    print("ok: a file built with the current config is accepted (skips stay cheap)")


def test_config_mismatch_is_rejected():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_state(d, "MT", _stale_sidecar())
        try:
            validate_tile_inputs([d / "dots_MT.ldjson"], quiet=True)
        except StaleInputError as e:
            msg = str(e)
            assert "CONFIG-MISMATCH" in msg, msg
            assert "deadbeefcafe" in msg, "must name the hash it HAS"
            assert config_hash() in msg, "must name the hash it WANTS"
            assert "dots_MT.ldjson" in msg, "must name the offending state"
        else:
            raise AssertionError("stale config_hash was NOT rejected")
    print("ok: a different config_hash is rejected, naming state + both hashes")


def test_missing_sidecar_is_rejected():
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_state(d, "MT", None)          # no sidecar at all
        try:
            validate_tile_inputs([d / "dots_MT.ldjson"], quiet=True)
        except StaleInputError as e:
            assert "NO-SIDECAR" in str(e), str(e)
        else:
            raise AssertionError("sidecar-less input was NOT rejected")
    print("ok: a file with no sidecar is rejected (never skipped, never trusted)")


def test_pre_attribute_dots_sidecar_is_rejected():
    """The ~50 real April-12 files: old class-string schema, no code_dots."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_state(d, "MT", _pre_attribute_dots_sidecar())
        try:
            validate_tile_inputs([d / "dots_MT.ldjson"], quiet=True)
        except StaleInputError as e:
            assert "PRE-ATTRIBUTE-DOTS" in str(e), str(e)
        else:
            raise AssertionError("pre-attribute-dots sidecar was NOT rejected")
    print("ok: a pre-attribute-dots (class-string) sidecar is rejected")


def test_mixed_set_is_rejected_and_emits_no_bytes():
    """THE case that matters. One fresh state + one stale state: the whole set
    must fail, and --cat-verified must not emit a single byte — a partial write
    into a tippecanoe that has already started is its own kind of corruption."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_state(d, "MT", _fresh_sidecar())    # good
        _write_state(d, "WY", _stale_sidecar())    # stale
        try:
            validate_tile_inputs(sorted(d.glob("*.ldjson")), quiet=True)
        except StaleInputError as e:
            assert "dots_WY" in str(e), str(e)
            assert "dots_MT" not in str(e), "should only indict the stale state"
        else:
            raise AssertionError("mixed-schema set was NOT rejected")

        # And the real CLI path emits nothing on stdout.
        proc = subprocess.run(
            [PY, str(HERE / "build_dots.py"), "--cat-verified",
             str(d / "*.ldjson")],
            capture_output=True)
        assert proc.returncode != 0, "gate must exit non-zero on a mixed set"
        assert proc.stdout == b"", (
            f"gate LEAKED {len(proc.stdout)} bytes of a mismatched set to stdout")
        assert b"REFUSING TO CONCATENATE" in proc.stderr, proc.stderr[:400]
    print("ok: a mixed set hard-fails and --cat-verified emits ZERO bytes")


def test_good_set_streams_through():
    """The happy path still works end to end, or the gate is useless."""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        _write_state(d, "MT", _fresh_sidecar())
        _write_state(d, "WY", _fresh_sidecar())
        proc = subprocess.run(
            [PY, str(HERE / "build_dots.py"), "--cat-verified",
             str(d / "*.ldjson")],
            capture_output=True)
        assert proc.returncode == 0, proc.stderr.decode()[:500]
        assert proc.stdout.count(b"\n") == 2, (
            f"expected 2 features, got {proc.stdout.count(chr(10).encode())}")
    print("ok: a coherent set streams through the gate to tippecanoe")


def test_empty_input_set_is_rejected():
    try:
        validate_tile_inputs([], quiet=True)
    except StaleInputError as e:
        assert "no .ldjson inputs" in str(e), str(e)
    else:
        raise AssertionError("empty input set was NOT rejected")
    print("ok: an empty input set is rejected (no silently-empty tilesets)")


def test_tile_command_routes_through_the_gate():
    """A future rewrite of build_all_states.sh copies THIS command. If it ever
    goes back to a bare `cat`, the gate is bypassed and we are back where we
    started — so pin it."""
    cmd = tippecanoe_command()
    assert "--cat-verified" in cmd, cmd
    assert not cmd.lstrip().startswith("cat "), (
        "the tile command starts with a bare `cat` — the concatenation gate is "
        "bypassed:\n" + cmd)
    assert "tippecanoe" in cmd
    print("ok: the generated tippecanoe command pipes through the gate, not `cat`")


if __name__ == "__main__":
    test_matching_fingerprint_is_accepted()
    test_config_mismatch_is_rejected()
    test_missing_sidecar_is_rejected()
    test_pre_attribute_dots_sidecar_is_rejected()
    test_mixed_set_is_rejected_and_emits_no_bytes()
    test_good_set_streams_through()
    test_empty_input_set_is_rejected()
    test_tile_command_routes_through_the_gate()
    print("\nAll concatenation-gate tests passed.")
