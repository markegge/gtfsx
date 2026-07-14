"""Resolve the newest published ACS 5-year vintage, and emit it for the frontend.

This is the ONE authoritative place that decides which ACS 5-year release the
project uses. Nothing hardcodes a year any more:

  * The Python builds (build_dots.py, coverage-pipeline/build_coverage_blocks.py)
    call resolve_latest_acs_year() at build time.
  * The React app does NOT probe at runtime — that would cost every user an extra
    request and could drift from the vintage the prebuilt tiles were made with.
    Instead this module writes the resolved year into a generated TypeScript
    constant, src/generated/acsVintage.ts, which the app imports. The generated
    file is committed, so the Vite build never needs network access.

Regenerate the constant after a new ACS release (Census publishes the 5-year
estimates each December):

    cd demand-dots && ./.venv/bin/python acs_vintage.py --emit

Census requires an API key. Set CENSUS_API_KEY, or leave the repo's .env in
place (VITE_CENSUS_API_KEY is read from it as a fallback).
"""

from __future__ import annotations

import argparse
import os
import sys
from functools import lru_cache
from pathlib import Path

import requests

CENSUS_API_BASE = "https://api.census.gov/data"

# Probe downward from a year that cannot exist yet until the API answers. Same
# idiom as the LODES probe in build_dots.py. The floor is a guard against a
# transient outage silently walking us back to a decade-old vintage: if nothing
# in [floor, probe_start] responds, we raise instead of returning a bad year.
DEFAULT_PROBE_START = 2026
DEFAULT_FLOOR = 2019

# Path to the generated TS constant, relative to the repo root.
TS_CONSTANT_PATH = "src/generated/acsVintage.ts"

REPO_ROOT = Path(__file__).resolve().parent.parent


def census_key() -> str:
    """Census rejects keyless requests. Prefer CENSUS_API_KEY; otherwise walk up
    from this file looking for a .env that defines CENSUS_API_KEY or
    VITE_CENSUS_API_KEY. Returns '' if none found (requests will likely 403)."""
    key = os.environ.get("CENSUS_API_KEY")
    if key:
        return key
    here = Path(__file__).resolve().parent
    for d in [here, *here.parents][:5]:
        env_path = d / ".env"
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            line = line.strip()
            for prefix in ("CENSUS_API_KEY=", "VITE_CENSUS_API_KEY="):
                if line.startswith(prefix):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


@lru_cache(maxsize=None)
def resolve_latest_acs_year(
    probe_start: int = DEFAULT_PROBE_START,
    floor: int = DEFAULT_FLOOR,
) -> int:
    """Return the newest ACS 5-year vintage the Census API actually serves.

    Probes https://api.census.gov/data/<year>/acs/acs5 downward from probe_start.
    An unpublished year 404s; the first year that answers wins. Memoized, so a
    build that asks repeatedly only pays for one round trip.
    """
    key = census_key()
    params = {"get": "NAME", "for": "state:30"}  # cheapest possible query
    if key:
        params["key"] = key

    for year in range(probe_start, floor - 1, -1):
        try:
            resp = requests.get(f"{CENSUS_API_BASE}/{year}/acs/acs5", params=params, timeout=30)
        except requests.RequestException:
            continue
        if resp.status_code == 200:
            return year

    raise RuntimeError(
        f"No ACS 5-year vintage responded between {floor} and {probe_start}. "
        "The Census API may be down, or CENSUS_API_KEY may be missing/invalid."
    )


def acs_dataset(year: int) -> str:
    """Full dataset URL for an ACS 5-year vintage."""
    return f"{CENSUS_API_BASE}/{year}/acs/acs5"


def emit_ts_constant(year: int, path: str | os.PathLike[str] = None) -> Path:
    """Write the generated TypeScript constant the frontend imports."""
    out = Path(path) if path is not None else REPO_ROOT / TS_CONSTANT_PATH
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        "// GENERATED FILE — DO NOT EDIT BY HAND.\n"
        "//\n"
        "// Written by demand-dots/acs_vintage.py, which probes the Census API for the\n"
        "// newest published ACS 5-year vintage. Regenerate after each December ACS\n"
        "// release with:\n"
        "//\n"
        "//     cd demand-dots && ./.venv/bin/python acs_vintage.py --emit\n"
        "//\n"
        "// This is committed on purpose: the Vite build imports it, and it keeps the app\n"
        "// pinned to the same vintage as the prebuilt demand-dot and coverage layers.\n"
        "\n"
        f"export const ACS_YEAR = {year};\n"
    )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve + emit the latest ACS 5-year vintage")
    parser.add_argument("--emit", action="store_true",
                        help=f"Write the resolved year to {TS_CONSTANT_PATH}")
    parser.add_argument("--out", default=None,
                        help="Override the output path for --emit")
    parser.add_argument("--probe-start", type=int, default=DEFAULT_PROBE_START)
    parser.add_argument("--floor", type=int, default=DEFAULT_FLOOR)
    args = parser.parse_args()

    year = resolve_latest_acs_year(args.probe_start, args.floor)
    print(f"Latest ACS 5-year vintage: {year}  ({acs_dataset(year)})")

    if args.emit:
        out = emit_ts_constant(year, args.out)
        print(f"Wrote {out}")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
