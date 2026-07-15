#!/usr/bin/env python3
"""
GTFS Feed Health publish script — Phases A-D data → public assets.

Reads ntd_feed_health.csv (pipeline output) + flex_coverage.csv and writes:
  1. public/feed-health/data/agencies/<ABBR>.json  (51 files: 50 states + DC)
  2. public/feed-health/fh-data.js                 (regenerated, real per-state values)

Status mapping mirrors the pipeline's OWN definitions (phase_d_mdb.py):
  none    = has_fta_weblink != "True" AND in_mdb != "True"
            (Phase D: no_anywhere — no feed registered with FTA AND not in Mobility Database)
  expired = mdb_expired == "True"
            (MDB-matched feed whose service_date_range_end is already in the past)
  invalid = in_mdb == "True" AND mdb_total_error > 0
            (at least one ERROR-severity notice from the canonical GTFS validator, via MDB)
  ok      = everything else with at least one findable feed
  Priority when multiple conditions apply: none > expired > invalid > ok

Usage:
  python3 scripts/feed-health-publish.py [path/to/ntd_feed_health.csv]
  uv run scripts/feed-health-publish.py [path/to/ntd_feed_health.csv]
"""

import argparse, csv, json, os, re, sys
from datetime import date, datetime

# MDB hosted-dataset filenames embed the capture timestamp, e.g.
# files.mobilitydatabase.org/mdb-195/mdb-195-202604250036/mdb-195-202604250036.zip
# → 2026-04-25. Used as a fallback for lastFeedUpdate when a cache entry predates
# the last_updated (downloaded_at) field added 2026-06.
_MDB_DATE_TOKEN = re.compile(r"/(?:mdb|tld|ntd)-[^/]*-(\d{12})/")


def feed_last_updated(feed):
    """Date (YYYY-MM-DD) the matched MDB feed's latest dataset was last captured.
    Prefers the explicit last_updated (MDB downloaded_at); falls back to the
    timestamp embedded in the hosted_url. Returns None when neither is available."""
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

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CSV = os.path.join(REPO_ROOT, "handoffs", "Feed Health Data", "ntd_feed_health.csv")
OUT_AGENCIES = os.path.join(REPO_ROOT, "public", "feed-health", "data", "agencies")
OUT_FHDATA   = os.path.join(REPO_ROOT, "public", "feed-health", "fh-data.js")

# ── State metadata: abbr → (fips, full_name, region) ──────────────────────────
STATES_META = {
    "AL": ("01", "Alabama",               "South"),
    "AK": ("02", "Alaska",                "West"),
    "AZ": ("04", "Arizona",               "West"),
    "AR": ("05", "Arkansas",              "South"),
    "CA": ("06", "California",            "West"),
    "CO": ("08", "Colorado",              "West"),
    "CT": ("09", "Connecticut",           "Northeast"),
    "DE": ("10", "Delaware",              "Northeast"),
    "DC": ("11", "District of Columbia",  "Northeast"),
    "FL": ("12", "Florida",               "South"),
    "GA": ("13", "Georgia",               "South"),
    "HI": ("15", "Hawaii",                "West"),
    "ID": ("16", "Idaho",                 "West"),
    "IL": ("17", "Illinois",              "Midwest"),
    "IN": ("18", "Indiana",               "Midwest"),
    "IA": ("19", "Iowa",                  "Midwest"),
    "KS": ("20", "Kansas",                "Midwest"),
    "KY": ("21", "Kentucky",              "South"),
    "LA": ("22", "Louisiana",             "South"),
    "ME": ("23", "Maine",                 "Northeast"),
    "MD": ("24", "Maryland",              "Northeast"),
    "MA": ("25", "Massachusetts",         "Northeast"),
    "MI": ("26", "Michigan",              "Midwest"),
    "MN": ("27", "Minnesota",             "Midwest"),
    "MS": ("28", "Mississippi",           "South"),
    "MO": ("29", "Missouri",              "Midwest"),
    "MT": ("30", "Montana",               "West"),
    "NE": ("31", "Nebraska",              "Midwest"),
    "NV": ("32", "Nevada",                "West"),
    "NH": ("33", "New Hampshire",         "Northeast"),
    "NJ": ("34", "New Jersey",            "Northeast"),
    "NM": ("35", "New Mexico",            "West"),
    "NY": ("36", "New York",              "Northeast"),
    "NC": ("37", "North Carolina",        "South"),
    "ND": ("38", "North Dakota",          "Midwest"),
    "OH": ("39", "Ohio",                  "Midwest"),
    "OK": ("40", "Oklahoma",              "South"),
    "OR": ("41", "Oregon",                "West"),
    "PA": ("42", "Pennsylvania",          "Northeast"),
    "RI": ("44", "Rhode Island",          "Northeast"),
    "SC": ("45", "South Carolina",        "South"),
    "SD": ("46", "South Dakota",          "Midwest"),
    "TN": ("47", "Tennessee",             "South"),
    "TX": ("48", "Texas",                 "South"),
    "UT": ("49", "Utah",                  "West"),
    "VT": ("50", "Vermont",               "Northeast"),
    "VA": ("51", "Virginia",              "South"),
    "WA": ("53", "Washington",            "West"),
    "WV": ("54", "West Virginia",         "South"),
    "WI": ("55", "Wisconsin",             "Midwest"),
    "WY": ("56", "Wyoming",               "West"),
}
# FIPS order (used to order STATES in fh-data.js)
STATES_FIPS_ORDER = sorted(STATES_META.keys(), key=lambda a: STATES_META[a][0])

