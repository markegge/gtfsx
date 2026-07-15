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
// The NTD ID lives on the AGENCY, inside the feed — `agency.external_id`, an
// optional custom column on agency.txt — so it arrives here inside the
// snapshotted feed state, per agency. We therefore emit ONE OPERATOR PER
// AGENCY, each carrying its own `tags.us_ntd_id` and its own
// `associated_feeds[].gtfs_agency_id`. (An earlier design carried a single
// project-level NTD ID and could not say which agency of a multi-agency feed
// was the reporter; that limitation is gone.)
//
// ── Judgment calls, because the schema is stricter than our data model ────────
//
// * `operator.onestop_id` is REQUIRED and is described as "the globally unique
//   Onestop ID for this operator" — a value only the registry can truly assign.
//   Rather than emit a placeholder, we DERIVE one following Transitland's own
//   documented convention (`o-<geohash>-<name>`), using a geohash of the
//   published feed's stop centroid and the agency's name. The feed's stop
//   centroid is the only geography we have (we do not model per-agency service
//   areas), so co-located agencies share the geohash component and are
//   distinguished by the name component. It is deterministic and defensible,
//   and Transitland reconciles it on ingest.
//
// * When the feed has no usable stop coordinates we cannot derive a geohash, so
//   we omit the `operators` container entirely (it is optional). The per-agency
//   NTD IDs then have nowhere to live, so we fall back to the feed's free-form
//   `tags.us_ntd_id` — but ONLY when exactly one agency in the feed declares an
//   external_id, since a feed-level tag cannot say which agency it belongs to.
//   With two or more IDs and no operators we omit them rather than assert an
//   ambiguous crosswalk (a feed with no stop coordinates is not publishable in
//   practice anyway).
//
// * `operator.associated_feeds[].gtfs_agency_id` is emitted whenever the agency
//   has an agency_id. The schema only *requires* it for multi-agency feeds, but
//   it is the honest, explicit statement of which agency each operator record
//   describes; the operator is nested under its feed, so `feed_onestop_id` is
//   not needed (the schema says so explicitly).
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

export interface DmfrAssociatedFeed {
  gtfs_agency_id?: string;
}

export interface DmfrOperator {
  onestop_id: string;
  name: string;
  website?: string;
  associated_feeds?: DmfrAssociatedFeed[];
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

/** One agency of the published feed, as projected out of the snapshot state. */
export interface DmfrAgencyInput {
  agency_id?: string | null;
  agency_name?: string | null;
  /**
   * The agency's NTD ID (agency.external_id). A STRING — NTD IDs carry
   * significant leading zeros ("00123"); never coerce it through Number().
   */
  external_id?: string | null;
}

export interface BuildDmfrInput {
  /** Canonical publication slug — also the DMFR feed id. */
  slug: string;
  /** e.g. https://feeds.gtfsx.com (no trailing slash required). */
  feedsOrigin: string;
  /** feed_publisher_name when the feed declares one, else the project name. */
  feedTitle: string;
  description?: string | null;
  /**
   * The feed's agencies, in agency.txt order — one DMFR operator each. Empty
   * (or absent) when the state blob is unreadable: we then fall back to a
   * single operator named after the feed itself.
   */
  agencies?: DmfrAgencyInput[];
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

/** Non-empty trimmed string, else null. Strings only — never Number()-coerced. */
function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
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
  const licenseSpdx = input.licenseSpdx?.trim() || null;

  const gtfsFeed: DmfrFeed = {
    id: input.slug,
    spec: 'gtfs',
    name: input.feedTitle,
    urls: { static_current: zipUrl },
  };
  if (input.description) gtfsFeed.description = input.description;
  if (licenseSpdx) gtfsFeed.license = { spdx_identifier: licenseSpdx };

  // ─── Operators: one per agency, each carrying its own NTD crosswalk ──────────
  //
  // The NTD ID is agency.external_id, inside the feed. Requires a derivable
  // Onestop ID (see the header note); with no stop centroid we omit `operators`
  // and fall back to a feed-level tag, but only when it is unambiguous.
  const centroid = input.centroid ?? null;
  const agencies = (input.agencies ?? []).map((a) => ({
    agencyId: trimmed(a.agency_id),
    agencyName: trimmed(a.agency_name),
    externalId: trimmed(a.external_id),
  }));

  if (centroid) {
    const geo = geohash(centroid.lat, centroid.lon, 4);
    const operators: DmfrOperator[] = [];
    for (const agency of agencies) {
      // `name` is REQUIRED by the schema — fall back to the agency_id, then to
      // the feed title, so an agency with a blank name still gets an operator.
      const name = agency.agencyName ?? agency.agencyId ?? input.feedTitle;
      const nameComponent = onestopNameComponent(name) || onestopNameComponent(input.slug);
      if (!nameComponent) continue;
      const operator: DmfrOperator = {
        onestop_id: `o-${geo}-${nameComponent}`,
        name,
      };
      if (agency.agencyId) operator.associated_feeds = [{ gtfs_agency_id: agency.agencyId }];
      if (agency.externalId) operator.tags = { us_ntd_id: agency.externalId };
      operators.push(operator);
    }

    // No agencies in the state blob (unreadable / empty feed) — keep emitting a
    // single operator for the feed itself rather than dropping the container.
    if (operators.length === 0) {
      const nameComponent = onestopNameComponent(input.feedTitle) || onestopNameComponent(input.slug);
      if (nameComponent) {
        operators.push({ onestop_id: `o-${geo}-${nameComponent}`, name: input.feedTitle });
      }
    }
    if (operators.length > 0) gtfsFeed.operators = operators;
  }

  if (!gtfsFeed.operators) {
    // No operators container → the per-agency IDs have nowhere to live. A
    // feed-level tag can't say WHICH agency it describes, so only emit it when
    // exactly one agency declares an external_id.
    const externalIds = agencies.map((a) => a.externalId).filter((v): v is string => !!v);
    if (externalIds.length === 1) gtfsFeed.tags = { us_ntd_id: externalIds[0] };
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
