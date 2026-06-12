#!/usr/bin/env python3
"""
GTFS Feed Health — Phase D: Mobility Database cross-reference.

Joins MDB US GTFS feeds onto the NTD spine (produced by pipeline.py) to add:
  - "no feed anywhere" tightening (no FTA weblink AND no MDB match)
  - Validation-failure rate (MDB-matched denominator)
  - Feed expiry (mdb_expired flag)
  - Flex coverage (per-state)
  - mdb_unmatched_us.csv (US MDB feeds with no NTD match — candidate sub-recipients)

Auth:
  Reads MDB refresh token from env var MOBILITY_DATABASE_REFRESH_TOKEN.
  The token is exchanged for a short-lived access token via POST /v1/tokens.
  The token is NEVER written to disk.

MDB catalog cache:
  mdb_us_feeds.json in --workdir is written on first run and reused on subsequent runs.
  Delete it to force a fresh pull.
  Tradeoff: committing this cache to the repo (~1 MB) seeds CI and avoids a full API
  crawl (1,600+ feeds) on every monthly run. Without a seed, Phase D takes ~60s.

Usage:
  python3 scripts/feed-health/phase_d_mdb.py [--workdir /tmp/feed-health-work]
  MOBILITY_DATABASE_REFRESH_TOKEN=<token> python3 scripts/feed-health/phase_d_mdb.py
"""

import argparse, csv, json, os, re, sys, time
from datetime import date

try:
    import requests
except ImportError:
    sys.exit("requests not installed — run: pip install requests")

API     = "https://api.mobilitydatabase.org/v1"
UA      = {"User-Agent": "VectorVertex-GTFSx-FeedHealth/1.0"}
TODAY   = date.today().isoformat()

DEFAULT_WORKDIR = "/tmp/feed-health-work"

FLEX_KEYS = {"flex", "booking rules", "location groups", "predefined routes",
             "demand responsive", "flexible"}

# Confirmed false matches — blocked from joining regardless of score.
# Source: 2026-06-12 data audit (manual name/location review).
# Each tuple is (ntd_id_normalized, mdb_id).
CONFIRMED_FALSE_MATCHES = {
    ("50034", "mdb-223"),   # Jackson Area Transp. Auth. (MI) wrongly matched to Bay Area Transp. Auth.
    ("50459", "mdb-926"),   # Ludington MTA (MI) wrongly matched to Flint MTA
    ("50569", "tld-4472"),  # Chicago State Univ. (IL) wrongly matched to Univ. of Chicago
    ("66283", "mdb-582"),   # South Central RTD NM wrongly matched to North Central RTD
    ("10182", "mdb-1198"),  # 2026-06-12 dark-Full-Reporter audit: Mission Hill Link (Boston MA)
                            #   wrongly URL-joined to Long Beach Transit (CA) because norm_url used
                            #   to strip query strings, collapsing every drive.google.com/uc?...id=X
                            #   URL to "drive.google.com/uc". The norm_url fix below resolves it;
                            #   this entry is belt-and-suspenders.
}