# Full state name → abbr (for flex_coverage.csv which uses full names)
NAME_TO_ABBR = {v[1]: k for k, v in STATES_META.items()}

# Territories in the CSV that are excluded from state outputs
TERRITORIES = {"AS", "GU", "MP", "PR", "VI"}

# Reporter type mapping (pipeline CSV values → JSON contract values)
REPORTER_MAP = {
    "Full Reporter":    "full",
    "Reduced Reporter": "reduced",
    "Rural Reporter":   "rural",
}

# ── Canonical validation targets (from stats_phaseD.json / headline_stats.md) ──
# Used to assert the publish script's aggregates haven't drifted more than 0.5 pp.
# Updated 2026-06-12: removed four confirmed-false MDB matches (Ludington MTA/mdb-926
# was the only pair with no FTA weblink; no_feed count 1017 -> 1018, pct 45.4 -> 45.5).
# Updated 2026-06-12 (fuzzy-fix): three-tier fuzzy policy added. 11 audit-reviewed correct
# pairs in the 90-94 band restored via CONFIRMED_GOOD_MATCHES allowlist in phase_d_mdb.py,
# including 80227 (SCCOG CO) and 80299 (Silver Key CO) which had no FTA weblink.
# Updated 2026-06-12 (dark-Full-Reporter join fixes), all against the June 7 inputs:
#   - norm_url now keeps identity-bearing query strings (drive.google.com/uc?...id=X),
#     un-joining Mission Hill Link 10182 from Long Beach Transit's mdb-1198 and freeing
#     mdb-1198 (-> 90023 via fuzzy 100) and tld-319 (-> 40094 ATI Puerto Rico).
#   - CONFIRMED_GOOD_MATCHES now applies at ANY fuzzy score (Pass 2.5 direct pass);
#     added 20098/mdb-517 (PATH, expired), 40043/tld-6773 (Wave Transit, ok),
#     60033/mdb-2264 (Rock Region METRO, expired).
#   - MANUAL_WEBLINKS supplement: 60038 Lafayette Transit System (lts.syncromatics.com).
#   Net: no_feed 1018 -> 1013/2238 = 45.26% -> still renders 45 (matches fh.js hero);
#   matched 788 (denominator unchanged: -10182 +90023 +3 manual), fail 100/788 = 12.7%,
#   expired 172/788 = 21.8% (PATH, Rock Region, ATI all expired).
# Updated 2026-06-17 ("no findable feed" audit): 11 agencies previously status=none
# confirmed as the SAME agency as a real MDB feed and added to CONFIRMED_GOOD_MATCHES
# (phase_d_mdb.py). They join the findable + matched populations:
#   no_feed   1013 -> 1002 / 2238 = 44.77% -> still renders 45 (matches fh.js hero).
#   matched   788  -> 799  (all 11 carry an MDB validation report).
#   expired   172  -> 175  (20958/40038/40208 have stale service_end) -> 175/799 = 21.9%.
#   fail      100  -> 104  (40038/40208 expired-with-errors + 91018/91041 invalid) ->
#             104/799 = 13.0%.
# NOTE: this constant is a +/-0.5pp drift guard, not the rendered headline; the displayed
# fh-data.js HEADLINE (noFeedPct 45, expiredPct 22, validatorFailPct 12.7) is left frozen
# by this surgical edit and is re-derived on the next full pipeline run.
CANONICAL = {
    "N_roster":              2238,    # full NTD 2024 universe incl. territories
    "no_feed_anywhere_pct":  44.8,    # 1002 / 2238 = 44.77% (post 2026-06-17 audit)
    "fail_validation_pct":   13.0,    # 104  / 799 matched
    "expired_pct_of_matched": 21.9,   # 175  / 799 matched
}

