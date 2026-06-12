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
      "city": "City Name or null",
      "reporterType": "full | reduced | rural",
      "status": "ok | expired | invalid | none",
      "feedUrl": "https://... or null",
      "lastValidated": "YYYY-MM-DD or null"
    }
  ]
}
```

### Field definitions

| Field | Type | Notes |
|---|---|---|
| `asOf` | `YYYY-MM-DD` | Date this snapshot was produced |
| `name` | string | Agency name from the NTD roster |
| `ntdId` | string | NTD reporter ID |
| `city` | string or null | City/locality; null if not available |
| `reporterType` | `"full"` \| `"reduced"` \| `"rural"` | NTD reporting class |
| `status` | `"ok"` \| `"expired"` \| `"invalid"` \| `"none"` | Feed health status (see below) |
| `feedUrl` | string or null | Canonical GTFS feed URL; null when status is `"none"` |
| `lastValidated` | `YYYY-MM-DD` or null | Date the canonical validator last ran against this feed |

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
