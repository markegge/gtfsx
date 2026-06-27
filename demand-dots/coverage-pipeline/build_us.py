"""
All-US driver for the block-level Coverage FlatGeobuf build.

Builds a per-state .fgb for every US state + DC (territories opt-in), then
MERGES them into a single nationwide `us.fgb` with a spatial (R-tree) index that
a bbox query can read back.

Design:
  * Each state is built in its OWN subprocess (build_coverage_blocks.py), so a
    state's peak RAM is released before the next one and a single state failure
    can't abort the run. Per-state stdout/stderr is captured to states/<st>.log.
  * RESUMABLE: a state whose states/<st>.fgb already exists is skipped (re-run
    after an interruption); pass --force to rebuild.
  * --jobs N builds N states concurrently (each still its own subprocess).
  * MERGE is streamed one state at a time (never all 5M points in one
    GeoDataFrame): pyogrio append by default (no system GDAL needed), or
    `ogr2ogr -append` when the GDAL CLI is present and --merge auto/ogr2ogr.
  * The merged file is verified with a pyogrio bbox read before the run reports
    success.

Usage:
    python build_us.py --out us.fgb                 # all 50 states + DC
    python build_us.py --states "RI,DE" --out x.fgb # subset (testing)
    python build_us.py --out us.fgb --jobs 4        # 4 states in parallel
    python build_us.py --out us.fgb --territories   # also build PR
    python build_us.py --out us.fgb --force         # rebuild every state
"""

import argparse
import concurrent.futures as cf
import shutil
import subprocess
import sys
import time
from pathlib import Path

import geopandas as gpd
import pyogrio

import build_coverage_blocks as bcb

HERE = Path(__file__).resolve().parent
STATE_SCRIPT = HERE / "build_coverage_blocks.py"

# 50 states + DC (FIPS). Territories (PR=72, etc.) are opt-in via --territories
# because LODES/TIGER coverage varies for them.
US_STATES_50_DC = [
    "01", "02", "04", "05", "06", "08", "09", "10", "11", "12",
    "13", "15", "16", "17", "18", "19", "20", "21", "22", "23",
    "24", "25", "26", "27", "28", "29", "30", "31", "32", "33",
    "34", "35", "36", "37", "38", "39", "40", "41", "42", "44",
    "45", "46", "47", "48", "49", "50", "51", "53", "54", "55",
    "56",
]
TERRITORIES = ["72"]  # Puerto Rico (no LODES WAC -> jobs absent, pop still builds)


def state_fips_list(states_arg: str | None, include_territories: bool) -> list[str]:
    if states_arg:
        out = []
        for tok in states_arg.split(","):
            tok = tok.strip()
            if not tok:
                continue
            fips, _ = bcb.resolve_state(tok)
            out.append(fips)
        return out
    fips = list(US_STATES_50_DC)
    if include_territories:
        fips += TERRITORIES
    return fips


def build_one(fips: str, states_dir: Path, cache_dir: Path, force: bool) -> dict:
    """Build a single state in a subprocess. Returns a result dict."""
    abbr = bcb.FIPS_TO_ABBR.get(fips, fips)
    out_fgb = states_dir / f"{abbr}.fgb"
    log_file = states_dir / f"{abbr}.log"

    if out_fgb.exists() and not force:
        size_mb = out_fgb.stat().st_size / 1024 / 1024
        print(f"  [skip] {abbr.upper()}  already built ({size_mb:.1f} MB)", flush=True)
        return {"fips": fips, "abbr": abbr.upper(), "status": "skipped", "out": str(out_fgb)}

    print(f"  [start] {abbr.upper()}  {time.strftime('%H:%M:%S')}", flush=True)
    t0 = time.time()
    cmd = [
        sys.executable, str(STATE_SCRIPT),
        "--state", fips,
        "--out", str(out_fgb),
        "--cache-dir", str(cache_dir),
    ]
    with open(log_file, "w") as lf:
        proc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT)
    dt = time.time() - t0
    if proc.returncode != 0:
        print(f"  [FAIL] {abbr.upper()}  exit={proc.returncode}  ({dt:.0f}s)  see {log_file}", flush=True)
        # Remove a partial/zero output so a re-run retries this state.
        if out_fgb.exists() and out_fgb.stat().st_size == 0:
            out_fgb.unlink()
        return {"fips": fips, "abbr": abbr.upper(), "status": "failed",
                "returncode": proc.returncode, "log": str(log_file)}
    size_mb = out_fgb.stat().st_size / 1024 / 1024
    print(f"  [done] {abbr.upper()}  {size_mb:.1f} MB  ({dt:.0f}s)", flush=True)
    return {"fips": fips, "abbr": abbr.upper(), "status": "built",
            "out": str(out_fgb), "size_mb": size_mb, "seconds": dt}


