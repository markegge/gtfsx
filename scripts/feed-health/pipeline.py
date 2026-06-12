#!/usr/bin/env python3
"""
GTFS Feed Health pipeline — Phases A-C.
NTD spine from Socrata + FTA Weblinks + URL reachability check.

Sources (all open, no auth):
  - NTD roster:   data.transportation.gov resource g27i-aq2u (report_year 2024)
  - FTA Weblinks: data.transportation.gov resource 2u7n-ub22 (GTFS Weblinks crosswalk)

Outputs (to --workdir, default /tmp/feed-health-work/):
  ntd_feed_health.csv      — per-agency join (overwritten; Phase D appends MDB columns)
  ntd_spine.csv            — NTD spine only (for auditing)
  weblinks_not_in_2024_roster.csv
  reachability_cache.json  — URL check cache (persists across runs; commit to seed CI)
  stats_phaseABC.json      — phase summary stats

Usage:
  python3 scripts/feed-health/pipeline.py [--workdir /tmp/feed-health-work]
"""

import argparse, csv, io, json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    import requests
except ImportError:
    sys.exit("requests not installed — run: pip install requests")

ROSTER_YEAR = 2024
SODA        = "https://data.transportation.gov/resource"
TIMEOUT     = 15
WORKERS     = 20
UA          = {"User-Agent": "VectorVertex-GTFSx-FeedHealth/1.0 (research)"}

DEFAULT_WORKDIR = "/tmp/feed-health-work"


def fetch_soda(resource, params):
    rows, offset, limit = [], 0, 5000
    while True:
        p = dict(params); p["$limit"] = limit; p["$offset"] = offset
        url = f"{SODA}/{resource}.json?" + urllib.parse.urlencode(p)
        r = requests.get(url, headers=UA, timeout=60); r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return rows


# ---------- Phase A: NTD spine ----------
def build_spine():
    raw = fetch_soda("g27i-aq2u", {"report_year": ROSTER_YEAR})
    spine = {}
    for r in raw:
        nid = r.get("ntd_id")
        if not nid:
            continue
        spine[nid] = {
            "ntd_id":                 nid,
            "agency_name":            r.get("max_agency", ""),
            "city":                   r.get("max_city", ""),
            "state":                  r.get("max_state", ""),
            "organization_type":      r.get("max_organization_type", ""),
            "reporter_type":          r.get("max_reporter_type", ""),
            "uza_name":               r.get("max_uza_name", ""),
            "agency_voms":            r.get("max_agency_voms", ""),
            "unlinked_passenger_trips": r.get("sum_unlinked_passenger_trips", ""),
            "report_year":            r.get("report_year", str(ROSTER_YEAR)),
        }
    return spine


# ---------- Phase B: FTA Weblinks join ----------

# Manual weblink supplements — feed URLs verified live but absent from BOTH the
# FTA GTFS Weblinks crosswalk and the Mobility Database. Applied at the end of
# Phase B so Phase C checks their reachability naturally; phase_d_mdb.py also
# applies this map when re-running Phase D alone against archived A-C outputs.
# Keys are NTD IDs exactly as they appear in the roster (no leading zeros).
MANUAL_WEBLINKS = {
    # 2026-06-12 dark-Full-Reporter audit: Lafayette City-Parish Consolidated
    # Government / Lafayette Transit System (LFT), Lafayette LA. Live GTFS zip
    # at the Syncromatics endpoint (Transitland feed f-lafayette~la); verified
    # 2026-06-12: HTTP 200, content-disposition gtfs.zip, PK zip magic bytes.
    "60038": "https://lts.syncromatics.com/gtfs",
}


