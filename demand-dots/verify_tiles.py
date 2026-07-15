#!/usr/bin/env python3
"""Prove that the built tileset actually honors the legend.

The legend tells a planner "1 dot ≈ N people" at the zoom they are looking at.
That claim rests on ONE assumption: that the only thing thinning the tiles is our
own zoom-density ladder (build_dots.ZOOM_DENSITY_LADDER). It is an assumption
that silently stopped being true, and the map spent that whole time drawing 2% of
the people it claimed at z8, because tippecanoe was quietly dropping features on
top of the ladder — its default --drop-rate below --base-zoom, plus
--drop-densest-as-needed in any tile over the size limit.

Nothing caught it, because nothing ever compared what went IN to what came OUT.
This does:

  emitted   the dots build_dots.py wrote, per CODE, out of the .ldjson sidecars
  retained  the dots actually present in the archive, per zoom, per CODE
  expected  emitted x the ladder's share for that zoom — what the legend PROMISES

and it fails (exit 1) if retained != expected anywhere. A pass means the legend's
number is true by measurement, not by hope.

A "code" is the integer `d` attribute every dot carries: 0-15 for a person (the
bitmask of their membership flags) and 16 for a job. Verifying per CODE, not just
in aggregate, is what proves the FLAG MIX survives the ladder — if the stride
thinned, say, the carless-and-poor cell harder than the no-flags cell, the total
would still balance while every segment on screen quietly under-drew.

Buffer duplicates are not double-counted: tippecanoe writes features near a tile
edge into the neighbouring tiles too (that is what --buffer is for), so a raw
count of the decoded output overstates by ~7%. Every feature is attributed to the
ONE tile its coordinates actually fall in.

Usage:
    ./.venv/bin/python verify_tiles.py ../tiles/us-2026d.pmtiles \\
        --meta '../tiles/ldjson/*.ldjson.meta.json'

    # a single state
    ./.venv/bin/python verify_tiles.py ../tiles/mt-2026d.pmtiles \\
        --meta ../tiles/ldjson/dots_MT.ldjson.meta.json
"""

import argparse
import glob
import json
import math
import struct
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import build_dots
from build_dots import (
    JOBS_CODE,
    LADDER_PERIOD,
    LADDER_SLOTS,
    TILE_ATTR,
    TILE_CODES,
    TILE_MAX_ZOOM,
    TILE_MIN_ZOOM,
    ZOOM_DENSITY_LADDER,
)
from joint_flags import cell_label


