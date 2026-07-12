// DMFR (Distributed Mobility Feed Registry) document for a published feed.
//
// Served at  GET https://feeds.gtfsx.com/<slug>/dmfr.json
// Schema:    https://dmfr.transit.land/json-schema/dmfr.schema-v0.5.1.json
//            (vendored verbatim at worker/__tests__/fixtures/dmfr.schema-v0.5.1.json
//             and asserted against in worker/__tests__/publication.ntd.test.ts)
//
// Why: FTA proposed forcing agency_id == NTD ID, withdrew it (July 2025), and
// now crosswalks feeds → NTD IDs itself via the enhanced P-50 form. Emitting a
// valid DMFR document means a publisher can hand one URL to Transitland / the
// Mobility Database and land in their pipelines with the NTD crosswalk already
// attached (`operators[].tags.us_ntd_id`, the tag transitland-atlas uses).
//
// ── Judgment calls, because the schema is stricter than our data model ────────
//
// * `operator.onestop_id` is REQUIRED and is described as "the globally unique
//   Onestop ID for this operator" — a value only the registry can truly assign.
//   Rather than emit a placeholder, we DERIVE one following Transitland's own
//   documented convention (`o-<geohash>-<name>`), using a geohash of the
//   published feed's stop centroid and the publisher name. It is deterministic
//   and defensible, and Transitland reconciles it on ingest. When the feed has
//   no stop coordinates we cannot derive a geohash, so we omit the `operators`
//   container entirely (it is optional) and fall back to carrying the NTD ID on
//   the feed's free-form `tags` — the crosswalk survives either way.
//
// * We deliberately do NOT emit `operator.associated_feeds[].gtfs_agency_id`.
//   The schema only needs it for multi-agency feeds, and we do not model WHICH
//   agency in a multi-agency feed is the NTD reporting agency (the same gap the
//   P-50 helper states plainly in the UI). Asserting a mapping we can't back up
//   would be worse than leaving it for the registry maintainer; single-agency
//   feeds are auto-detected by Transitland anyway.
//
// * `feed.id` is "internal to this DMFR instance. (Optionally can be a Onestop
//   ID.)" — so we use the stable canonical slug (`<slug>`, `<slug>-rt`) rather
//   than minting a Onestop ID that could drift if the feed's geography moves.

export type RtKind = 'vehicle_positions' | 'trip_updates' | 'alerts';

/** kind → the DMFR `urls` field for that GTFS-Realtime message type. */
const RT_URL_FIELD: Record<RtKind, 'realtime_vehicle_positions' | 'realtime_trip_updates' | 'realtime_alerts'> = {
  vehicle_positions: 'realtime_vehicle_positions',
  trip_updates: 'realtime_trip_updates',
  alerts: 'realtime_alerts',
};

export interface DmfrOperator {
  onestop_id: string;
  name: string;
  website?: string;
  tags?: Record<string, string>;
}

export interface DmfrFeed {
  id: string;
  spec: 'gtfs' | 'gtfs-rt';
  name?: string;
  description?: string;
  urls: Record<string, string>;
  license?: { spdx_identifier: string };
  operators?: DmfrOperator[];
  tags?: Record<string, string>;
}

export interface DmfrDocument {
  $schema: string;
  license_spdx_identifier?: string;
  feeds: DmfrFeed[];
}

export interface BuildDmfrInput {
  /** Canonical publication slug — also the DMFR feed id. */
  slug: string;
  /** e.g. https://feeds.gtfsx.com (no trailing slash required). */
  feedsOrigin: string;
  /** feed_publisher_name when the feed declares one, else the project name. */
  feedTitle: string;
  description?: string | null;
  /** 5-digit NTD ID string — leading zeros are significant, never a number. */
  ntdId?: string | null;
  /** SPDX short identifier, e.g. 'CC-BY-4.0'. */
  licenseSpdx?: string | null;
  rtFeeds?: Array<{ kind: string; url: string }>;
  /** Centroid of the feed's stops, used only to derive the Onestop geohash. */
  centroid?: { lat: number; lon: number } | null;
}