# Three-tier fuzzy-match policy (implemented in Pass 3 below):
#   >= 95  : auto-accept (plus state geography check).
#   90-94  : written to fuzzy_review_queue.csv for human review each monthly run.
#   < 90   : reject.
#
# CONFIRMED_GOOD_MATCHES — audit-reviewed correct (ntd_id_normalized, mdb_id) pairs.
# Applied as a DIRECT match pass (Pass 2.5 in main) at ANY fuzzy score, before the
# fuzzy pass — the score recorded in each comment is provenance, not a gate.
# (Until 2026-06-12 this set was only consulted inside the 90-94 fuzzy band, which
# silently dropped audited pairs scoring below 90.)
# Originally seeded from the 2026-06 run: re-ran threshold-90 logic against June-7
# inputs, diffed against threshold-95 results, removed the 4 CONFIRMED_FALSE pairs.
CONFIRMED_GOOD_MATCHES = {
    # score 93
    ("88294", "mdb-811"),   # San Miguel Authority for Regional Transportation, dba: SMART (Telluride CO)
    # score 92
    ("10098", "tld-7871"),  # Western Maine Transportation Services, Inc. (Auburn ME)
    ("30008", "mdb-381"),   # Greater Lynchburg Transit Company (Lynchburg VA)
    ("70013", "mdb-575"),   # Metropolitan Transit Authority of Black Hawk County, dba: MET Transit (Waterloo IA)
    # score 91
    ("10064", "mdb-418"),   # Greater Attleboro-Taunton Regional Transit Authority / GATRA (Taunton MA)
    ("40042", "mdb-2263"),  # Birmingham-Jefferson County Transit Authority / MAX (Birmingham AL)
    ("80299", "mdb-2182"),  # Silver Key Senior Services, Inc. (Colorado Springs CO) — demand-response
                            #   senior transit; MDB "Flex" suffix is feed-type, not org name; confirmed
                            #   via silverkey-co-us Trillium URL + transit.dot.gov NTD profile 80299
    # score 90
    ("30045", "mdb-1324"),  # JAUNT, Inc. (Charlottesville VA)
    ("50315", "mdb-2332"),  # Shawnee Mass Transit District (Vienna IL)
    ("80227", "mdb-2181"),  # Huerfano/Las Animas Area COG, dba: South Central Council of Governments
                            #   (Trinidad CO) — 2026-06-12 audit: confirmed correct via exact DBA-name
                            #   match with MDB "South Central Council of Governments (SCCOG)"
    ("90298", "mdb-31"),    # County of Ventura (Ventura CA) — VCTC feed; has FTA weblink so no-feed
                            #   status unaffected either way
    # 2026-06-12 dark-Full-Reporter audit — correct pairs BELOW the 90 fuzzy band,
    # matched via the Pass 2.5 direct pass. Two are status=inactive in the MDB
    # snapshot but the feeds are actively maintained (verified on Transitland
    # 2026-06-12); their stale service_end values correctly surface the agencies
    # as "expired" rather than "no feed anywhere".
    ("20098", "mdb-517"),   # Port Authority Trans-Hudson Corporation / PATH (NJ-NY) — fuzzy 88.5;
                            #   trilliumtransit path-nj-us feed; MDB status=inactive (see note above)
    ("40043", "tld-6773"),  # City of Mobile / THE WAVE TRANSIT SYSTEM (Mobile AL) — fuzzy 66.7;
                            #   availtec realtimemobile.availtec.com feed; MDB status=active
    ("60033", "mdb-2264"),  # Rock Region Metropolitan Transit Authority / Rock Region METRO
                            #   (North Little Rock AR) — fuzzy 78.6; rrmetro.org/gtfs.zip;
                            #   MDB status=inactive (see note above)
}


def access_token():
    rt = os.environ.get("MOBILITY_DATABASE_REFRESH_TOKEN", "").strip()
    if not rt:
        sys.exit("MOBILITY_DATABASE_REFRESH_TOKEN not set in environment")
    r = requests.post(f"{API}/tokens", json={"refresh_token": rt}, headers=UA, timeout=60)
    r.raise_for_status()
    return r.json()["access_token"]


# URL normalization: query strings are usually tracking noise, but on file-hosting
# endpoints the query IS the identity (drive.google.com/uc?export=download&id=XXXX).
# Stripping it collapsed every Google Drive feed URL to "drive.google.com/uc", which
# wrongly joined NTD 10182 (Mission Hill Link, Boston MA) to mdb-1198 (Long Beach
# Transit, CA) — caught by the 2026-06-12 audit. Keep the query (params sorted for
# stable comparison) when the host is a known document host OR the path is a single
# generic download segment that is non-distinctive on its own.
QUERY_BEARING_HOSTS = ("drive.google.com", "docs.google.com", "dropbox.com",
                       "onedrive.live.com", "sharepoint.com")
GENERIC_DOWNLOAD_PATH = re.compile(r"^[^/]+/(uc|dl|download|file|files|get|export)$")


