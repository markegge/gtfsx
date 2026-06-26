#!/usr/bin/env python3
"""
Feed Health — snapshot augmentation for the three new agency-table columns.

WHY THIS SCRIPT EXISTS
----------------------
The dashboard's per-state agency JSONs are the published June-7 snapshot, produced
by pipeline.py (Phases A-C) + phase_d_mdb.py (Phase D) + feed-health-publish.py.
Those scripts now ALSO emit three new per-agency fields:
    fixedRoute      — NTD Service-by-Mode classification (wwdp-t4re)
    demandResponse  — NTD Service-by-Mode classification (wwdp-t4re)
    lastFeedUpdate  — MDB latest_dataset.downloaded_at (proxy for last publish date)

A full pipeline re-run would refresh the ENTIRE dataset from June-7 to today,
changing every coverage/expiry/validation number on the dashboard and risking the
publish drift guard. That is out of scope: the task is to ADD three columns, not to
re-date the snapshot. So instead of re-running A-D, this script AUGMENTS the frozen
June-7 inputs in place with ONLY the data the three new columns need, leaving all
existing aggregates untouched, then leaves feed-health-publish.py to regenerate the
JSONs from the augmented inputs.

What it changes (all additive — no existing value is modified):
  1. ntd_feed_health.csv  → appends columns ntd_mode_codes / fixed_route /
     demand_response, joined by NTD id from the NTD Service-by-Mode table
     (wwdp-t4re, FY2024 — stable annual data, does not drift).
  2. mdb_us_feeds.json     → adds a `last_updated` field to each cached feed entry,
     sourced from a fresh MDB pull of latest_dataset.downloaded_at (authoritative;
     covers feeds whose hosted_url does not embed the timestamp). service_end,
     validation counts, and every other cached value are preserved as-is.

Inputs are READ from --src (default: the committed handoffs snapshot in the main
checkout) and WRITTEN to --workdir, so the source snapshot is never mutated.

Usage:
  # loads MOBILITY_DATABASE_REFRESH_TOKEN from the monorepo .env automatically
  python3 scripts/feed-health/augment_snapshot.py \
      --src "/Users/clippy2/proj/gtfsx/handoffs/Feed Health Data" \
      --workdir /tmp/fh-aug-work
  # then:
  python3 scripts/feed-health-publish.py /tmp/fh-aug-work/ntd_feed_health.csv
"""

import argparse, csv, json, os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pipeline          # fetch_service_modes / classify_modes / norm_ntd
import phase_d_mdb       # access_token / pull_mdb (captures last_updated)

DEFAULT_SRC = "/Users/clippy2/proj/gtfsx/handoffs/Feed Health Data"
COPY_FILES  = ["ntd_feed_health.csv", "mdb_us_feeds.json", "flex_coverage.csv",
               "stats_phaseD.json", "reachability_cache.json"]


def load_env_token():
    """Populate MOBILITY_DATABASE_REFRESH_TOKEN from the monorepo .env if unset."""
    if os.environ.get("MOBILITY_DATABASE_REFRESH_TOKEN"):
        return
    for env_path in ("/Users/clippy2/proj/.env",
                     os.path.join(HERE, "..", "..", "..", ".env")):
        if os.path.exists(env_path):
            for line in open(env_path):
                line = line.strip()
                if line.startswith("MOBILITY_DATABASE_REFRESH_TOKEN="):
                    os.environ["MOBILITY_DATABASE_REFRESH_TOKEN"] = line.split("=", 1)[1].strip()
                    return