def tile_of(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 1 << z
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def archive_zooms(path: Path) -> tuple[int, int]:
    """(minzoom, maxzoom) out of the archive's own header — the number the
    frontend hands Mapbox as the source maxzoom has to equal this one, or Mapbox
    requests tiles that were never built and draws nothing."""
    if path.suffix == ".pmtiles":
        head = path.open("rb").read(127)
        if head[:7] != b"PMTiles":
            sys.exit(f"{path} is not a PMTiles archive")
        return head[100], head[101]
    if path.suffix == ".mbtiles":
        import sqlite3
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        rows = dict(con.execute(
            "SELECT name, value FROM metadata WHERE name IN ('minzoom','maxzoom')"))
        con.close()
        return int(rows["minzoom"]), int(rows["maxzoom"])
    sys.exit(f"unsupported archive type: {path.suffix}")


def expected_at_zoom(emitted: int, zoom: int) -> int:
    """How many of a code's `emitted` dots the ladder puts in the z tiles.

    Dot k of a code goes in at LADDER_SLOTS[k % period], so this counts the
    ordinals 0..emitted-1 whose slot is at or below `zoom` — the exact number,
    not emitted/stride, which would be off by the remainder.

    There is no per-class minzoom gate any more: a flag rides on a person, and
    that person is in the z8 tile or not on their own merits. (The old schema
    held the segment classes back to z9, so selecting Carless at z8 drew nothing.)
    """
    total = 0
    for r in range(LADDER_PERIOD):
        if LADDER_SLOTS[r] <= zoom and r < emitted:
            # ordinals r, r+period, r+2*period, … below `emitted`
            total += (emitted - 1 - r) // LADDER_PERIOD + 1
    return total


def retained_at_zoom(archive: Path, zoom: int) -> dict[int, int]:
    """Decode every tile at `zoom` and count features per CODE, attributing each
    feature to the single tile it geographically belongs to (so the tile buffer's
    duplicates are not counted twice)."""
    proc = subprocess.Popen(
        ["tippecanoe-decode", "-Z", str(zoom), "-z", str(zoom), str(archive)],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1 << 20,
    )
    counts: dict[int, int] = defaultdict(int)
    tile = None
    needle = f'"{TILE_ATTR}": '
    assert proc.stdout is not None
    for line in proc.stdout:
        i = line.find('"zoom":')
        if i >= 0:
            # { "type": "FeatureCollection", "properties": { "zoom": 12, "x": 795, "y": 1447 }, …
            z = int(line[i + 7:line.find(',', i)])
            j = line.find('"x":')
            k = line.find('"y":')
            tile = (z, int(line[j + 4:line.find(',', j)]),
                    int(line[k + 4:line.find('}', k)]))
            continue
        c = line.find(needle)
        if c < 0 or tile is None:
            continue
        # `d` is an integer, so the value runs to the next , or } — no quotes.
        rest = line[c + len(needle):]
        end = min((x for x in (rest.find(','), rest.find('}')) if x >= 0), default=-1)
        if end < 0:
            continue
        try:
            code = int(rest[:end].strip())
        except ValueError:
            continue
        p = line.find('"coordinates": [', c)
        if p < 0:
            continue
        lon_s, lat_s = line[p + 16:line.find(']', p)].split(',')
        if tile_of(float(lon_s), float(lat_s), tile[0]) == (tile[1], tile[2]):
            counts[code] += 1
    proc.wait()
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("archive", type=Path, help=".pmtiles or .mbtiles to verify")
    ap.add_argument("--meta", required=True,
                    help="glob of the .ldjson.meta.json sidecars the archive was built from")
    ap.add_argument("--legend", type=Path, default=Path(__file__).parent / "demand-legend.json")
    ap.add_argument("--tolerance", type=float, default=0.005,
                    help="allowed |retained-expected|/expected (default 0.5%%; the "
                         "slack absorbs the handful of dots that quantise onto a "
                         "tile boundary, nothing more)")
    args = ap.parse_args()

    metas = [Path(p) for p in glob.glob(args.meta)]
    if not metas:
        sys.exit(f"no meta sidecars matched {args.meta!r}")
    emitted: dict[int, int] = defaultdict(int)
    for m in metas:
        raw = json.loads(m.read_text())
        if "code_dots" not in raw:
            sys.exit(
                f"{m} has no `code_dots` — it is a PRE-ATTRIBUTE-DOTS sidecar (the "
                "schema where a dot was a class, not a person). Rebuild the state.")
        for code, n in raw["code_dots"].items():
            emitted[int(code)] += n

    print(f"archive : {args.archive}")
    print(f"emitted : {sum(emitted.values()):,} dots from {len(metas)} state(s)")

    failures: list[str] = []

    # ── 1. the zoom envelope the frontend will hand Mapbox ────────────────────
    amin, amax = archive_zooms(args.archive)
    legend = json.loads(args.legend.read_text())
    print(f"\nzoom envelope: archive z{amin}-{amax} | legend z{legend['min_zoom']}-"
          f"{legend['max_zoom']} | build_dots z{TILE_MIN_ZOOM}-{TILE_MAX_ZOOM}")
    if (amin, amax) != (TILE_MIN_ZOOM, TILE_MAX_ZOOM):
        failures.append(
            f"archive is z{amin}-{amax} but build_dots says z{TILE_MIN_ZOOM}-{TILE_MAX_ZOOM}")
    if (legend["min_zoom"], legend["max_zoom"]) != (amin, amax):
        failures.append(
            f"demand-legend.json declares z{legend['min_zoom']}-{legend['max_zoom']} but the "
            f"archive has z{amin}-{amax}. The frontend passes max_zoom to Mapbox as the source "
            "maxzoom: declare one deeper than exists and the layer goes BLANK from that zoom in.")

    # ── 1b. the tile schema itself ────────────────────────────────────────────
    # The frontend cannot bitwise-AND in a Mapbox expression, so it enumerates the
    # codes matching each flag from the legend's `flags` block. If those bit values
    # ever disagreed with the tiles, every filter would silently select the WRONG
    # PEOPLE — a map that looks perfectly plausible and is wrong. Check them.
    if legend.get("attribute") != TILE_ATTR:
        failures.append(
            f"demand-legend.json says the dots carry `{legend.get('attribute')}` but the "
            f"pipeline writes `{TILE_ATTR}`")
    if legend.get("jobs_code") != JOBS_CODE:
        failures.append(
            f"demand-legend.json says jobs_code={legend.get('jobs_code')}, pipeline says {JOBS_CODE}")
    for flag, bit in build_dots.FLAG_BITS.items():
        if legend.get("flags", {}).get(flag) != bit:
            failures.append(
                f"demand-legend.json gives flag `{flag}` bit "
                f"{legend.get('flags', {}).get(flag)}, pipeline uses {bit}. Every "
                "client-side filter is enumerated from these bits — a mismatch selects "
                "the wrong people with no error anywhere.")

    # ── 2. retained == expected, per zoom, per CODE ───────────────────────────
    print(f"\n{'zoom':<6}{'stride':>7}{'1 dot =':>10}{'expected':>12}{'retained':>12}{'diff':>9}")
    for z in range(amin, amax + 1):
        got = retained_at_zoom(args.archive, z)
        stride = ZOOM_DENSITY_LADDER.get(z, 1)
        z_exp = z_got = 0
        for code in TILE_CODES:
            exp = expected_at_zoom(emitted.get(code, 0), z)
            act = got.get(code, 0)
            z_exp += exp
            z_got += act
            if exp == 0 and act == 0:
                continue
            drift = abs(act - exp) / max(exp, 1)
            if drift > args.tolerance:
                name = "jobs" if code == JOBS_CODE else cell_label(code)
                failures.append(
                    f"z{z} code {code} ({name}): expected {exp:,}, tiles carry {act:,} "
                    f"({(act - exp) / max(exp, 1) * 100:+.1f}%) — the legend's "
                    f"'1 dot = {build_dots.PEOPLE_PER_DOT * stride}' is not what the map draws")
        # An unknown code in the archive means the tiles were built by a different
        # schema than this checkout — the frontend would draw them as nothing.
        for code in got:
            if code not in TILE_CODES:
                failures.append(
                    f"z{z}: the archive carries code {code}, which is not in the "
                    f"pipeline's vocabulary {TILE_CODES}")
        diff = (z_got - z_exp) / max(z_exp, 1) * 100
        flag = "  ok" if abs(diff) <= args.tolerance * 100 else "  ✗ THINNED"
        print(f"z{z:<5}{stride:>7}{build_dots.PEOPLE_PER_DOT * stride:>10,}"
              f"{z_exp:>12,}{z_got:>12,}{diff:>8.2f}%{flag}")

    if failures:
        print("\nFAILED — the tiles do not honor the legend:\n")
        for f in failures:
            print(f"  • {f}")
        print("\nSomething is thinning the dots besides the ladder. Check that tippecanoe ran "
              "with --drop-rate=1 (its default of 2.5 silently decimates the low zooms) and "
              "that no tile blew --maximum-tile-bytes / --maximum-tile-features, which makes "
              "--drop-densest-as-needed thin that tile on top of the ladder.")
        return 1

    print("\nPASS — every zoom carries exactly the dots the ladder promises, so the "
          "legend's '1 dot ≈ N' is true at every zoom, in every tile.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