def norm_url(u):
    if not u: return ""
    u = u.strip().lower()
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    u = u.split("#")[0]
    base, _, query = u.partition("?")
    base = base.rstrip("/")
    host = base.split("/")[0]
    if query and (any(host == h or host.endswith("." + h) for h in QUERY_BEARING_HOSTS)
                  or GENERIC_DOWNLOAD_PATH.match(base)):
        return base + "?" + "&".join(sorted(query.split("&")))
    return base


def norm_ntd(x):
    if x is None: return ""
    s = re.sub(r"\D", "", str(x))
    return s.lstrip("0") or ("0" if s else "")


def pull_mdb(tok, cache_path):
    if os.path.exists(cache_path):
        print(f"  Using cached MDB catalog: {cache_path}", file=sys.stderr)
        return json.load(open(cache_path))
    feeds, off = [], 0
    while True:
        r = requests.get(f"{API}/gtfs_feeds",
                         params={"country_code": "US", "limit": 1000, "offset": off},
                         headers={**UA, "Authorization": f"Bearer {tok}"}, timeout=120)
        r.raise_for_status(); batch = r.json()
        if not batch: break
        for f in batch:
            ld      = f.get("latest_dataset") or {}
            vr      = ld.get("validation_report") or {}
            states  = sorted({(l.get("subdivision_name") or "") for l in (f.get("locations") or [])
                               if l.get("subdivision_name")})
            ntd_ids = [norm_ntd(e.get("external_id")) for e in (f.get("external_ids") or [])
                       if (e.get("source") or "").lower() == "ntd"]
            si = f.get("source_info") or {}
            feeds.append({
                "mdb_id":       f.get("id"),
                "provider":     f.get("provider") or "",
                "feed_name":    f.get("feed_name") or "",
                "producer_url": si.get("producer_url") or "",
                "hosted_url":   ld.get("hosted_url") or "",
                "states":       states,
                "ntd_ids":      [n for n in ntd_ids if n],
                "status":       f.get("status") or "",
                "total_error":  vr.get("total_error"),
                "total_warning": vr.get("total_warning"),
                "features":     vr.get("features") or [],
                "service_end":  ld.get("service_date_range_end") or "",
            })
        off += 1000
    json.dump(feeds, open(cache_path, "w"))
    return feeds


def is_flex(features):
    fl = [x.lower() for x in features]
    return any(any(k in x for k in FLEX_KEYS) for x in fl)


def apply_manual_weblinks(rows, workdir):
    """Apply pipeline.MANUAL_WEBLINKS to spine rows that lack an FTA weblink.

    The supplement is normally applied in Phase B (join_weblinks), but Phase-D-only
    reruns against archived A-C outputs would otherwise miss it. Reachability is
    checked with the same check_url used in Phase C, through the workdir
    reachability cache, so url_status/url_returns_zip populate naturally."""
    from pipeline import MANUAL_WEBLINKS, check_url
    by_norm = {norm_ntd(k): v for k, v in MANUAL_WEBLINKS.items()}
    cache_path = os.path.join(workdir, "reachability_cache.json")
    cache = {}
    if os.path.exists(cache_path):
        try:
            cache = json.load(open(cache_path))
        except Exception:
            cache = {}
    cache_dirty = False
    for r in rows:
        url = by_norm.get(r["_ntd_norm"])
        if not url:
            continue
        # Apply when the row has no weblink at all; also refresh the url_* fields
        # when a previous Phase-D run already stamped this same manual URL into the
        # CSV (Phase D overwrites its own input, so reruns must be idempotent).
        if r.get("has_fta_weblink") == "True" and r.get("weblink_url") != url:
            continue
        if url not in cache:
            print(f"  manual weblink: checking {url} (NTD {r['ntd_id']})", file=sys.stderr)
            cache[url] = check_url(url)
            cache_dirty = True
        res = cache[url]
        r["has_fta_weblink"] = "True"
        r["weblink_url"]     = url
        r["_url_norm"]       = norm_url(url)
        r["url_status"]      = res.get("url_status", "")
        r["url_reachable"]   = res.get("url_reachable", "")
        r["url_returns_zip"] = res.get("url_returns_zip", "")
        r["url_note"]        = res.get("note", "")
    if cache_dirty:
        json.dump(cache, open(cache_path, "w"))