def join_weblinks(spine):
    raw = fetch_soda("2u7n-ub22", {})
    by_agency = {}
    for r in raw:
        nid = r.get("ntd_id")
        if not nid:
            continue
        url = (r.get("weblink") or {}).get("url") if isinstance(r.get("weblink"), dict) else r.get("weblink")
        a = by_agency.setdefault(nid, {"modes": set(), "url": None, "cert": False,
                                       "agency_name": r.get("agency_name", ""),
                                       "state": r.get("state", "")})
        if r.get("mode_name"): a["modes"].add(r["mode_name"])
        if url and not a["url"]:  a["url"] = url
        if r.get("certification_flag"): a["cert"] = True

    weblink_only = []
    for nid, rec in spine.items():
        wl = by_agency.get(nid)
        rec["has_fta_weblink"] = bool(wl and wl["url"])
        rec["weblink_url"]     = wl["url"] if wl else ""
        rec["weblink_modes"]   = ", ".join(sorted(wl["modes"])) if wl else ""
        rec["certification_flag"] = wl["cert"] if wl else False
    for nid, wl in by_agency.items():
        if nid not in spine and wl["url"]:
            weblink_only.append({"ntd_id": nid, "agency_name": wl["agency_name"],
                                 "state": wl["state"], "weblink_url": wl["url"]})

    # Manual supplement: audited feed URLs missing from the FTA crosswalk.
    # Phase C picks these up automatically (run_reachability iterates weblink_url).
    for nid, url in MANUAL_WEBLINKS.items():
        rec = spine.get(nid)
        if rec is not None and not rec["has_fta_weblink"]:
            rec["has_fta_weblink"] = True
            rec["weblink_url"]     = url
    return by_agency, weblink_only


# ---------- Phase C: URL reachability ----------
def check_url(url):
    out = {"url": url, "url_status": None, "url_reachable": False,
           "url_returns_zip": False, "content_type": "", "content_length": "", "note": ""}
    try:
        r = requests.get(url, headers=UA, timeout=TIMEOUT, stream=True, allow_redirects=True)
        out["url_status"]   = r.status_code
        out["content_type"] = r.headers.get("Content-Type", "")
        out["content_length"] = r.headers.get("Content-Length", "")
        out["url_reachable"] = r.ok
        # Accumulate until we have the 4 magic bytes: with Content-Encoding gzip,
        # iter_content may yield an EMPTY first chunk (decoder warm-up), which made
        # zip detection flaky (caught 2026-06-12 on lts.syncromatics.com/gtfs).
        chunk = b""
        if r.ok:
            for piece in r.iter_content(4):
                chunk += piece
                if len(chunk) >= 4:
                    break
        ct    = out["content_type"].lower()
        is_zip = chunk[:2] == b"PK" or "zip" in ct or "octet-stream" in ct
        out["url_returns_zip"] = bool(r.ok and is_zip)
        if r.ok and not is_zip: out["note"] = "2xx but not a zip (likely landing/removed page)"
        r.close()
    except requests.exceptions.SSLError:        out["note"] = "SSL error"
    except requests.exceptions.ConnectTimeout:  out["note"] = "connect timeout"
    except requests.exceptions.ReadTimeout:     out["note"] = "read timeout"
    except requests.exceptions.ConnectionError: out["note"] = "connection error"
    except Exception as e:                      out["note"] = f"error: {type(e).__name__}"
    return out


def run_reachability(spine, workdir):
    cache_path = os.path.join(workdir, "reachability_cache.json")
    urls    = sorted({r["weblink_url"] for r in spine.values() if r.get("weblink_url")})
    results = {}
    if os.path.exists(cache_path):
        try:
            results = json.load(open(cache_path))
        except Exception:
            results = {}
    todo = [u for u in urls if u not in results]
    print(f"  {len(results)} cached, {len(todo)} to check", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(check_url, u): u for u in todo}
        done = 0
        for f in as_completed(futs):
            res = f.result(); results[res["url"]] = res
            done += 1
            if done % 25 == 0:
                json.dump(results, open(cache_path, "w"))
                print(f"  reachability {done}/{len(todo)} (+{len(results)-len(todo)} cached)",
                      file=sys.stderr)
    json.dump(results, open(cache_path, "w"))
    for r in spine.values():
        u  = r.get("weblink_url")
        rr = results.get(u, {}) if u else {}
        r["url_status"]      = rr.get("url_status", "")
        r["url_reachable"]   = rr.get("url_reachable", "")
        r["url_returns_zip"] = rr.get("url_returns_zip", "")
        r["url_note"]        = rr.get("note", "")
    return results


COLS = ["ntd_id", "agency_name", "city", "state", "reporter_type", "organization_type",
        "uza_name", "agency_voms", "unlinked_passenger_trips", "report_year",
        "has_fta_weblink", "weblink_url", "weblink_modes", "certification_flag",
        "url_status", "url_reachable", "url_returns_zip", "url_note"]


