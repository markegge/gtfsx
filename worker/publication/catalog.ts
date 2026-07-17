// GTFS-X open-catalog document (issue #47).
//
// Served at  GET https://feeds.gtfsx.com/catalog.json  (the canonical stable
// URL; www.gtfsx.com/catalog.json 301-redirects here — see worker/index.ts).
// Schema:    docs/catalog-spec.md  (versioned; this file emits `version` 0.2).
//
// The PULL half of getting GTFS-X-hosted feeds into the public catalogs. The
// original PUSH integration (worker/publication/submit.ts) is a dead end — the
// Mobility Database v1 API rejects third-party writes with HTTP 405 — so we
// instead expose one machine-readable list of every published, opted-in feed
// and let MobilityData (Mobility Database) and Interline (TransitLand) scan it
// on their own cadence. Ingestion control + curation stay with them, and it
// self-heals: unpublish or opt-out drops the feed on the next scan.
//
// Field names mirror MobilityData's `add_gtfs_schedule_source` operation so
// their ingestion is a direct mapping. Per-feed geography/metadata that would
// otherwise require reading each feed's snapshot state is persisted at publish
// time (publication.catalog_meta_json) so this document can be built from D1
// alone — it must never load N feed blobs per request.
//
// This builder is PURE (no env, no I/O) so the schema test can drive it
// directly and the route (worker/publication/feeds.ts serveCatalog) stays a
// thin D1 loader — the same split dmfr.ts uses.

/** The URL of the schema specification this document conforms to. */
export const CATALOG_SPEC_URL =
  'https://github.com/GTFS-X/gtfsx/blob/main/docs/catalog-spec.md';

/** Schema version emitted in the document (see docs/catalog-spec.md changelog). */
export const CATALOG_SCHEMA_VERSION = '0.2';

/**
 * The publisher-declared source authority. Stored internally as this enum
 * (feed_project.catalog_publisher_type) and emitted as MobilityData's own
 * boolean `is_official` — 'official' → true, 'community' → false. GTFS-X
 * requires an explicit choice: an undeclared feed is omitted from the catalog
 * entirely, so `is_official: false` here is always an affirmative "community"
 * statement, never MDB's assume-false-when-absent default.
 */
export type CatalogPublisherType = 'official' | 'community';

export interface CatalogBoundingBox {
  minimum_latitude: number;
  minimum_longitude: number;
  maximum_latitude: number;
  maximum_longitude: number;
}

/** Per-publish metadata persisted at publish time (publication.catalog_meta_json). */
export interface CatalogMeta {
  /** Geographic bounds of the published feed's stops. Null when no stop has usable coords. */
  bbox: CatalogBoundingBox | null;
  /** Derivable GTFS spec features present in the feed (e.g. 'flex'). */
  features: string[];
  /** feed_info.txt feed_publisher_name, when the feed declares one. */
  feedPublisherName: string | null;
  /** feed_info.txt feed_contact_email, when the feed declares one. */
  feedContactEmail: string | null;
}

/** One opted-in, published feed as projected out of D1 for the builder. */
export interface CatalogFeedInput {
  /** Canonical publication slug. */
  slug: string;
  /** feed_project.name — the project/feed title. */
  name: string;
  /** feed_project.description, when set. */
  description?: string | null;
  /** The publisher's official-vs-community declaration. */
  publisherType: CatalogPublisherType;
  /** SPDX short identifier (feed_project.license_spdx), e.g. 'CC-BY-4.0'. */
  licenseSpdx?: string | null;
  /** Mobility Database numeric source id, for the switcher/update path. */
  mdbSourceId?: number | null;
  /** publication.published_at (unix ms). */
  publishedAt: number;
  /** Parsed publication.catalog_meta_json, or null when not yet computed. */
  meta?: CatalogMeta | null;
}

export interface BuildCatalogInput {
  /** e.g. https://feeds.gtfsx.com (no trailing slash required). */
  feedsOrigin: string;
  /** When this document was generated (unix ms). */
  generatedAt: number;
  /** Opted-in, published feeds, already ordered. */
  feeds: CatalogFeedInput[];
}