const SCHEMA_URL = 'https://dmfr.transit.land/json-schema/dmfr.schema-v0.5.1.json';

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash encoder (base-32), used for the Onestop ID's geohash component. */
export function geohash(lat: number, lon: number, precision = 4): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = '';
  let bits = 0;
  let bitCount = 0;
  let evenBit = true;
  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        bits = (bits << 1) | 1;
        lonMin = mid;
      } else {
        bits = bits << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        latMin = mid;
      } else {
        bits = bits << 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    bitCount += 1;
    if (bitCount === 5) {
      hash += GEOHASH_BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }
  return hash;
}

/**
 * The `name` component of a Onestop ID: lowercase alphanumerics only (the
 * spec reserves `-` as the component separator).
 */
export function onestopNameComponent(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
}

/** Centroid of a stop list. Null when no stop carries usable coordinates. */
export function stopCentroid(
  stops: Array<{ stop_lat?: unknown; stop_lon?: unknown }> | undefined,
): { lat: number; lon: number } | null {
  if (!stops || stops.length === 0) return null;
  let sumLat = 0;
  let sumLon = 0;
  let n = 0;
  for (const s of stops) {
    const lat = typeof s.stop_lat === 'number' ? s.stop_lat : Number(s.stop_lat);
    const lon = typeof s.stop_lon === 'number' ? s.stop_lon : Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue; // null island — not a real stop location
    sumLat += lat;
    sumLon += lon;
    n += 1;
  }
  if (n === 0) return null;
  return { lat: sumLat / n, lon: sumLon / n };
}

/**
 * Build the DMFR v0.5.1 document. Pure — no env, no I/O — so the schema test
 * can drive it directly and the route can stay a thin loader.
 */
export function buildDmfrDocument(input: BuildDmfrInput): DmfrDocument {
  const origin = input.feedsOrigin.replace(/\/$/, '');
  const zipUrl = `${origin}/${input.slug}/gtfs.zip`;
  const ntdId = input.ntdId?.trim() || null;
  const licenseSpdx = input.licenseSpdx?.trim() || null;

  const gtfsFeed: DmfrFeed = {
    id: input.slug,
    spec: 'gtfs',
    name: input.feedTitle,
    urls: { static_current: zipUrl },
  };
  if (input.description) gtfsFeed.description = input.description;
  if (licenseSpdx) gtfsFeed.license = { spdx_identifier: licenseSpdx };

  // Operator record — the carrier of the NTD crosswalk. Requires a derivable
  // Onestop ID (see the header note); otherwise fall back to feed-level tags.
  const nameComponent = onestopNameComponent(input.feedTitle) || onestopNameComponent(input.slug);
  const centroid = input.centroid ?? null;
  if (centroid && nameComponent) {
    const operator: DmfrOperator = {
      onestop_id: `o-${geohash(centroid.lat, centroid.lon, 4)}-${nameComponent}`,
      name: input.feedTitle,
    };
    if (ntdId) operator.tags = { us_ntd_id: ntdId };
    gtfsFeed.operators = [operator];
  } else if (ntdId) {
    gtfsFeed.tags = { us_ntd_id: ntdId };
  }

  const feeds: DmfrFeed[] = [gtfsFeed];

  // Companion GTFS-Realtime entry, one `urls` field per registered RT message
  // type. Omitted entirely when the project has no RT feeds — a feed record
  // with an empty `urls` would be noise in the registry.
  const rtUrls: Record<string, string> = {};
  for (const rt of input.rtFeeds ?? []) {
    const field = RT_URL_FIELD[rt.kind as RtKind];
    if (field && rt.url) rtUrls[field] = rt.url;
  }
  if (Object.keys(rtUrls).length > 0) {
    const rtFeed: DmfrFeed = {
      id: `${input.slug}-rt`,
      spec: 'gtfs-rt',
      name: `${input.feedTitle} (GTFS-Realtime)`,
      urls: rtUrls,
    };
    if (licenseSpdx) rtFeed.license = { spdx_identifier: licenseSpdx };
    feeds.push(rtFeed);
  }

  const doc: DmfrDocument = { $schema: SCHEMA_URL, feeds };
  if (licenseSpdx) doc.license_spdx_identifier = licenseSpdx;
  return doc;
}