def augment_csv_modes(csv_path):
    """Append ntd_mode_codes / fixed_route / demand_response to the existing CSV."""
    rows = list(csv.DictReader(open(csv_path)))
    fieldnames = list(rows[0].keys()) if rows else []
    print(f"  NTD Service-by-Mode (wwdp-t4re, FY{pipeline.ROSTER_YEAR})...", file=sys.stderr)
    modes_by_ntd = pipeline.fetch_service_modes()
    print(f"    mode data for {len(modes_by_ntd)} agencies", file=sys.stderr)

    new_cols = ["ntd_mode_codes", "fixed_route", "demand_response"]
    # Insert the new columns (in order) right after report_year to mirror pipeline.COLS.
    missing = [c for c in new_cols if c not in fieldnames]
    anchor = fieldnames.index("report_year") + 1 if "report_year" in fieldnames else len(fieldnames)
    fieldnames[anchor:anchor] = missing

    n_fr = n_dr = n_unmatched = 0
    for r in rows:
        codes = modes_by_ntd.get(pipeline.norm_ntd(r["ntd_id"]))
        if codes is None:
            n_unmatched += 1
            codes = []
        fr, dr = pipeline.classify_modes(codes)
        r["ntd_mode_codes"]  = ",".join(codes)
        r["fixed_route"]     = "True" if fr else "False"
        r["demand_response"] = "True" if dr else "False"
        n_fr += fr; n_dr += dr

    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"    fixed_route={n_fr}  demand_response={n_dr}  "
          f"(no NTD mode row: {n_unmatched})", file=sys.stderr)


def augment_cache_last_updated(cache_path):
    """Merge `last_updated` (MDB downloaded_at) into the existing cache entries.

    A fresh MDB pull is used purely to source downloaded_at; ONLY the last_updated
    field is merged into the existing cache — service_end, error counts, features,
    etc. are left exactly as the frozen snapshot recorded them."""
    existing = json.load(open(cache_path))
    print(f"  Fresh MDB pull for downloaded_at (existing cache: {len(existing)} feeds)...",
          file=sys.stderr)
    tok = phase_d_mdb.access_token()
    tmp_cache = cache_path + ".fresh.tmp"
    if os.path.exists(tmp_cache):
        os.remove(tmp_cache)
    fresh = phase_d_mdb.pull_mdb(tok, tmp_cache)         # captures last_updated
    fresh_lu = {f["mdb_id"]: (f.get("last_updated") or "") for f in fresh}
    os.remove(tmp_cache)

    n_set = 0
    for f in existing:
        lu = fresh_lu.get(f["mdb_id"], "")
        if not lu:
            # Fallback: parse the timestamp embedded in this feed's own hosted_url.
            import re
            m = re.search(r"/(?:mdb|tld|ntd)-[^/]*-(\d{12})/", f.get("hosted_url") or "")
            if m:
                t = m.group(1)
                lu = f"{t[0:4]}-{t[4:6]}-{t[6:8]}"
        f["last_updated"] = lu
        if lu:
            n_set += 1
    json.dump(existing, open(cache_path, "w"))
    print(f"    last_updated set for {n_set}/{len(existing)} cached feeds", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=DEFAULT_SRC,
                    help="Directory holding the frozen snapshot inputs (read-only)")
    ap.add_argument("--workdir", default="/tmp/fh-aug-work",
                    help="Output workdir (augmented copies written here)")
    args = ap.parse_args()

    optional = {"stats_phaseD.json", "reachability_cache.json"}
    os.makedirs(args.workdir, exist_ok=True)
    for name in COPY_FILES:
        src = os.path.join(args.src, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(args.workdir, name))
        elif name not in optional:
            sys.exit(f"required input missing: {src}")

    load_env_token()
    csv_path   = os.path.join(args.workdir, "ntd_feed_health.csv")
    cache_path = os.path.join(args.workdir, "mdb_us_feeds.json")

    print("Augmenting CSV with NTD service-mode classification...", file=sys.stderr)
    augment_csv_modes(csv_path)
    print("Augmenting MDB cache with last_updated (downloaded_at)...", file=sys.stderr)
    augment_cache_last_updated(cache_path)

    print(f"\nDone. Augmented inputs in {args.workdir}", file=sys.stderr)
    print(f"Next: python3 scripts/feed-health-publish.py {csv_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