def merge_pyogrio(state_files: list[Path], out_path: Path) -> dict:
    """Stream-append each per-state .fgb into one FlatGeobuf using pyogrio.
    One state is held in memory at a time. No system GDAL required."""
    if out_path.exists():
        out_path.unlink()
    total_rows = total_pop = total_jobs = 0
    for i, sf in enumerate(state_files):
        gdf = gpd.read_file(sf)
        if len(gdf) == 0:
            continue
        total_rows += len(gdf)
        if "pop" in gdf.columns:
            total_pop += int(gdf["pop"].sum())
        if "jobs" in gdf.columns:
            total_jobs += int(gdf["jobs"].sum())
        pyogrio.write_dataframe(
            gdf, out_path, driver="FlatGeobuf", append=out_path.exists()
        )
        print(f"    merged {sf.name:>10}  +{len(gdf):,} rows  (running {total_rows:,})", flush=True)
    return {"rows": total_rows, "pop": total_pop, "jobs": total_jobs}


def merge_ogr2ogr(state_files: list[Path], out_path: Path) -> dict:
    """Merge using the GDAL `ogr2ogr` CLI (-append). Faster for large national
    builds when GDAL is installed. Falls back to pyogrio on any failure."""
    if out_path.exists():
        out_path.unlink()
    layer = "blocks"
    for i, sf in enumerate(state_files):
        if i == 0:
            cmd = ["ogr2ogr", "-f", "FlatGeobuf", "-nln", layer, str(out_path), str(sf)]
        else:
            cmd = ["ogr2ogr", "-f", "FlatGeobuf", "-append", "-update",
                   "-nln", layer, str(out_path), str(sf)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"ogr2ogr failed on {sf.name}: {proc.stderr.strip()}")
        print(f"    merged {sf.name:>10}  (ogr2ogr)", flush=True)
    info = pyogrio.read_info(out_path)
    # ogr2ogr path doesn't accumulate pop/jobs; report rows from read_info.
    return {"rows": int(info["features"]), "pop": None, "jobs": None}