export interface CatalogEntry {
  id: string;
  mdb_source_id?: number;
  supersedes_download_url?: string;
  provider: string;
  name: string;
  is_official: boolean;
  direct_download_url: string;
  authentication_type: 0;
  license_spdx_identifier?: string;
  license_url?: string;
  feed_contact_email?: string;
  features?: string[];
  bounding_box?: CatalogBoundingBox;
  feed_updated_at: string;
  gtfsx_feed_page: string;
}

export interface CatalogDocument {
  specification: string;
  version: string;
  description: string;
  publisher: { name: string; url: string };
  generated_at: string;
  feed_count: number;
  feeds: CatalogEntry[];
}

const PRODUCTION_DESCRIPTION =
  'The GTFS-X open feed catalog: every GTFS feed published on GTFS-X whose ' +
  'owner opted into public listing, regenerated whenever a feed is published, ' +
  'unpublished, or its listing changes. Field names mirror the Mobility ' +
  "Database's add_gtfs_schedule_source operation so ingestion is a direct " +
  'mapping. All GTFS-X feeds are public, so authentication_type is always 0. ' +
  'is_official is publisher-declared (official = published by or on behalf of ' +
  'the operating agency; community = maintained by a third party); a feed is ' +
  'listed only after its owner declares it, so a missing declaration means the ' +
  'feed is absent, never a silent default. mdb_source_id, when present, is the ' +
  'existing Mobility Database source to UPDATE rather than duplicate. See the ' +
  'specification for field semantics, dedup guidance, and the changelog.';

/**
 * SPDX short identifier → canonical license URL, for the small set of licenses
 * open transit data actually uses (the publish dialog offers CC0-1.0,
 * CC-BY-4.0, ODbL-1.0; the rest are common neighbours). Unknown identifiers
 * yield no license_url — we emit license_spdx_identifier alone rather than
 * guess a URL.
 */
const SPDX_LICENSE_URLS: Record<string, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/',
  'CC-BY-NC-4.0': 'https://creativecommons.org/licenses/by-nc/4.0/',
  'ODbL-1.0': 'https://opendatacommons.org/licenses/odbl/1-0/',
  'ODC-By-1.0': 'https://opendatacommons.org/licenses/by/1-0/',
  'PDDL-1.0': 'https://opendatacommons.org/licenses/pddl/1-0/',
};

/** Canonical URL for an SPDX license identifier, or null when unmapped. */
export function licenseUrlForSpdx(spdx: string | null | undefined): string | null {
  if (!spdx) return null;
  return SPDX_LICENSE_URLS[spdx] ?? null;
}

/**
 * Bounding box of a stop list — the geographic extent /catalog.json advertises.
 * Computed at publish time (see performPublish) so the route never loads feeds.
 * Null when no stop carries usable coordinates. Ignores the null island (0,0),
 * matching stopCentroid in dmfr.ts.
 */
