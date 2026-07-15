# Feed Health Dashboard — Per-State Agency Data

## Schema

Per-state agency files live at:

```
public/feed-health/data/agencies/<ABBR>.json
```

where `<ABBR>` is the two-letter state abbreviation (e.g. `CA.json`, `TX.json`).

### File shape

```json
{
  "asOf": "YYYY-MM-DD",
  "agencies": [
    {
      "name": "Agency Name",
      "ntdId": "12345",
      "mdbId": "mdb-223 or null",
      "city": "City Name or null",
      "reporterType": "full | reduced | rural",
      "status": "ok | expired | invalid | none",
      "feedUrl": "https://... or null",
      "lastValidated": "YYYY-MM-DD or null",
      "orgType": "NTD organization_type string or null",
      "modes": "Descriptive modes string or null",
      "fixedRoute": false,
      "demandResponse": false,
      "isFlex": false,
      "serviceEnd": "YYYY-MM-DD or null",
      "lastFeedUpdate": "YYYY-MM-DD or null",
      "expired": false
    }
  ]
}
```

### Field definitions

| Field | Type | Notes |
|---|---|---|
| `asOf` | `YYYY-MM-DD` | Date this snapshot was produced |
| `name` | string | Agency name from the NTD roster |
| `ntdId` | string | NTD reporter ID. **Always a string** — NTD IDs carry significant leading zeros (`"00041"`); never parse one as a number |
| `mdbId` | string or null | Mobility Database feed ID of the matched feed (`"mdb-223"`, `"tld-4791"`, `"ntd-41"`); null when no MDB feed is matched to this agency (~37% matched). With `ntdId` this is the NTD↔MDB crosswalk — the two identifiers FTA's P-50 form asks for. Also a string; never coerce to a number |
| `city` | string or null | City/locality; null if not available |
| `reporterType` | `"full"` \| `"reduced"` \| `"rural"` | NTD reporting class |
| `status` | `"ok"` \| `"expired"` \| `"invalid"` \| `"none"` | Feed health status (see below) |
| `feedUrl` | string or null | Canonical GTFS feed URL; null when status is `"none"` |
| `lastValidated` | `YYYY-MM-DD` or null | Date the canonical validator last ran against this feed |
| `orgType` | string or null | NTD `organization_type` (e.g. "Independent Public Agency or Authority of Transit Service"); ~100% coverage. Shortened to a friendly label in the UI |
| `modes` | string or null | Descriptive modes served, from the FTA GTFS Weblinks crosswalk (`weblink_modes`, e.g. "Bus, Ferryboat, Streetcar Rail"); null when no weblink is on file (~55% coverage). Absence means unknown, not "no service" |
| `fixedRoute` | boolean | True when the agency reports a scheduled fixed-route mode to NTD (Service-by-Mode `wwdp-t4re`: any mode other than demand-response or vanpool). Full-roster coverage. An agency can be both `fixedRoute` and `demandResponse`; `false` for both means no NTD mode record (e.g. vanpool-only), not "no service" |
| `demandResponse` | boolean | True when the agency reports a demand-response mode to NTD (modes `DR` / `DT`). See `fixedRoute` — the two are independent, not exclusive |
| `isFlex` | boolean | True when the matched Mobility Database feed publishes GTFS-Flex (`mdb_is_flex`); rare |
| `serviceEnd` | `YYYY-MM-DD` or null | Date the matched MDB feed's service window ends (date portion of MDB `service_end`); null when unmatched (~35% coverage) |
| `lastFeedUpdate` | `YYYY-MM-DD` or null | Date the Mobility Database last captured the matched feed's newest dataset (MDB `downloaded_at`, falling back to the timestamp embedded in the hosted dataset URL) — a proxy for "feed last published". Distinct from `serviceEnd`, which is the end of the service *period*. Null when the agency has no matched feed, and suppressed when `status == "none"` |
| `expired` | boolean | True when the feed's service period has already ended (`mdb_expired`); mirrors `status == "expired"` |

### Status semantics

| Value | Meaning |
|---|---|
| `ok` | Feed is findable, calendar dates describe current/future service, and it passes the canonical MobilityData validator |
| `expired` | Feed is findable but `calendar.txt` / `calendar_dates.txt` describe service that has already ended |
| `invalid` | Feed is findable but fails the canonical MobilityData validator with ERROR-severity issues |
| `none` | No findable GTFS feed — not in the FTA GTFS Weblinks crosswalk or the Mobility Database |

---

## Demo mode

To preview the agency table UI before real per-state data is available, append `?demo-agencies=1` to any Feed Health Dashboard URL:

```
https://staging.gtfsx.com/feed-health/?demo-agencies=1
```

With this query param every state drill-down loads `data/agencies/_SAMPLE.json` instead of the real state file. The sample file (`_SAMPLE.json`) contains clearly fake agency names (e.g. "Example Metro Transit", "Fictitious Regional Rail") — it is not real data and must never be renamed to a real state abbreviation.

---

## Adding real state files

Drop a file at `public/feed-health/data/agencies/<ABBR>.json` (e.g. `CA.json`) conforming to the schema above. The dashboard lazy-fetches it when the user opens that state's drill-down and renders the agency table automatically. States without a file continue to show the placeholder text.
