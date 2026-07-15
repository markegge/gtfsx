#!/usr/bin/env python3
"""
Feed Health — add the three new columns directly to the published agency JSONs.

WHY DIRECT-JSON AND NOT A PIPELINE RE-RUN
-----------------------------------------
The committed per-state JSONs are the published snapshot dated 2026-06-07. They were
produced by feed-health-publish.py from a POST-audit Phase-D CSV that was NOT saved to
handoffs/ (the saved handoffs CSV is the older PRE-audit June-7 Phase-D output: it marks
the 11 "2026-06-17 no-findable-feed audit" agencies as in_mdb=False, whereas the
published JSONs correctly show them findable). Re-running Phase-D today also can't
reproduce the snapshot exactly because `mdb_expired` is recomputed against *today's*
date, so feeds that lapsed since June-7 flip to expired (expired_pct 21.9% -> 23.7%),
tripping the publish drift guard.

Because the task is purely ADDITIVE (three per-agency columns, no aggregate changes),
the safe, zero-regression approach is to take the committed JSONs as ground truth and
add ONLY the three new fields, leaving status / serviceEnd / expired / isFlex / feedUrl
exactly as published. The pipeline scripts (pipeline.py / phase_d_mdb.py /
feed-health-publish.py) have ALSO been updated to emit these fields, so the next full
monthly run produces them natively; this script back-fills the current snapshot.

Three fields added per agency (output field order matches feed-health-publish.py):
    fixedRoute      bool  — NTD Service-by-Mode (wwdp-t4re) classification, full roster.
    demandResponse  bool  — NTD Service-by-Mode (wwdp-t4re) classification, full roster.
    lastFeedUpdate  str?  — date (YYYY-MM-DD) MDB last captured the matched feed's latest
                            dataset (latest_dataset.downloaded_at) — proxy for last
                            publish; null when no MDB-matched feed. Set only for findable
                            agencies (status != "none").

Data sources (date-independent; nothing here depends on "today"):
  - fixedRoute/demandResponse: NTD wwdp-t4re (open Socrata, no auth).
  - ntd_id -> mdb_id match: the handoffs Phase-D CSV (in_mdb rows) UNION the audited
    CONFIRMED_GOOD_MATCHES allowlist in phase_d_mdb.py (covers the post-audit additions).
  - mdb_id -> last_updated: the augmented MDB cache produced by augment_snapshot.py
    (mdb_us_feeds.json with last_updated merged from MDB downloaded_at).

Usage:
  python3 scripts/feed-health/augment_snapshot.py --workdir /tmp/fh-aug-work   # build cache
  python3 scripts/feed-health/augment_agency_json.py \
      --csv  "/Users/clippy2/proj/gtfsx/handoffs/Feed Health Data/ntd_feed_health.csv" \
      --cache /tmp/fh-aug-work/mdb_us_feeds.json
"""

import argparse, csv, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pipeline                                  # fetch_service_modes / classify_modes / norm_ntd
from phase_d_mdb import CONFIRMED_GOOD_MATCHES   # audited ntd_norm -> mdb_id pairs

REPO_ROOT    = os.path.dirname(os.path.dirname(HERE))
OUT_AGENCIES = os.path.join(REPO_ROOT, "public", "feed-health", "data", "agencies")
DEFAULT_CSV  = "/Users/clippy2/proj/gtfsx/handoffs/Feed Health Data/ntd_feed_health.csv"
DEFAULT_CACHE = "/tmp/fh-aug-work/mdb_us_feeds.json"

# Canonical agency field order (mirrors feed-health-publish.write_agency_jsons).
# NB: records are re-emitted as {k: ag.get(k) for k in FIELD_ORDER}, so a field
# missing from this list is silently DROPPED from the published JSON. Any field
# added to write_agency_jsons() must be added here too.
FIELD_ORDER = ["name", "ntdId", "mdbId", "city", "reporterType", "status", "feedUrl",
               "lastValidated", "orgType", "modes", "fixedRoute", "demandResponse",
               "isFlex", "serviceEnd", "lastFeedUpdate", "expired"]

import re
_MDB_DATE_TOKEN = re.compile(r"/(?:mdb|tld|ntd)-[^/]*-(\d{12})/")


def feed_last_updated(feed):
    """YYYY-MM-DD the matched feed's latest dataset was captured (downloaded_at),
    falling back to the timestamp embedded in hosted_url. None if neither."""
    if not feed:
        return None
    lu = (feed.get("last_updated") or "").strip()
    if lu:
        return lu[:10]
    m = _MDB_DATE_TOKEN.search(feed.get("hosted_url") or "")
    if m:
        t = m.group(1)
        return f"{t[0:4]}-{t[4:6]}-{t[6:8]}"
    return None