export function stopBoundingBox(
  stops: Array<{ stop_lat?: unknown; stop_lon?: unknown }> | undefined,
): CatalogBoundingBox | null {
  if (!stops || stops.length === 0) return null;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  let n = 0;
  for (const s of stops) {
    const lat = typeof s.stop_lat === 'number' ? s.stop_lat : Number(s.stop_lat);
    const lon = typeof s.stop_lon === 'number' ? s.stop_lon : Number(s.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue; // null island — not a real stop location
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    n += 1;
  }
  if (n === 0) return null;
  return {
    minimum_latitude: minLat,
    minimum_longitude: minLon,
    maximum_latitude: maxLat,
    maximum_longitude: maxLon,
  };
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

/** Build one catalog entry from a queried feed. */
function buildEntry(origin: string, feed: CatalogFeedInput): CatalogEntry {
  const publisherName = trimmed(feed.meta?.feedPublisherName);
  const provider = publisherName ?? feed.name;
  const entry: CatalogEntry = {
    id: `gtfsx:${feed.slug}`,
    provider,
    name: feed.name,
    is_official: feed.publisherType === 'official',
    direct_download_url: `${origin}/${feed.slug}/gtfs.zip`,
    authentication_type: 0,
    feed_updated_at: new Date(feed.publishedAt).toISOString(),
    // The public per-feed mini-site lives on the feeds origin (a no-auth
    // landing page), not the auth-gated app editor route.
    gtfsx_feed_page: `${origin}/${feed.slug}`,
  };

  if (typeof feed.mdbSourceId === 'number' && Number.isFinite(feed.mdbSourceId)) {
    entry.mdb_source_id = feed.mdbSourceId;
  }

  const spdx = trimmed(feed.licenseSpdx);
  if (spdx) {
    entry.license_spdx_identifier = spdx;
    const url = licenseUrlForSpdx(spdx);
    if (url) entry.license_url = url;
  }

  const contactEmail = trimmed(feed.meta?.feedContactEmail);
  if (contactEmail) entry.feed_contact_email = contactEmail;

  const features = feed.meta?.features;
  if (Array.isArray(features) && features.length > 0) entry.features = features;

  const bbox = feed.meta?.bbox;
  if (bbox) entry.bounding_box = bbox;

  return entry;
}

/**
 * Build the open-catalog document. Pure — the route supplies already-queried
 * D1 rows.
 */
export function buildCatalogDocument(input: BuildCatalogInput): CatalogDocument {
  const origin = input.feedsOrigin.replace(/\/$/, '');
  const feeds = input.feeds.map((f) => buildEntry(origin, f));
  return {
    specification: CATALOG_SPEC_URL,
    version: CATALOG_SCHEMA_VERSION,
    description: PRODUCTION_DESCRIPTION,
    publisher: { name: 'GTFS-X', url: 'https://www.gtfsx.com' },
    generated_at: new Date(input.generatedAt).toISOString(),
    feed_count: feeds.length,
    feeds,
  };
}

/**
 * Derive the spec-feature tags we can cheaply detect from a parsed feed-state
 * blob at publish time. v0.2 detects GTFS-Flex (the editor models flex service
 * as `flexZones`); fares and other features are a documented follow-up. Kept
 * permissive about the state shape — it is user JSON.
 */
export function deriveCatalogFeatures(state: unknown): string[] {
  const features: string[] = [];
  if (state && typeof state === 'object') {
    const flexZones = (state as { flexZones?: unknown }).flexZones;
    if (Array.isArray(flexZones) && flexZones.length > 0) features.push('flex');
  }
  return features;
}

/**
 * The Mobility Database source id carried as import provenance inside a feed's
 * saved state (store field `mdbSourceId`, persisted with the snapshot). Returned
 * so performPublish can project it onto feed_project.mdb_source_id at publish
 * time — the same read-from-the-snapshot pattern as bbox/features. Only a
 * positive integer is a real source id; anything else (absent, null, 0,
 * negative, non-integer, string) yields null so we never stamp a bogus switcher
 * id. Kept permissive about the state shape — it is user JSON.
 */
export function deriveImportedMdbSourceId(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const raw = (state as { mdbSourceId?: unknown }).mdbSourceId;
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** Parse a persisted catalog_meta_json string into CatalogMeta, or null. */
export function parseCatalogMeta(json: string | null | undefined): CatalogMeta | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<CatalogMeta>;
    const bbox =
      parsed.bbox &&
      typeof parsed.bbox === 'object' &&
      Number.isFinite((parsed.bbox as CatalogBoundingBox).minimum_latitude)
        ? (parsed.bbox as CatalogBoundingBox)
        : null;
    return {
      bbox,
      features: Array.isArray(parsed.features)
        ? parsed.features.filter((f): f is string => typeof f === 'string')
        : [],
      feedPublisherName: typeof parsed.feedPublisherName === 'string' ? parsed.feedPublisherName : null,
      feedContactEmail: typeof parsed.feedContactEmail === 'string' ? parsed.feedContactEmail : null,
    };
  } catch {
    return null;
  }
}