# Constant from NTD Annual Data — Service by Mode and Time Period (wwdp-t4re),
# report_year 2024: agencies reporting Demand Response (mode DR, incl. retired DT
# code absorbed since 2019). Source separate from the 2238-agency NTD annual roster.
DR_AGENCIES = 1925

# Total distinct US GTFS-Flex feeds from Mobility Database (stats_phaseD.json).
# Kept as a constant because the per-feed flex count comes from the MDB catalog,
# not from the per-agency CSV (mdb_is_flex is per-agency-match, not per-feed).
FLEX_FEEDS_TOTAL = 75


# ── Helpers ───────────────────────────────────────────────────────────────────

def get_status(r):
    """
    Map a CSV row to one of: none | expired | invalid | ok.

    Definitions mirror phase_d_mdb.py exactly:
      none    — has_fta_weblink != "True"  AND  in_mdb != "True"
      expired — mdb_expired == "True"
      invalid — in_mdb == "True"  AND  mdb_total_error > 0
      ok      — at least one findable feed, no expiry/validator issue
    Priority: none > expired > invalid > ok.
    """
    has_weblink = r["has_fta_weblink"] == "True"
    in_mdb      = r["in_mdb"] == "True"

    if not has_weblink and not in_mdb:
        return "none"

    if in_mdb:
        if r.get("mdb_expired") == "True":
            return "expired"
        err = r.get("mdb_total_error", "")
        if err not in ("", None, "None"):
            try:
                if int(err) > 0:
                    return "invalid"
            except (ValueError, TypeError):
                pass

    return "ok"


def best_feed_url(r, mdb_by_id):
    """
    Prefer the weblink URL if confirmed working (url_returns_zip=True),
    fall back to registered weblink even if unconfirmed, then MDB producer_url.
    Returns None for none-status agencies (no feed to point to).
    """
    status = get_status(r)
    if status == "none":
        return None

    wl = r.get("weblink_url", "").strip()
    if wl and r.get("url_returns_zip") == "True":
        return wl           # confirmed working zip URL
    if wl:
        return wl           # registered FTA URL (may be stale but it's official)

    # Fall back to MDB URL for agencies matched via MDB only
    mdb_id = r.get("mdb_id", "").strip()
    if mdb_id and mdb_id in mdb_by_id:
        mf = mdb_by_id[mdb_id]
        return mf.get("producer_url") or mf.get("hosted_url") or None
    return None


def load_mdb_cache(csv_path):
    """Load mdb_us_feeds.json from the same directory as the CSV."""
    cache = os.path.join(os.path.dirname(csv_path), "mdb_us_feeds.json")
    if os.path.exists(cache):
        with open(cache) as f:
            feeds = json.load(f)
        return {fd["mdb_id"]: fd for fd in feeds}
    print("  [warn] mdb_us_feeds.json not found — MDB URLs unavailable", file=sys.stderr)
    return {}


def load_flex(csv_path):
    """Load flex_coverage.csv → {state_abbr: flex_feed_count}."""
    flex_path = os.path.join(os.path.dirname(csv_path), "flex_coverage.csv")
    result = {}
    if not os.path.exists(flex_path):
        print("  [warn] flex_coverage.csv not found", file=sys.stderr)
        return result
    for row in csv.DictReader(open(flex_path)):
        abbr = NAME_TO_ABBR.get(row["state"])
        if abbr:
            result[abbr] = int(row["flex_feed_count"])
    return result


# ── National validation ────────────────────────────────────────────────────────