def build_mode_map():
    """norm_ntd -> (fixedRoute, demandResponse)."""
    modes_by_ntd = pipeline.fetch_service_modes()
    return {nid: pipeline.classify_modes(codes) for nid, codes in modes_by_ntd.items()}


def build_ntd_to_mdb(csv_path):
    """norm_ntd -> mdb_id. The NTD↔MDB crosswalk: the handoffs Phase-D CSV
    matches UNION the audited allowlist. Ids stay strings throughout."""
    ntd_to_mdb = {}
    # 1) handoffs Phase-D CSV matches.
    for r in csv.DictReader(open(csv_path)):
        if r.get("in_mdb") == "True" and r.get("mdb_id", "").strip():
            ntd_to_mdb[pipeline.norm_ntd(r["ntd_id"])] = r["mdb_id"].strip()
    # 2) audited allowlist additions (post-June-7; e.g. the 2026-06-17 11).
    for ntd_norm, mdb_id in CONFIRMED_GOOD_MATCHES:
        ntd_to_mdb.setdefault(pipeline.norm_ntd(ntd_norm), mdb_id)
    return ntd_to_mdb


def build_lastupdate_map(ntd_to_mdb, cache_path):
    """norm_ntd -> lastFeedUpdate date string (only for ntd ids with an MDB match)."""
    cache = {f["mdb_id"]: f for f in json.load(open(cache_path))}
    out = {}
    for nid, mdb_id in ntd_to_mdb.items():
        d = feed_last_updated(cache.get(mdb_id))
        if d:
            out[nid] = d
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--cache", default=DEFAULT_CACHE)
    ap.add_argument("--agencies-dir", default=OUT_AGENCIES)
    args = ap.parse_args()

    if not os.path.exists(args.cache):
        sys.exit(f"cache not found: {args.cache} — run augment_snapshot.py first")

    print("Fetching NTD service-mode classification (wwdp-t4re)...", file=sys.stderr)
    mode_map = build_mode_map()
    print(f"  {len(mode_map)} agencies classified", file=sys.stderr)
    print("Building ntd_id -> mdb_id crosswalk...", file=sys.stderr)
    mdb_map = build_ntd_to_mdb(args.csv)
    print(f"  {len(mdb_map)} agencies have an MDB match", file=sys.stderr)
    print("Building ntd_id -> lastFeedUpdate map...", file=sys.stderr)
    lu_map = build_lastupdate_map(mdb_map, args.cache)
    print(f"  {len(lu_map)} agencies have an MDB last-updated date", file=sys.stderr)

    tot = n_fr = n_dr = n_lu = n_lu_skipped_none = n_mdb = 0
    files = sorted(glob.glob(os.path.join(args.agencies_dir, "*.json")))
    for path in files:
        if os.path.basename(path) == "_SAMPLE.json":
            continue
        doc = json.load(open(path))
        new_agencies = []
        for ag in doc["agencies"]:
            nid = pipeline.norm_ntd(ag["ntdId"])
            fr, dr = mode_map.get(nid, (False, False))
            ag["fixedRoute"] = fr
            ag["demandResponse"] = dr
            # NTD↔MDB crosswalk id; None when the agency has no MDB match.
            # Unlike lastFeedUpdate this is NOT gated on status — it is an
            # identity fact, not a health signal.
            ag["mdbId"] = mdb_map.get(nid)
            # lastFeedUpdate only for findable agencies (a "none" status has no feed).
            if ag.get("status") != "none":
                lfu = lu_map.get(nid)
            else:
                if lu_map.get(nid):
                    n_lu_skipped_none += 1
                lfu = None
            ag["lastFeedUpdate"] = lfu
            # Re-emit each record in the canonical field order.
            new_agencies.append({k: ag.get(k) for k in FIELD_ORDER})
            tot += 1; n_fr += bool(fr); n_dr += bool(dr); n_lu += bool(lfu)
            n_mdb += bool(ag["mdbId"])
        doc["agencies"] = new_agencies
        with open(path, "w") as f:
            json.dump(doc, f, separators=(",", ":"))

    print(f"\nAugmented {len(files)-0} state files / {tot} agencies", file=sys.stderr)
    print(f"  mdbId set: {n_mdb}", file=sys.stderr)
    print(f"  fixedRoute=True: {n_fr}", file=sys.stderr)
    print(f"  demandResponse=True: {n_dr}", file=sys.stderr)
    print(f"  lastFeedUpdate set: {n_lu}  (skipped on status=none: {n_lu_skipped_none})",
          file=sys.stderr)


if __name__ == "__main__":
    main()
