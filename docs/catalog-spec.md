# GTFS-X open catalog — schema specification

**Schema version:** 0.2
**Canonical URL:** `https://feeds.gtfsx.com/catalog.json`
**Media type:** `application/json`
**Status:** production

This document specifies the machine-readable feed catalog that GTFS-X publishes
for aggregators — primarily the [Mobility Database](https://mobilitydatabase.org/)
(MobilityData) and [TransitLand](https://www.transit.land/) (Interline). It is
the reference for the `specification` field emitted in every catalog document.

## 1. Purpose

GTFS-X is a free, browser-based GTFS editor and hosting tool aimed at small and
rural transit agencies — the segment most likely to have no discoverable feed.
When an agency publishes in GTFS-X it gets a stable, public, no-auth feed URL at
`https://feeds.gtfsx.com/<slug>/gtfs.zip`.

This catalog exposes, as one document, every GTFS-X-hosted feed whose owner has
opted into public listing. It exists so aggregators can **pull** — scan the
catalog on their own cadence and ingest, update, or de-list feeds — rather than
GTFS-X **pushing** unsolicited writes into their systems. The pull model keeps
ingestion control and curation with the aggregator, and it self-heals: when a
feed is unpublished or its owner opts out, it disappears from the catalog on the
next scan, with no removal request to process.

Field names deliberately mirror MobilityData's `add_gtfs_schedule_source`
operation so that mapping a catalog entry onto a Mobility Database source is
direct.

## 2. Canonical URL and update semantics

The canonical, stable URL is:

```
https://feeds.gtfsx.com/catalog.json
```

`https://www.gtfsx.com/catalog.json` issues an HTTP 301 redirect to the
canonical URL; consumers should register and poll the canonical `feeds.` URL.

The document is regenerated on demand from live data on every request, so it
always reflects the current set of published, opted-in feeds — there is no build
step or lag between a feed changing and the catalog reflecting it. Responses
carry `Cache-Control: public, max-age=3600`, so a cached copy may be up to one
hour stale at the edge. `Access-Control-Allow-Origin: *` is set so browser-based
tooling and validators can fetch it cross-origin.

**Suggested cadence:** polling once every 24 hours is more than sufficient;
GTFS-X feeds change on the order of service changes, not minutes. Nothing breaks
if you poll more or less often.

An empty catalog (no feeds currently opted in) is a valid document with
`feed_count: 0` and `feeds: []` — never an error.

## 3. Top-level fields

| Field | Type | Required | Semantics |
|---|---|---|---|
| `specification` | string (URL) | yes | URL of this specification document. |
| `version` | string | yes | Schema version of this document (e.g. `"0.2"`). See the changelog (§8). |
| `description` | string | yes | Human-readable description of the catalog and its conventions. |
| `publisher` | object | yes | `{ "name": "GTFS-X", "url": "https://www.gtfsx.com" }`. |
| `generated_at` | string (ISO 8601, UTC) | yes | When this document was generated. |
| `feed_count` | integer | yes | Number of entries in `feeds` (equals `feeds.length`). |
| `feeds` | array | yes | The feed entries (§4). May be empty. |

## 4. Per-feed fields

Each entry in `feeds` describes one published, opted-in GTFS feed. Optional
fields are **omitted** when unknown — they are never present with a `null` or
empty value, so a consumer can treat presence as meaningful.

| Field | Type | Required | Semantics |
|---|---|---|---|
| `id` | string | yes | Stable GTFS-X feed identifier, `gtfsx:<slug>`. Stable for the life of the feed. |
| `provider` | string | yes | The transit provider / operator name (the feed's `feed_publisher_name`, falling back to the GTFS-X project name). |
| `name` | string | yes | The feed's display name in GTFS-X. |
| `is_official` | boolean | yes | Source authority, publisher-declared. `true` = official; `false` = community. See §5. |
| `direct_download_url` | string (URL) | yes | The canonical, public, no-auth GTFS ZIP: `https://feeds.gtfsx.com/<slug>/gtfs.zip`. Stable (§6). |
| `authentication_type` | integer | yes | Always `0` — every GTFS-X feed is public and unauthenticated. |
| `feed_updated_at` | string (ISO 8601, UTC) | yes | When the currently-published feed was published. |
| `gtfsx_feed_page` | string (URL) | yes | Public per-feed landing page: `https://feeds.gtfsx.com/<slug>`. |
| `mdb_source_id` | integer | no | The existing Mobility Database source id to **update** rather than duplicate (§7). Present only for the switcher case. |
| `supersedes_download_url` | string (URL) | no | A prior download URL this feed replaces, as a matching hint (§7). Reserved; not yet populated (§8). |
| `license_spdx_identifier` | string | no | SPDX short identifier of the feed's license (e.g. `CC-BY-4.0`). Omitted when the publisher hasn't declared one. |
| `license_url` | string (URL) | no | Canonical URL for `license_spdx_identifier`, when GTFS-X can map it. Omitted for unmapped or undeclared licenses. |
| `feed_contact_email` | string | no | `feed_contact_email` from the feed's `feed_info.txt`, when present. |
| `features` | string[] | no | Derivable GTFS spec features present in the feed (e.g. `["flex"]`). Omitted when none are detected (see §8 for coverage). |
| `bounding_box` | object | no | Geographic extent of the feed's stops: `{ minimum_latitude, minimum_longitude, maximum_latitude, maximum_longitude }`. Omitted when the feed has no usable stop coordinates. |

Note: administrative location fields (`country_code`, `subdivision_name`,
`municipality`) are **not** emitted in 0.2 — GTFS-X does not yet capture them.
Consumers that need them can geolocate from `bounding_box`. See §8.

## 5. Official vs community (`is_official`)

Every entry declares its source authority. The distinction is **self-declared by
the feed's owner at opt-in time** and is a required choice — GTFS-X does not
guess it:

- **Official** (`is_official: true`) — the feed is published by, or on explicit
  behalf of, the transit agency or authority that operates the service.
- **Community** (`is_official: false`) — the feed is created and maintained by a
  third party (a researcher, advocate, or partner) not affiliated with the
  operating agency.

**No silent default.** A GTFS-X feed appears in this catalog **only after** its
owner has affirmatively declared official or community. A feed with no
declaration is omitted entirely. Consequently `is_official: false` here is always
an affirmative "community" statement, never the absence of a declaration.

**Field-name choice.** We emit `is_official` (a boolean) rather than a separate
enum such as `publisher_type` specifically to align with the Mobility Database's
own `is_official` field, making ingestion a direct mapping. We diverge from the
Mobility Database convention in exactly one way, on purpose: MobilityData assumes
`is_official = false` when the value is absent, whereas GTFS-X never emits a feed
without an explicit declaration (see "No silent default" above). The value is
therefore authoritative in this catalog, not a fallback.

## 6. URL stability

`direct_download_url` and `gtfsx_feed_page` are stable for the life of the feed.
A feed's `<slug>` does not change, and the ZIP URL is content-negotiated to
always serve the latest published snapshot with strong `ETag` / `Last-Modified`
validators (so a consumer can cheaply detect "has this feed changed?" with a
conditional `GET`). Legacy pre-rebrand hostnames 301-redirect to the current
`feeds.gtfsx.com` host in a single hop, so already-registered URLs keep working.

## 7. Deduplication guidance for consumers

Because the same real-world feed can already exist in an aggregator (e.g. an
agency that moved its hosting to GTFS-X), consumers should dedup rather than
blindly create:

1. **`mdb_source_id` (definitive, when present).** If an entry carries
   `mdb_source_id`, it is the id of an existing Mobility Database source that
   this feed should **update** — repoint that source's download URL to
   `direct_download_url` instead of creating a new source. This is the "switcher"
   case: the agency was already catalogued and is now GTFS-X-hosted.
2. **`direct_download_url` (exact match).** The download URL is stable and unique
   per feed, so an exact match against a source's producer/download URL is a
   definitive same-source signal.
3. **`supersedes_download_url` (hint, when present).** When emitted, it names a
   prior download URL this feed replaces — use it to match against a source that
   still points at the old host, then repoint it.
4. **Fallback.** Absent the above, match on `provider` name plus
   `bounding_box`, and confirm with the publisher.

## 8. Coverage notes and roadmap

The following are defined in this schema but not yet populated in 0.2. They are
documented here so consumers can rely on their semantics when they appear:

- **`mdb_source_id` / `supersedes_download_url`.** The columns exist and are
  emitted when set. Automatic capture from the GTFS-X "import from Mobility
  Database" flow (which already fetches a feed by its Mobility Database id) is a
  planned addition; until then these are populated only when set out of band.
- **`features`.** 0.2 detects GTFS-Flex. Additional features (Fares v1/v2, etc.)
  are planned.
- **`country_code` / `subdivision_name` / `municipality`.** Not captured by
  GTFS-X today; consumers can geolocate from `bounding_box`.

## 9. Versioning and changelog

The schema is versioned in the top-level `version` field. Backward-compatible
additions (new optional fields) do not bump the major version; a consumer should
ignore unknown fields. Removing or repurposing a field bumps the version.

| Version | Notes |
|---|---|
| 0.1-draft | Static demo document (`feat/catalog-endpoint-demo`), sample data, for the initial MobilityData discussion. Used `specification: "gtfsx-open-catalog"`, a per-feed `license_url` only, and per-feed location fields (`country_code`, `subdivision_name`, `municipality`) that were never wired to real data. |
| **0.2** | First production schema. Dynamic, opt-in-driven. Adds `is_official` (official-vs-community, publisher-declared); `license_spdx_identifier` alongside `license_url`; a definition of the canonical URL and update/dedup semantics. `direct_download_url`, `mdb_source_id`, and `bounding_box` carried over from 0.1-draft. Location fields dropped pending real data. |