def write_csv(spine, weblink_only, workdir):
    path = os.path.join(workdir, "ntd_feed_health.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS); w.writeheader()
        for r in sorted(spine.values(), key=lambda x: x["ntd_id"]):
            w.writerow({k: r.get(k, "") for k in COLS})

    with open(os.path.join(workdir, "ntd_spine.csv"), "w", newline="") as f:
        sc = ["ntd_id", "agency_name", "city", "state", "reporter_type", "organization_type",
              "uza_name", "agency_voms", "unlinked_passenger_trips", "report_year"]
        w = csv.DictWriter(f, fieldnames=sc); w.writeheader()
        for r in sorted(spine.values(), key=lambda x: x["ntd_id"]):
            w.writerow({k: r.get(k, "") for k in sc})

    if weblink_only:
        with open(os.path.join(workdir, "weblinks_not_in_2024_roster.csv"), "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["ntd_id", "agency_name", "state", "weblink_url"])
            w.writeheader()
            for r in sorted(weblink_only, key=lambda x: x["ntd_id"]):
                w.writerow(r)
    return path


def compute_stats(spine, weblink_only):
    vals       = list(spine.values())
    N          = len(vals)
    by_rt      = {}
    for r in vals: by_rt.setdefault(r["reporter_type"], 0); by_rt[r["reporter_type"]] += 1
    no_weblink  = [r for r in vals if not r["has_fta_weblink"]]
    has_weblink = [r for r in vals if r["has_fta_weblink"]]
    unreachable = [r for r in has_weblink if r.get("url_reachable") is False]
    not_zip     = [r for r in has_weblink if r.get("url_reachable") is True and r.get("url_returns_zip") is False]
    good_zip    = [r for r in has_weblink if r.get("url_returns_zip") is True]

    def pct(a, b): return f"{100*a/b:.1f}%" if b else "n/a"

    s = {
        "N_roster":             N,
        "by_reporter_type":     by_rt,
        "no_weblink_n":         len(no_weblink),
        "no_weblink_pct":       pct(len(no_weblink), N),
        "has_weblink_n":        len(has_weblink),
        "unreachable_n":        len(unreachable),
        "unreachable_pct_of_weblinks": pct(len(unreachable), len(has_weblink)),
        "not_zip_n":            len(not_zip),
        "not_zip_pct_of_weblinks": pct(len(not_zip), len(has_weblink)),
        "good_zip_n":           len(good_zip),
        "good_zip_pct_of_weblinks": pct(len(good_zip), len(has_weblink)),
        "no_working_feed_n":    len(no_weblink) + len(unreachable) + len(not_zip),
        "no_working_feed_pct":  pct(len(no_weblink)+len(unreachable)+len(not_zip), N),
        "weblinks_not_in_roster_n": len(weblink_only),
    }
    s["no_weblink_by_rt"] = {}
    for rt in by_rt:
        sub = [r for r in vals if r["reporter_type"] == rt]
        nw  = [r for r in sub if not r["has_fta_weblink"]]
        s["no_weblink_by_rt"][rt] = {"n": len(nw), "of": len(sub), "pct": pct(len(nw), len(sub))}
    return s


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workdir", default=DEFAULT_WORKDIR,
                        help=f"Working directory for outputs (default: {DEFAULT_WORKDIR})")
    args = parser.parse_args()
    workdir = args.workdir
    os.makedirs(workdir, exist_ok=True)

    t0 = time.time()
    print("Phase A: NTD spine...", file=sys.stderr)
    spine = build_spine()
    print(f"  {len(spine)} agencies", file=sys.stderr)

    print("Phase B: FTA Weblinks join...", file=sys.stderr)
    _, weblink_only = join_weblinks(spine)

    print("Phase C: URL reachability...", file=sys.stderr)
    run_reachability(spine, workdir)

    write_csv(spine, weblink_only, workdir)
    stats = compute_stats(spine, weblink_only)
    with open(os.path.join(workdir, "stats_phaseABC.json"), "w") as f:
        json.dump({"generated": time.strftime("%Y-%m-%d %H:%M"), "roster_year": ROSTER_YEAR,
                   "elapsed_sec": round(time.time()-t0, 1), **stats}, f, indent=2)
    print(json.dumps(stats, indent=2))
    print(f"\nDone in {time.time()-t0:.0f}s — outputs in {workdir}", file=sys.stderr)


if __name__ == "__main__":
    main()