def load_spine(workdir):
    path = os.path.join(workdir, "ntd_feed_health.csv")
    if not os.path.exists(path):
        sys.exit(f"ntd_feed_health.csv not found in {workdir} — run pipeline.py first")
    rows = list(csv.DictReader(open(path)))
    for r in rows:
        r["_ntd_norm"] = norm_ntd(r["ntd_id"])
        r["_url_norm"] = norm_url(r.get("weblink_url"))
    apply_manual_weblinks(rows, workdir)
    return rows


def fuzzy(a, b):
    try:
        from rapidfuzz.fuzz import token_set_ratio
        return token_set_ratio(a, b)
    except Exception:
        from difflib import SequenceMatcher
        return SequenceMatcher(None, a.lower(), b.lower()).ratio() * 100


def _state_abbrevs(state_names):
    M = {
        "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
        "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
        "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
        "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
        "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
        "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS",
        "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV",
        "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
        "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK",
        "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
        "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX",
        "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
        "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
        "District of Columbia": "DC", "Puerto Rico": "PR",
    }
    return {M.get(s, s) for s in state_names}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", default=DEFAULT_WORKDIR,
                        help=f"Working directory (must contain ntd_feed_health.csv from pipeline.py)")
    args = parser.parse_args()
    workdir = args.workdir
    os.makedirs(workdir, exist_ok=True)

    cache = os.path.join(workdir, "mdb_us_feeds.json")
    # Defer token exchange until we know the cache is absent — avoids a
    # network call when re-running against an already-seeded workdir.
    tok   = None if os.path.exists(cache) else access_token()
    feeds = pull_mdb(tok, cache)
    print(f"MDB US feeds: {len(feeds)}", file=sys.stderr)

    spine  = load_spine(workdir)
    by_ntd = {r["_ntd_norm"]: r for r in spine if r["_ntd_norm"]}
    by_url = {}
    for r in spine:
        if r["_url_norm"]: by_url.setdefault(r["_url_norm"], r)

    # distinct features audit
    feat = {}
    for f in feeds:
        for x in f["features"]: feat[x] = feat.get(x, 0) + 1

    for r in spine:
        r["in_mdb"] = False; r["mdb_id"] = ""; r["mdb_total_error"] = ""; r["mdb_total_warning"] = ""
        r["mdb_service_end"] = ""; r["mdb_is_flex"] = ""; r["join_method"] = ""; r["mdb_expired"] = ""

    matched_feed_ids = set()

    def attach(r, f, method):
        # Block confirmed false matches from the 2026-06-12 audit.
        if (r.get("_ntd_norm", ""), f["mdb_id"]) in CONFIRMED_FALSE_MATCHES:
            return
        if r["in_mdb"] and r["mdb_service_end"] >= (f["service_end"] or ""):
            matched_feed_ids.add(f["mdb_id"]); return
        r["in_mdb"]            = True
        r["mdb_id"]            = f["mdb_id"]
        r["mdb_total_error"]   = f["total_error"]
        r["mdb_total_warning"] = f["total_warning"]
        r["mdb_service_end"]   = f["service_end"]
        r["mdb_is_flex"]       = is_flex(f["features"])
        r["mdb_expired"]       = (f["service_end"][:10] < TODAY) if f["service_end"] else ""
        r["join_method"]       = method
        matched_feed_ids.add(f["mdb_id"])

    # Pass 1: NTD external id (clean)
    for f in feeds:
        for n in f["ntd_ids"]:
            if n in by_ntd: attach(by_ntd[n], f, "ntd_id")
    # Pass 2: URL
    for f in feeds:
        if f["mdb_id"] in matched_feed_ids: continue
        for u in (norm_url(f["producer_url"]), norm_url(f["hosted_url"])):
            if u and u in by_url: attach(by_url[u], f, "url"); break
    # Pass 2.5: audited manual matches — CONFIRMED_GOOD_MATCHES applied directly,
    # at ANY fuzzy score, before the fuzzy pass so an audited pair cannot lose its
    # feed to a higher-scoring wrong candidate. Deliberately includes MDB entries
    # with status=inactive (e.g. mdb-517 PATH, mdb-2264 Rock Region METRO): neither
    # pull_mdb nor the join passes filter on status, and an inactive entry's stale
    # service_end correctly marks the agency "expired" rather than "no feed
    # anywhere" — the accurate state for recently-lapsed-in-MDB feeds.
    feeds_by_id = {f["mdb_id"]: f for f in feeds}
    for ntd_norm, mdb_id in sorted(CONFIRMED_GOOD_MATCHES):
        r, f = by_ntd.get(ntd_norm), feeds_by_id.get(mdb_id)
        if r is not None and f is not None:
            attach(r, f, "manual_audit")
    # Pass 3: fuzzy name — three-tier policy (see CONFIRMED_GOOD_MATCHES above)
    unmatched_feeds   = [f for f in feeds if f["mdb_id"] not in matched_feed_ids]
    no_mdb_agencies   = [r for r in spine if not r["in_mdb"]]
    review_queue      = []   # 90-94 candidates not yet allowlisted — written to fuzzy_review_queue.csv
    for f in unmatched_feeds:
        name = f["provider"] or f["feed_name"]
        if not name: continue
        best, bestr = None, 0
        fstates = set(f["states"])
        for r in no_mdb_agencies:
            if fstates and r["state"] and r["state"] not in _state_abbrevs(fstates): continue
            sc = fuzzy(name, r["agency_name"])
            if sc > bestr: bestr, best = sc, r
        if not best:
            continue
        if bestr >= 95:
            # Tier 1: auto-accept (geography guard applied above already).
            attach(best, f, f"name_fuzzy_{int(bestr)}")
        elif bestr >= 90:
            # Tier 2: audited pairs already joined in Pass 2.5 (any score), so
            # anything landing here is un-reviewed — queue for human review.
            pair_key = (best.get("_ntd_norm", ""), f["mdb_id"])
            if pair_key not in CONFIRMED_FALSE_MATCHES and not best.get("in_mdb"):
                # Queue for human review — not a known-false pair, not already matched.
                review_queue.append({
                    "ntd_id":       best.get("ntd_id", ""),
                    "agency_name":  best.get("agency_name", ""),
                    "state":        best.get("state", ""),
                    "mdb_id":       f["mdb_id"],
                    "provider":     name,
                    "score":        int(bestr),
                })
        # score < 90: reject silently (too noisy to surface).

    flex_feeds = [f for f in feeds if is_flex(f["features"])]
    unmatched  = [f for f in feeds if f["mdb_id"] not in matched_feed_ids]

    write_outputs(spine, feeds, flex_feeds, unmatched, feat, workdir, review_queue)


