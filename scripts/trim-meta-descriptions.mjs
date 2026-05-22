// One-time content edit: replace each page's <meta name="description"> with
// the trimmed (140-155 char) copy from the TICKET-H handoff. Each replacement
// preserves the search-relevant phrases from the original. Idempotent —
// matches on the file path so re-running after a description has already been
// updated is a no-op (the regex will simply not find the old content).
//
//   node scripts/trim-meta-descriptions.mjs
//
// Pages: 23 static HTML files. /pricing/ and /demo/ are SSR'd in
// worker/marketing/ssr.ts and were edited there.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// path-relative-to-repo → new description content
const REPLACEMENTS = {
  // Note: the homepage edit is already in the manual diff for index.html;
  // including here keeps the script self-documenting and idempotent.
  'index.html':
    'Free browser-based GTFS editor. Build routes, stops, schedules, fares, and timetables on an interactive map. Import and export standard GTFS ZIPs.',

  'public/about/index.html':
    'GTFS·X is a browser-based editor for creating, maintaining, and publishing GTFS transit feeds. Free editing; paid plans add publishing and analysis.',

  'public/docs/index.html':
    'GTFS·X documentation: editor panels, analysis tools (cost, demographic coverage, Title VI), publishing, and import/export. Everything in the editor.',
  'public/docs/quick-start/index.html':
    'A 7-step quick start for GTFS·X: set up an agency, calendars, routes, stops, timetables, fares, and export a standards-compliant GTFS feed.',
  'public/docs/hosted-publishing/index.html':
    'Publish your GTFS feed to a stable URL at feeds.gtfsx.com so trip planners, regulators, and riders can consume it. Draft previews and update workflow.',
  'public/docs/cost-estimation/index.html':
    'Estimate operating cost for any GTFS feed: revenue hours, peak vehicle count, weekly and annual cost per route and system-wide, with deadhead factor.',
  'public/docs/demographic-coverage/index.html':
    'Population, households, and workers within walking distance of GTFS stops, computed from US Census ACS data. Per-route and system-wide figures.',
  'public/docs/title-vi-analysis/index.html':
    'Title VI equity analysis: compare service levels in minority and non-minority block groups using ACS data, with the four-fifths threshold from FTA C 4702.1B.',
  'public/docs/rider-propensity/index.html':
    'Nationwide map layer showing transit-propensity population and jobs as dots — useful for spotting under-served demand pockets when planning routes.',
  'public/docs/agency-setup/index.html':
    'Configure agency.txt in GTFS·X: agency name, URL, timezone, multi-agency joint feeds, and the spec gotchas (one timezone per agency, agency_id rules).',
  'public/docs/service-calendars/index.html':
    'Build calendar.txt and calendar_dates.txt in GTFS·X: day-of-week toggles, date ranges, holiday exceptions, and calendar_dates-only one-off services.',
  'public/docs/routes-and-shapes/index.html':
    'Draw and edit transit route alignments in GTFS·X: snap-to-road via Mapbox Map Matching, freehand drawing, per-direction shape variants, route metadata.',
  'public/docs/stops/index.html':
    'Place and edit GTFS stops with snap-to-route curbside offset, freehand placement for park-and-rides, duplicate detection, and wheelchair-boarding metadata.',
  'public/docs/fares/index.html':
    'Define GTFS fares in GTFS·X: flat fares, zone-based matrices, multiple fare types. Fares v1 (fare_attributes / fare_rules) authored; v2 round-trips.',
  'public/docs/transfers/index.html':
    'Model transfers.txt in GTFS·X: recommended / timed (vehicle waits) / minimum time / not possible. Cross-platform rail, hub-bus, mode-change transfers.',
  'public/docs/timetables-and-trips/index.html':
    'Build GTFS timetables in GTFS·X: trip grid, auto-interpolation, duplicate-with-offset for repeating service, frequency editor for headway service.',
  'public/docs/flex-zones-and-booking-rules/index.html':
    'Author GTFS-Flex zones in GTFS·X: polygon zones, stop groups, auto-generate from fixed routes; pickup/drop-off windows, booking rules, fare assignment.',
  'public/docs/validation/index.html':
    'Continuous GTFS validation in GTFS·X: errors block export, warnings don\'t, inline jump-to-entity, summary panel. Aligned with MobilityData\'s validator.',
  'public/docs/import-and-export/index.html':
    'Import an existing GTFS ZIP into GTFS·X and export a standards-compliant ZIP. Round-trip preserves non-standard files and columns. 100 MB import limit.',
  'public/docs/service-summary/index.html':
    'Service Summary in GTFS·X: revenue hours, trip counts per route, peak vehicles, span of service. Sanity-check a feed and prep NTD reporting figures.',
  // Drop the inner quotes — they encode as &quot; (6 chars each) and push the
  // attribute value to 169 chars, over the 160-char crawler-visible cap.
  'public/docs/deep-links/index.html':
    'Open any GTFS feed in GTFS·X with a single URL. Add Edit-in-GTFS·X buttons to the Mobility Database, transit.land, the canonical GTFS validator, and more.',

  // Handoff table claimed 155 chars but actual JS length is 165/163 — trimmed
  // slightly to fit ≤160 while keeping the same lede and keyword phrasing.
  'public/learn/gtfs/index.html':
    'GTFS (General Transit Feed Specification) is the standard format for public transit schedules. Learn what it is, what files it has, who consumes it.',
  'public/learn/gtfs-flex/index.html':
    'GTFS-Flex extends GTFS to cover demand-responsive transit: microtransit, dial-a-ride, deviated fixed-route, and on-demand zones. What it adds and why.',
};

let changed = 0;
let skipped = 0;
let warned = 0;
for (const [rel, desc] of Object.entries(REPLACEMENTS)) {
  const file = resolve(root, rel);
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`MISSING: ${rel}`);
    warned++;
    continue;
  }
  const re = /<meta name="description" content="([^"]*)"\s*\/?>/;
  const m = html.match(re);
  if (!m) {
    console.warn(`NO MATCH: ${rel}`);
    warned++;
    continue;
  }
  if (m[1] === desc) {
    skipped++;
    continue; // already trimmed
  }
  if (desc.length > 160) {
    console.warn(`OVERSIZE (${desc.length}): ${rel}`);
    warned++;
    continue;
  }
  // The descriptions live inside content="..." — escape any literal double
  // quotes (e.g. the "Edit in GTFS·X" quoted phrase in /docs/deep-links/).
  const attr = desc.replace(/"/g, '&quot;');
  html = html.replace(re, `<meta name="description" content="${attr}" />`);
  writeFileSync(file, html);
  console.log(`updated [${desc.length}]: ${rel}`);
  changed++;
}
console.log(`\n${changed} changed · ${skipped} already trimmed · ${warned} warnings.`);
