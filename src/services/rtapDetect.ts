// RTAP feed detection — a best-effort, copy-only heuristic for whether an
// imported feed was likely built with National RTAP's "GTFS Builder" (a free
// Excel-based tool widely used by rural/tribal transit agencies to produce
// their first GTFS feed).
//
// TODO(rtap-fingerprint): MEASURED against 251 real RTAP feeds + a 115-feed
// non-RTAP control (catalog: gtfsx/handoffs/Feed Health Data/ntd_feed_health.csv;
// every RTAP feed in the set is published under rapid.nationalrtap.org),
// 2026-07. We previously shipped a content-based structural fingerprint (BOM +
// header-only shapes.txt + a fixed full optional-column set, fit to a single
// sample feed) — IT FAILED BADLY and was removed:
//   - Sensitivity on the 96 RTAP feeds that actually needed shapes: 3/96 (3.1%).
//   - has_bom:            RTAP 52/251 (21%)  |  control 8/115  (7%)
//   - shapes_header_only: RTAP 94/251 (37%)  |  control 4/115  (3%)
//   - all_optional_cols:  RTAP 43/251 (17%)  |  control 38/115 (33%)  ← ANTI-CORRELATED
//     (ordinary feeds emit the full optional-column set TWICE as often as RTAP
//     feeds do — mainly because platform_code is absent from 79% of RTAP
//     exports. This signal points the WRONG WAY, it doesn't just fail to fire.)
//   - Precision was perfect (0/115 false positives), but a 3%-recall detector
//     built on one anti-correlated signal isn't worth keeping. The original
//     sample (Skyline Bus / Big Sky MT) was 1 of only 3 feeds in 251 where all
//     three structural signals happened to align — we overfit to n=1.
// DO NOT re-add a content/structural fingerprint without measuring it against
// a real multi-hundred-feed sample first. The lesson of the above isn't "try a
// different combination of columns," it's "feed *content* doesn't reliably
// distinguish GTFS Builder output from an ordinary small-agency feed."
//
// THE SIGNAL THAT ACTUALLY WORKS: every RTAP-built feed we've seen is
// published at rapid.nationalrtap.org (or, for some older feeds,
// demopro.nationalrtap.org) — that's a fact about PROVENANCE, not content, so
// it's exact rather than inferred. See detectRtapFeed's sourceUrl param.
// Known, accepted gap: a feed downloaded from that URL and then re-uploaded as
// a bare ZIP (no URL in hand) is indistinguishable from any other feed at the
// byte level — we do NOT claim RTAP in that case, and that's the honest answer
// given what's actually knowable from the file alone.

import type { FeedInfo, Agency } from '../types/gtfs';

export interface RtapSignals {
  isRtap: boolean;
  confidence: 'high' | 'low';
  /** Human-readable reasons, for the UI/debugging. */
  signals: string[];
}

const NO_SIGNALS: RtapSignals = { isRtap: false, confidence: 'low', signals: [] };

/** True when `hostname` is nationalrtap.org itself or any subdomain of it
 *  (rapid., demopro., …). Compares the parsed URL host, not a raw substring
 *  match, so a lookalike like "nationalrtap.org.evil.com" or
 *  "notnationalrtap.org" can't spoof it. */
function isNationalRtapHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'nationalrtap.org' || h.endsWith('.nationalrtap.org');
}

/**
 * Best-effort RTAP feed detector, exact where we can be and silent otherwise:
 *   1. sourceUrl (where this feed was actually fetched from, if known) hosted
 *      on nationalrtap.org or a subdomain — PROVENANCE, not an inference. High
 *      confidence. This is the primary signal; see the TODO above for why a
 *      content fingerprint was tried and abandoned.
 *   2. An explicit textual self-identification ("National RTAP" / a
 *      nationalrtap.org URL) inside feed_info.txt/agency.txt — high confidence
 *      when present, but rare in practice (real RTAP exports are typically
 *      entirely agency-branded).
 *   3. A bare "rtap" or "gtfs builder" mention — low confidence, since both
 *      are generic enough to false-positive.
 * No signal (in particular: a bare ZIP upload with no known source URL, and no
 * self-identifying string) → isRtap:false. We do NOT guess from feed content;
 * see the TODO for exactly why that failed. This function is copy-only: it
 * never gates whether the shapes-from-stops fix is offered (feedNeedsShapes
 * does that on its own, from actual geometry), only how the offer is worded.
 * Getting this wrong costs nothing but a slightly-off sentence.
 *
 * PURE. Absence of any signal is the overwhelmingly common case (and, for a
 * plain file upload, the only honest answer) — it should read as "no basis to
 * say so," not "confirmed not RTAP."
 */
export function detectRtapFeed(
  feedInfo: FeedInfo | null | undefined,
  agencies: Agency[],
  sourceUrl?: string | null,
): RtapSignals {
  const signals: string[] = [];
  let high = false;

  // Provenance: where did this feed actually come from? Parsed via URL() so a
  // query string or lookalike domain can't spoof the host match. An invalid/
  // relative sourceUrl just means "unknown," not a crash.
  if (sourceUrl) {
    try {
      const host = new URL(sourceUrl).hostname;
      if (isNationalRtapHost(host)) {
        signals.push(`fetched from ${host}`);
        high = true;
      }
    } catch {
      // Not a parseable absolute URL — no provenance signal, not an error.
    }
  }

  // Candidate free-text fields to scan. feed_info.txt is the most likely spot
  // for a tool/publisher stamp; agency.txt is included because a small agency
  // using RTAP's tool may leave the sample agency_url pointed at RTAP's own
  // site if they don't have a website of their own yet.
  const nameFields: Array<{ label: string; value: string | undefined }> = [
    { label: 'feed_publisher_name', value: feedInfo?.feed_publisher_name },
    { label: 'feed_version', value: feedInfo?.feed_version },
    ...agencies.map((a, i) => ({ label: `agency.txt row ${i + 1} agency_name`, value: a.agency_name })),
  ];
  const urlFields: Array<{ label: string; value: string | undefined }> = [
    { label: 'feed_publisher_url', value: feedInfo?.feed_publisher_url },
    ...agencies.map((a, i) => ({ label: `agency.txt row ${i + 1} agency_url`, value: a.agency_url })),
  ];

  // High-confidence: an exact "National RTAP" phrase, or a URL whose host is
  // (or clearly is) RTAP's own domain — these are unambiguous mentions of the
  // organization itself, not just the acronym.
  for (const { label, value } of nameFields) {
    if (value && /national\s*rtap/i.test(value)) {
      signals.push(`${label} mentions "National RTAP"`);
      high = true;
    }
  }
  for (const { label, value } of urlFields) {
    if (value && /nationalrtap\.org/i.test(value)) {
      signals.push(`${label} points at nationalrtap.org`);
      high = true;
    }
  }

  // Low-confidence: a bare "rtap" or "gtfs builder" mention. Weaker because
  // "rtap" is also a generic acronym (state RTAPs, unrelated orgs) and
  // "gtfs builder" is a generic-sounding tool name.
  if (!high) {
    for (const { label, value } of [...nameFields, ...urlFields]) {
      if (value && /\brtap\b/i.test(value)) {
        signals.push(`${label} mentions "RTAP"`);
      } else if (value && /gtfs\s*builder/i.test(value)) {
        signals.push(`${label} mentions "GTFS Builder"`);
      }
    }
  }

  if (signals.length === 0) return NO_SIGNALS;
  return { isRtap: true, confidence: high ? 'high' : 'low', signals };
}