def validate_national(all_rows):
    """
    Assert computed national aggregates match stats_phaseD.json within 0.5 pp.
    Uses all 2238 rows (including territories) to match the canonical pipeline run.
    Calls sys.exit on any breach.
    """
    N = len(all_rows)
    none_n   = sum(1 for r in all_rows if get_status(r) == "none")
    # matched = in_mdb AND has a validation report (mdb_total_error present)
    matched  = [r for r in all_rows
                if r["in_mdb"] == "True"
                and r.get("mdb_total_error", "") not in ("", None, "None")]
    M = len(matched)
    expired_n = sum(1 for r in all_rows if r.get("mdb_expired") == "True")
    fail_n    = sum(1 for r in matched
                    if r.get("mdb_total_error", "") not in ("", None, "None")
                    and int(r["mdb_total_error"]) > 0)

    no_feed_pct = 100 * none_n    / N if N else 0
    exp_pct     = 100 * expired_n / M if M else 0
    val_pct     = 100 * fail_n    / M if M else 0

    LIMIT = 0.5
    errors = []
    if abs(no_feed_pct - CANONICAL["no_feed_anywhere_pct"]) > LIMIT:
        errors.append(
            f"no_feed_pct  computed={no_feed_pct:.1f}%  canonical={CANONICAL['no_feed_anywhere_pct']}%  "
            f"delta={abs(no_feed_pct-CANONICAL['no_feed_anywhere_pct']):.2f}pp  (limit {LIMIT}pp)"
        )
    if abs(exp_pct - CANONICAL["expired_pct_of_matched"]) > LIMIT:
        errors.append(
            f"expired_pct  computed={exp_pct:.1f}%  canonical={CANONICAL['expired_pct_of_matched']}%  "
            f"delta={abs(exp_pct-CANONICAL['expired_pct_of_matched']):.2f}pp"
        )
    if abs(val_pct - CANONICAL["fail_validation_pct"]) > LIMIT:
        errors.append(
            f"val_fail_pct computed={val_pct:.1f}%  canonical={CANONICAL['fail_validation_pct']}%  "
            f"delta={abs(val_pct-CANONICAL['fail_validation_pct']):.2f}pp"
        )
    if N != CANONICAL["N_roster"]:
        errors.append(f"roster N={N} expected {CANONICAL['N_roster']}")

    if errors:
        print("VALIDATION FAILED:", file=sys.stderr)
        for e in errors:
            print(f"  {e}", file=sys.stderr)
        sys.exit("Aborting: national aggregate drift exceeds 0.5 pp — check the source CSV")

    print(f"  Validation passed: N={N}, no_feed={no_feed_pct:.1f}%, "
          f"expired={exp_pct:.1f}%, val_fail={val_pct:.1f}%",
          file=sys.stderr)
    return {"N": N, "none_n": none_n, "no_feed_pct": round(no_feed_pct, 1),
            "M": M, "expired_n": expired_n, "exp_pct": round(exp_pct, 1),
            "fail_n": fail_n, "val_pct": round(val_pct, 1)}


# ── Per-state computation ─────────────────────────────────────────────────────

def compute_state_stats(rows_by_state, flex_by_state):
    """
    Compute per-state metrics for the 50 states + DC.
    Returns a list of dicts in FIPS order matching the fh-data.js STATES shape.
    """
    states = []
    for abbr in STATES_FIPS_ORDER:
        if abbr not in STATES_META:
            continue
        fips, name, region = STATES_META[abbr]
        rows = rows_by_state.get(abbr, [])
        total = len(rows)
        if total == 0:
            # State appears in meta but has no NTD agencies — skip
            continue

        none_n   = sum(1 for r in rows if get_status(r) == "none")
        cov      = round(100 * (total - none_n) / total)
        no_feed  = 100 - cov

        # exp and val denominators: "matched" (in_mdb AND has validation report)
        matched  = [r for r in rows
                    if r["in_mdb"] == "True"
                    and r.get("mdb_total_error", "") not in ("", None, "None")]
        M = len(matched)

        expired_n = sum(1 for r in rows if r.get("mdb_expired") == "True")
        fail_n    = sum(1 for r in matched
                        if r.get("mdb_total_error", "") not in ("", None, "None")
                        and int(r["mdb_total_error"]) > 0)

        exp = round(100 * expired_n / M) if M else 0
        val = round(100 * fail_n    / M) if M else 0

        flex = flex_by_state.get(abbr, 0)

        states.append({
            "fips": fips, "abbr": abbr, "name": name, "region": region,
            "agencies": total,
            "cov": cov, "noFeed": no_feed,
            "exp": exp, "val": val, "flex": flex,
        })
    return states


def compute_gradient(all_rows):
    """
    Per-reporter-type no-feed-anywhere rate (Phase D definition: no_weblink AND not in MDB).
    Matches the headline_stats.md 'size gradient' numbers.
    """
    rt_order = [
        ("Full Reporter",    "full",    "Full Reporters",         "Urbanized, full NTD reporting"),
        ("Reduced Reporter", "reduced", "Reduced Reporters",      "Smaller urbanized + tribal"),
        ("Rural Reporter",   "rural",   "Rural (5311) Agencies",  "Non-urbanized rural service"),
    ]
    gradient = []
    for rt_csv, rt_key, label, sub in rt_order:
        rows = [r for r in all_rows if r["reporter_type"] == rt_csv]
        n = len(rows)
        none_n = sum(1 for r in rows if get_status(r) == "none")
        no_feed_pct = round(100 * none_n / n) if n else 0
        gradient.append({"key": rt_key, "label": label, "sub": sub,
                          "noFeedPct": no_feed_pct, "agencies": n})
    return gradient