def write_outputs(spine, feeds, flex_feeds, unmatched, feat, workdir, review_queue=None):
    base  = ["ntd_id", "agency_name", "city", "state", "reporter_type", "organization_type",
             "uza_name", "agency_voms", "unlinked_passenger_trips", "report_year",
             "has_fta_weblink", "weblink_url", "weblink_modes", "certification_flag",
             "url_status", "url_reachable", "url_returns_zip", "url_note"]
    extra = ["in_mdb", "mdb_id", "mdb_total_error", "mdb_total_warning",
             "mdb_expired", "mdb_is_flex", "join_method"]

    with open(os.path.join(workdir, "ntd_feed_health.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=base+extra); w.writeheader()
        for r in spine: w.writerow({k: r.get(k, "") for k in base+extra})

    with open(os.path.join(workdir, "mdb_unmatched_us.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["mdb_id", "provider", "feed_name", "states", "producer_url",
                    "total_error", "service_end", "is_flex"])
        for f in sorted(unmatched, key=lambda x: x["provider"]):
            w.writerow([f["mdb_id"], f["provider"], f["feed_name"],
                        "; ".join(f["states"]), f["producer_url"],
                        f["total_error"], f["service_end"], is_flex(f["features"])])

    state_flex = {}
    for f in flex_feeds:
        for s in (f["states"] or ["(unknown)"]):
            state_flex[s] = state_flex.get(s, 0) + 1
    with open(os.path.join(workdir, "flex_coverage.csv"), "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["state", "flex_feed_count"])
        for s, c in sorted(state_flex.items(), key=lambda x: -x[1]):
            w.writerow([s, c])

    # Fuzzy review queue — 90-94 score pairs not yet in CONFIRMED_GOOD_MATCHES.
    # Intended for monthly human review: inspect each pair and either add to
    # CONFIRMED_GOOD_MATCHES (if correct) or CONFIRMED_FALSE_MATCHES (if wrong).
    # Filter out agencies that ended up matched via the allowlist (ntd_id match is post-loop).
    matched_ntd_ids = {r["ntd_id"] for r in spine if r.get("in_mdb")}
    rq = [item for item in (review_queue or []) if item["ntd_id"] not in matched_ntd_ids]
    rq_path = os.path.join(workdir, "fuzzy_review_queue.csv")
    with open(rq_path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["ntd_id", "agency_name", "state",
                                           "mdb_id", "provider", "score"])
        w.writeheader()
        for item in sorted(rq, key=lambda x: (-x["score"], x["state"], x["agency_name"])):
            w.writerow(item)
    if rq:
        print(f"  fuzzy_review_queue.csv: {len(rq)} pair(s) need review (score 90-94, not yet allowlisted)",
              file=sys.stderr)
    else:
        print("  fuzzy_review_queue.csv: empty (all 90-94 pairs are in allowlist or blocked)",
              file=sys.stderr)

    N        = len(spine)
    in_mdb   = [r for r in spine if r["in_mdb"]]
    no_wl    = [r for r in spine if r["has_fta_weblink"] != "True"]
    no_anywhere = [r for r in spine if r["has_fta_weblink"] != "True" and not r["in_mdb"]]
    matched  = [r for r in spine if r["in_mdb"] and r["mdb_total_error"] not in ("", None)]
    fail_val = [r for r in matched
                if isinstance(r["mdb_total_error"], int) and r["mdb_total_error"] > 0]
    expired  = [r for r in spine if r["mdb_expired"] is True]
    flex_ag  = [r for r in spine if r["mdb_is_flex"] is True]
    jm = {}
    for r in in_mdb: jm[r["join_method"]] = jm.get(r["join_method"], 0) + 1

    def pct(a, b): return f"{100*a/b:.1f}%" if b else "n/a"

    stats = {
        "generated":             TODAY,
        "N_roster":              N,
        "mdb_us_feeds_total":    len(feeds),
        "agencies_in_mdb":       len(in_mdb),
        "agencies_in_mdb_pct":   pct(len(in_mdb), N),
        "no_fta_weblink":        len(no_wl),
        "no_feed_ANYWHERE":      len(no_anywhere),
        "no_feed_anywhere_pct":  pct(len(no_anywhere), N),
        "matched_for_validation": len(matched),
        "fail_validation_n":     len(fail_val),
        "fail_validation_pct":   pct(len(fail_val), len(matched)),
        "expired_n":             len(expired),
        "expired_pct_of_matched": pct(len(expired), len(matched)),
        "flex_agencies":         len(flex_ag),
        "flex_feeds_total":      len(flex_feeds),
        "mdb_unmatched_us":      len(unmatched),
        "fuzzy_review_queue_n":  len(rq),
        "join_methods":          jm,
        "top_features":          sorted(feat.items(), key=lambda x: -x[1])[:25],
    }
    with open(os.path.join(workdir, "stats_phaseD.json"), "w") as fh:
        json.dump(stats, fh, indent=2)
    print(json.dumps(stats, indent=2))
    print(f"\nOutputs written to {workdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