def main():
    parser = argparse.ArgumentParser(description="Build the nationwide block-level coverage FlatGeobuf")
    parser.add_argument("--out", default="us.fgb", help="Merged output path (default us.fgb)")
    parser.add_argument("--states", default=None,
                        help='Subset, comma-separated FIPS/abbrev (e.g. "MT,WY"). Default: all 50 + DC.')
    parser.add_argument("--territories", action="store_true",
                        help="Also build territories (PR). Off by default (LODES/TIGER coverage varies).")
    parser.add_argument("--jobs", type=int, default=1, help="Parallel state builds (default 1)")
    parser.add_argument("--cache-dir", default="cache", help="Shared cache dir (default ./cache)")
    parser.add_argument("--states-dir", default="states", help="Per-state .fgb output dir (default ./states)")
    parser.add_argument("--force", action="store_true", help="Rebuild every state even if its .fgb exists")
    parser.add_argument("--merge", choices=["auto", "pyogrio", "ogr2ogr"], default="auto",
                        help="Merge backend. auto = ogr2ogr if GDAL CLI present, else pyogrio.")
    parser.add_argument("--no-merge", action="store_true", help="Build per-state files only, skip the merge.")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    states_dir = Path(args.states_dir)
    states_dir.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out)

    fips_list = state_fips_list(args.states, args.territories)
    print(f"Nationwide block-level coverage build")
    print(f"  States: {len(fips_list)}  ({', '.join(bcb.FIPS_TO_ABBR.get(f, f).upper() for f in fips_list)})")
    print(f"  Cache:  {cache_dir}   Per-state dir: {states_dir}   Jobs: {args.jobs}")
    print(f"  Output: {out_path}\n")

    run_t0 = time.time()
    results: list[dict] = []
    if args.jobs > 1:
        with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futs = {ex.submit(build_one, f, states_dir, cache_dir, args.force): f for f in fips_list}
            for fut in cf.as_completed(futs):
                results.append(fut.result())
    else:
        for f in fips_list:
            results.append(build_one(f, states_dir, cache_dir, args.force))

    built = [r for r in results if r["status"] in ("built", "skipped")]
    failed = [r for r in results if r["status"] == "failed"]
    if failed:
        print("\n  ⚠️  Failed states (re-run to retry, logs in states/):")
        for r in failed:
            print(f"     {r['abbr']}  exit={r.get('returncode')}  {r.get('log')}")

    # Collect the per-state files that exist, ordered by FIPS for determinism.
    state_files = []
    for f in fips_list:
        abbr = bcb.FIPS_TO_ABBR.get(f, f)
        p = states_dir / f"{abbr}.fgb"
        if p.exists() and p.stat().st_size > 0:
            state_files.append(p)

    if args.no_merge:
        print(f"\n--no-merge set: {len(state_files)} per-state files in {states_dir}, skipping merge.")
        return

    if not state_files:
        print("\nNo per-state files to merge — aborting.")
        sys.exit(1)

    # ── Merge ────────────────────────────────────────────────────────────────
    have_ogr = shutil.which("ogr2ogr") is not None
    method = args.merge
    if method == "auto":
        method = "ogr2ogr" if have_ogr else "pyogrio"
    if method == "ogr2ogr" and not have_ogr:
        print("  ogr2ogr requested but GDAL CLI not found — falling back to pyogrio.")
        method = "pyogrio"

    print(f"\nMerging {len(state_files)} per-state files → {out_path}  (method: {method})")
    mt0 = time.time()
    try:
        merged = merge_ogr2ogr(state_files, out_path) if method == "ogr2ogr" \
            else merge_pyogrio(state_files, out_path)
    except Exception as e:
        print(f"  {method} merge failed ({e}); retrying with pyogrio…")
        merged = merge_pyogrio(state_files, out_path)
    print(f"  Merge done in {time.time()-mt0:.0f}s")

    # ── Verify with a bbox read ──────────────────────────────────────────────
    # Probe over the FIRST state's own bounds (guaranteed to contain points;
    # the center of the national/disjoint total bounds can land in empty ocean).
    info = pyogrio.read_info(out_path)
    total_feats = int(info["features"])
    probe = pyogrio.read_info(state_files[0])["total_bounds"]
    bbox_read = gpd.read_file(out_path, bbox=tuple(probe))
    if total_feats <= 0 or len(bbox_read) == 0:
        print("  ⚠️  Merged file failed bbox-read verification — merge FAILED.")
        sys.exit(1)
    size_mb = out_path.stat().st_size / 1024 / 1024

    print("\n══ Nationwide summary ═══════════════════════════════════")
    print(f"  States built/used:  {len(state_files)} / {len(fips_list)} requested")
    if failed:
        print(f"  States failed:      {len(failed)}  ({', '.join(r['abbr'] for r in failed)})")
    print(f"  Total block points: {total_feats:,}")
    if merged.get("pop") is not None:
        print(f"  Total population:   {merged['pop']:,}")
        print(f"  Total jobs:         {merged['jobs']:,}")
    print(f"  Output:             {out_path}  ({size_mb:.1f} MB)")
    print(f"  Bbox readback:      {len(bbox_read):,} blocks over {state_files[0].stem.upper()} extent (verify OK)")
    print(f"  Wall time:          {time.time()-run_t0:.0f}s")
    print("═════════════════════════════════════════════════════════")


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