# ── Agency JSON output ────────────────────────────────────────────────────────

def write_agency_jsons(rows_by_state, mdb_by_id, as_of_iso):
    """Write public/feed-health/data/agencies/<ABBR>.json for all 50 states + DC."""
    os.makedirs(OUT_AGENCIES, exist_ok=True)
    written = []
    for abbr in STATES_FIPS_ORDER:
        rows = rows_by_state.get(abbr, [])
        agencies = []
        for r in sorted(rows, key=lambda x: x["agency_name"]):
            status   = get_status(r)
            feed_url = best_feed_url(r, mdb_by_id)

            # ── Phase 1 enrichment — fields already produced by the pipeline ──
            # All sourced from the same CSV / MDB cache the script already loads;
            # no feed parsing and no new external calls.
            #   modes      ← weblink_modes (FTA Weblinks crosswalk descriptive string)
            #   orgType    ← organization_type (NTD; ~100% coverage)
            #   isFlex     ← mdb_is_flex (MDB feature flag; True only when matched + flex)
            #   serviceEnd ← service_end of the matched MDB feed (date portion of the
            #                ISO timestamp in mdb_us_feeds.json), None when unmatched
            #   expired    ← mdb_expired (service period already ended)
            #   mdbId      ← mdb_id (Mobility Database feed id, e.g. "mdb-223"),
            #                None when the agency has no MDB match. Together with
            #                ntdId this is the NTD↔MDB crosswalk users need for
            #                FTA's P-50 form; both stay STRINGS (NTD ids carry
            #                leading zeros — never coerce an id to a number).
            mdb_id = r.get("mdb_id", "").strip()
            service_end = None
            last_feed_update = None
            if mdb_id and mdb_id in mdb_by_id:
                se = (mdb_by_id[mdb_id].get("service_end") or "").strip()
                if se:
                    service_end = se[:10]  # YYYY-MM-DD from the ISO timestamp
                # lastFeedUpdate ← MDB downloaded_at (date the feed's latest dataset
                # was last captured by the Mobility Database) — proxy for "feed last
                # published/updated". Distinct from serviceEnd (service-period end).
                last_feed_update = feed_last_updated(mdb_by_id[mdb_id])

            agencies.append({
                "name":         r["agency_name"],
                "ntdId":        r["ntd_id"],
                "mdbId":        mdb_id or None,
                "city":         r["city"] or None,
                "reporterType": REPORTER_MAP.get(r["reporter_type"], r["reporter_type"]),
                "status":       status,
                "feedUrl":      feed_url,
                "lastValidated": None,  # not stored in current CSV pipeline output
                "orgType":      r.get("organization_type") or None,
                "modes":        (r.get("weblink_modes") or "").strip() or None,
                # fixedRoute / demandResponse ← NTD Service-by-Mode classification
                # (wwdp-t4re), full-roster coverage; an agency can be BOTH.
                "fixedRoute":     r.get("fixed_route") == "True",
                "demandResponse": r.get("demand_response") == "True",
                "isFlex":       r.get("mdb_is_flex") == "True",
                "serviceEnd":   service_end,
                "lastFeedUpdate": last_feed_update,
                "expired":      r.get("mdb_expired") == "True",
            })
        payload = {"asOf": as_of_iso, "agencies": agencies}
        out_path = os.path.join(OUT_AGENCIES, f"{abbr}.json")
        with open(out_path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
        written.append((abbr, len(agencies)))
    return written


# ── fh-data.js generation ─────────────────────────────────────────────────────

def fmt_state_row(s):
    """Format a single state entry for the S() call in fh-data.js."""
    return (
        f'    S("{s["fips"]}","{s["abbr"]}","{s["name"]}","{s["region"]}",'
        f'{s["agencies"]},{s["cov"]},{s["exp"]},{s["val"]},{s["flex"]})'
    )


def write_fhdata_js(state_stats, gradient, nat, flex_by_state, as_of_iso, run_month_year):
    """
    Regenerate public/feed-health/fh-data.js wholesale.
    Preserves CTAS verbatim and all non-data HEADLINE fields (drAgencies, refresh, owner).
    Updates: HEADLINE.draftDate, HEADLINE.asOf, HEADLINE.noFeedPct (real),
             HEADLINE.expiredPct, HEADLINE.validatorFailPct, HEADLINE.flexStates,
             GRADIENT (real agency counts), STATES (all real per-state values).
    """
    draft_date_str   = date.fromisoformat(as_of_iso).strftime(f"%B {date.fromisoformat(as_of_iso).day}, %Y")
    flex_states_count = sum(1 for v in flex_by_state.values() if v > 0)

    # HEADLINE values — recomputed from data.
    # Compute integer percentages from raw counts to avoid Python banker's rounding on
    # .5 midpoints (e.g. round(45.5) == 46, not 45, when the true ratio is 45.487%).
    no_feed_pct      = round(100 * nat["none_n"] / nat["N"])  # 45  (1013/2238 = 45.26%)
    expired_pct      = round(100 * nat["expired_n"] / nat["M"]) if nat["M"] else 0   # 22
    val_pct          = nat["val_pct"]                 # keep 1dp (12.6)

    gradient_js = ",\n".join(
        f'    {{ key: "{g["key"]}",  label: "{g["label"]}", '
        f'sub: "{g["sub"]}",  noFeedPct: {g["noFeedPct"]}, agencies: {g["agencies"]} }}'
        for g in gradient
    )

    states_js = ",\n".join(fmt_state_row(s) for s in state_stats)

    js = f"""// GENERATED by scripts/feed-health-publish.py — do not hand-edit.
// Source: ntd_feed_health.csv (NTD FY2024 + FTA Weblinks + URL reachability + Mobility Database).
// Run date: {as_of_iso}.  Re-run scripts/feed-health-publish.py to refresh.
(function () {{
  // ---- Headline findings — recomputed from ntd_feed_health.csv ----
  const HEADLINE = {{
    noFeedPct: {no_feed_pct},         // % of US federally funded agencies w/ no findable GTFS feed
    agencies: 2238,          // FY2024 NTD agency roster (full universe incl. territories)
    expiredPct: {expired_pct},           // % of MDB-matched feeds describing service that already ended
    validatorFailPct: {val_pct}, // % of MDB-matched feeds failing the canonical validator
    flexFeeds: {FLEX_FEEDS_TOTAL},          // distinct US feeds publishing GTFS-Flex (from Mobility Database)
    flexStates: {flex_states_count},         // states with at least one GTFS-Flex feed
    // Agencies reporting Demand Response (mode DR; DT absorbed since report_year 2019) in FY2024 NTD
    // Annual Data — Service by Mode and Time Period (data.transportation.gov wwdp-t4re).
    // Derived separately from the 2238-agency roster; kept as a constant between monthly runs.
    drAgencies: {DR_AGENCIES},
    refresh: "Monthly",
    asOf: "{as_of_iso}",
    draftDate: "{draft_date_str}",
    owner: "Mark Egge",
  }};

  // Size-gradient cut — % of agencies in each NTD reporting class w/ no feed anywhere (Phase D)
  const GRADIENT = [
{gradient_js},
  ];

  // ---- Per-state rows (REAL values computed from ntd_feed_health.csv) ----
  // cov  = % of the state's NTD agencies with a findable GTFS feed (FTA weblink OR Mobility Database)
  // exp  = % of MDB-matched feeds in that state whose service period has already ended
  // val  = % of MDB-matched feeds in that state with at least one ERROR-severity validator notice
  // flex = count of GTFS-Flex feeds that include this state (from flex_coverage.csv; multi-state
  //        feeds counted in each state, so sum > {FLEX_FEEDS_TOTAL} total distinct feeds)
  const S = (fips, abbr, name, region, agencies, cov, exp, val, flex) =>
    ({{ fips, abbr, name, region, agencies, cov, noFeed: 100 - cov, exp, val, flex }});

  const STATES = [
{states_js},
  ];

  // Flex leaderboard — states publishing GTFS-Flex, ranked
  const FLEX = STATES.filter((s) => s.flex > 0).sort((a, b) => b.flex - a.flex);

  // CTA variants keyed to feed condition — RESERVED for per-agency drill-down phase.
  // Not rendered on the public dashboard; kept here for future use.
  const CTAS = [
    {{ key: "edit",  verb: "Edit this feed",  label: "Edit this feed in GTFS·X",
      cond: "Clean feed", desc: "Feed validates and describes current service. Open it to refine stops, trips, and timetables.",
      tone: "teal" }},
    {{ key: "fix",   verb: "Fix this feed",   label: "Fix this feed in GTFS·X",
      cond: "Broken or expired", desc: "Feed fails the canonical validator or describes service that has already ended. Open it to repair and re-export.",
      tone: "gold" }},
    {{ key: "build", verb: "Build a feed",    label: "Build a feed for this agency in GTFS·X",
      cond: "No feed found", desc: "No GTFS feed any trip planner can find. Draw routes, place stops, and publish a validated gtfs.zip.",
      tone: "coral" }},
  ];

  window.FH_DATA = {{ HEADLINE, GRADIENT, STATES, FLEX, CTAS }};
}})();
"""
    with open(OUT_FHDATA, "w") as f:
        f.write(js)


# ── Summary diff ─────────────────────────────────────────────────────────────

# Illustrative baseline from the original fh-data.js (pre-real-data)
ILLUSTRATIVE_STATES = {
    "AL": (27, 38, 24, 16, 0), "AK": (34, 31, 27, 18, 1), "AZ": (41, 57, 19, 11, 0),
    "AR": (30, 33, 26, 17, 0), "CA": (214, 71, 16, 9, 2),  "CO": (58, 74, 14, 8, 41),
    "CT": (27, 69, 18, 10, 0), "DE": (6, 72, 15, 9, 0),    "DC": (4, 88, 9, 5, 0),
    "FL": (96, 61, 20, 12, 5), "GA": (55, 46, 23, 14, 1),  "HI": (9, 64, 17, 10, 0),
    "ID": (24, 35, 25, 16, 0), "IL": (72, 67, 18, 11, 1),  "IN": (43, 49, 22, 13, 0),
    "IA": (35, 44, 23, 14, 0), "KS": (33, 37, 25, 15, 0),  "KY": (34, 41, 24, 15, 0),
    "LA": (31, 40, 24, 15, 0), "ME": (20, 52, 21, 12, 2),  "MD": (24, 73, 15, 9, 0),
    "MA": (36, 78, 13, 7, 1),  "MI": (62, 58, 19, 11, 6),  "MN": (47, 66, 17, 10, 9),
    "MS": (26, 29, 28, 18, 0), "MO": (42, 47, 22, 13, 0),  "MT": (30, 30, 27, 17, 1),
    "NE": (24, 39, 24, 15, 0), "NV": (18, 60, 19, 11, 0),  "NH": (17, 55, 20, 12, 0),
    "NJ": (32, 76, 14, 8, 0),  "NM": (27, 34, 26, 16, 1),  "NY": (78, 80, 12, 7, 2),
    "NC": (58, 53, 21, 13, 1), "ND": (20, 28, 28, 18, 0),  "OH": (64, 56, 20, 12, 0),
    "OK": (31, 36, 25, 16, 0), "OR": (40, 72, 15, 9, 3),   "PA": (58, 68, 17, 10, 1),
    "RI": (7, 79, 13, 7, 0),   "SC": (30, 43, 23, 14, 0),  "SD": (19, 30, 27, 17, 0),
    "TN": (37, 48, 22, 13, 0), "TX": (105, 54, 20, 12, 4), "UT": (22, 70, 16, 9, 1),
    "VT": (14, 58, 19, 11, 2), "VA": (44, 62, 18, 11, 0),  "WA": (52, 75, 14, 8, 3),
    "WV": (28, 32, 27, 17, 0), "WI": (45, 59, 19, 11, 1),  "WY": (16, 27, 29, 18, 0),
}


def detect_data_date(csv_path):
    """
    Infer the data vintage date (YYYY-MM-DD string) from the pipeline outputs.
    Priority:
      1. stats_phaseD.json "generated" field (most reliable: written by phase_d_mdb.py).
      2. CSV file mtime (fallback when stats file is absent).
    The caller may override both by passing --data-date explicitly.
    """
    stats_path = os.path.join(os.path.dirname(csv_path), "stats_phaseD.json")
    if os.path.exists(stats_path):
        try:
            with open(stats_path) as f:
                stats = json.load(f)
            generated = stats.get("generated", "").strip()
            if generated:
                return generated
        except Exception:
            pass
    # Fallback: CSV file mtime
    mtime = os.path.getmtime(csv_path)
    return datetime.utcfromtimestamp(mtime).date().isoformat()


def print_diff(state_stats):
    """Print top movers: states whose cov changed most vs. the illustrative baseline."""
    print("\n── State-value diff (illustrative vs real) ──────────────────────────────")
    print(f"{'Abbr':<5} {'Old agencies':>12} {'New agencies':>12}  {'Old cov':>8} {'New cov':>8}  {'Delta cov':>10}  {'Old flex':>8} {'New flex':>8}")
    movers = []
    for s in state_stats:
        abbr = s["abbr"]
        old  = ILLUSTRATIVE_STATES.get(abbr)
        if not old:
            continue
        old_ag, old_cov, old_exp, old_val, old_flex = old
        delta = s["cov"] - old_cov
        movers.append((abbr, old_ag, s["agencies"], old_cov, s["cov"], delta, old_flex, s["flex"]))
    movers.sort(key=lambda x: abs(x[5]), reverse=True)
    for row in movers[:15]:
        abbr, old_ag, new_ag, old_cov, new_cov, delta, old_flex, new_flex = row
        marker = " <<" if abs(delta) > 10 else ""
        print(f"{abbr:<5} {old_ag:>12} {new_ag:>12}  {old_cov:>7}% {new_cov:>7}%  {delta:>+9}pp{marker}  {old_flex:>8} {new_flex:>8}")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GTFS Feed Health publish script")
    parser.add_argument("csv", nargs="?", default=DEFAULT_CSV,
                        help="Path to ntd_feed_health.csv (pipeline output)")
    parser.add_argument("--data-date", dest="data_date", default=None,
                        help="ISO date (YYYY-MM-DD) of the underlying data vintage. "
                             "Defaults to the 'generated' field in stats_phaseD.json "
                             "in the same directory as the CSV, or the CSV file mtime. "
                             "Stamped into HEADLINE.asOf and HEADLINE.draftDate.")
    args = parser.parse_args()
    csv_path = args.csv

    if not os.path.exists(csv_path):
        sys.exit(f"CSV not found: {csv_path}")

    if args.data_date:
        as_of_iso = args.data_date
    else:
        as_of_iso = detect_data_date(csv_path)
        print(f"  Auto-detected data date: {as_of_iso}", file=sys.stderr)

    run_month_year = date.fromisoformat(as_of_iso).strftime("%B %Y")

    print(f"Reading {csv_path}", file=sys.stderr)
    all_rows = list(csv.DictReader(open(csv_path)))
    print(f"  {len(all_rows)} rows loaded", file=sys.stderr)

    print("Loading auxiliary data...", file=sys.stderr)
    mdb_by_id    = load_mdb_cache(csv_path)
    flex_by_state = load_flex(csv_path)
    print(f"  MDB cache: {len(mdb_by_id)} feeds | flex states: {sorted(flex_by_state.keys())}",
          file=sys.stderr)

    print("Validating national aggregates...", file=sys.stderr)
    nat = validate_national(all_rows)

    # Split rows: 50 states + DC vs territories
    rows_by_state = {}
    for r in all_rows:
        st = r["state"]
        if st in STATES_META:
            rows_by_state.setdefault(st, []).append(r)

    print("Computing per-state stats...", file=sys.stderr)
    state_stats = compute_state_stats(rows_by_state, flex_by_state)
    gradient    = compute_gradient(all_rows)

    print("Writing agency JSON files...", file=sys.stderr)
    written = write_agency_jsons(rows_by_state, mdb_by_id, as_of_iso)
    total_agencies = sum(n for _, n in written)
    print(f"  Wrote {len(written)} state files, {total_agencies} agencies total", file=sys.stderr)

    # Spot-check: sum of all agencies in 50+DC files should equal total - territories
    territory_n = sum(1 for r in all_rows if r["state"] in TERRITORIES)
    expected_50dc = len(all_rows) - territory_n
    if total_agencies != expected_50dc:
        print(f"  [warn] agency count mismatch: wrote {total_agencies}, expected {expected_50dc}",
              file=sys.stderr)

    print("Regenerating fh-data.js...", file=sys.stderr)
    write_fhdata_js(state_stats, gradient, nat, flex_by_state, as_of_iso, run_month_year)
    print(f"  Written: {OUT_FHDATA}", file=sys.stderr)

    # Sanity checks
    co = next((s for s in state_stats if s["abbr"] == "CO"), None)
    va = next((s for s in state_stats if s["abbr"] == "VA"), None)
    assert co and co["flex"] == 41, f"CO flex sanity check failed: got {co}"
    assert va and va["flex"] == 16, f"VA flex sanity check failed: got {va}"
    total_all = sum(r["agencies"] for r in state_stats)
    assert total_all == expected_50dc, f"State total mismatch: {total_all} vs {expected_50dc}"
    print("  Sanity checks passed (CO flex=41, VA flex=16, agency sum matches)", file=sys.stderr)

    print_diff(state_stats)

    print("\n── Summary ──────────────────────────────────────────────────────────────")
    print(f"  As of:        {as_of_iso}")
    print(f"  States+DC:    {len(state_stats)} jurisdictions, {total_agencies} agencies")
    print(f"  National:     {nat['none_n']}/{nat['N']} no-feed ({nat['no_feed_pct']}%), "
          f"exp {nat['exp_pct']}%, val_fail {nat['val_pct']}%")
    print(f"  Flex states:  {sorted(flex_by_state.items(), key=lambda x:-x[1])}")
    print(f"  Output:       {len(written)} agency JSON files + fh-data.js regenerated")


if __name__ == "__main__":
    main()
