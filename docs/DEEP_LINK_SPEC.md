# GTFS Builder — Deep-Link Import Spec

*Handoff doc for Claude Code, May 2026*
*Owner: Mark Egge (Vector & Vertex)*

This doc specifies a URL-based deep-link import feature for GTFS Builder. Goal: any third-party tool (Mobility Database, transit.land, Canonical GTFS Validator, blogs, cold emails) can construct a URL that opens any GTFS feed in GTFS Builder, ready to edit, with a single click.

Before implementing, read the existing GTFS Builder codebase to understand the current feed-import flow, tech stack, and conventions. Match existing patterns. This doc specifies *what* the feature should do, not *how* to structure the implementation against an unknown codebase.

---

## 1. Goal

A user clicks a link like `https://gtfsbuilder.net/import?url=https://example.org/gtfs.zip` and lands in the editor with that feed loaded, validated, and ready to edit. No download step, no file upload step, no manual configuration. Catalog-aware variants do the same but resolve the feed URL from a catalog ID first.

The deep-link endpoint must be reliable enough for external partners (Mobility Database, transit.land, the Canonical GTFS Validator) to surface as an "Edit in GTFS Builder" button on their own UIs.

---

## 2. URL spec

### 2.1 Generic URL-based import

```
https://gtfsbuilder.net/import?url=<URL-encoded feed URL>
```

- `url` (required): a publicly-accessible URL pointing to a GTFS Schedule `.zip` archive
- Behavior: server fetches the feed, validates it parses as a ZIP containing GTFS-required files, stages it for the editor session, and routes the user into the editor with the feed loaded

### 2.2 Catalog-aware import — Mobility Database

```
https://gtfsbuilder.net/import?source=mobilitydb&feed_id=<MDB feed ID>
```

- `source=mobilitydb`
- `feed_id`: the Mobility Database feed identifier (e.g., `mdb-1234`)
- Behavior: server calls the Mobility Database API ([SwaggerUI docs](https://mobilitydata.github.io/mobility-feed-api/SwaggerUI/index.html)) to resolve `feed_id` → current feed URL, then proceeds as in 2.1
- If MD API requires authentication, store credentials server-side (env var). Do not expose to client.

### 2.3 Catalog-aware import — transit.land

```
https://gtfsbuilder.net/import?source=transitland&onestop_id=<Onestop ID>
```

- `source=transitland`
- `onestop_id`: the transit.land Onestop ID (e.g., `o-9q9-bart`, or feed Onestop ID like `f-9q9-bart`)
- Behavior: server calls the transit.land API to resolve to current feed URL, then proceeds as in 2.1
- transit.land API requires an API key. Store server-side.

### 2.4 Optional parameters (all variants)

- `ref=<string>`: attribution tag for analytics, e.g. `ref=mobilitydb`, `ref=cold_email_2026_05`. Recorded in import analytics; no behavioral effect.
- `return_url=<URL>`: post-publish redirect target. Validate against an allowlist before honoring (must be HTTPS, must be a known partner domain). Reject otherwise.

### 2.5 Error handling

The `/import` route must handle every failure mode gracefully with a user-facing message and a path forward (not a stack trace):

| Failure | Message | Path forward |
|---|---|---|
| `url` parameter missing or malformed | "We need a GTFS feed URL to import." | Link to upload flow |
| Fetch timed out (>30s) | "Couldn't reach the feed at [URL]." | Retry / paste new URL / upload manually |
| Fetch returned non-200 | "The feed URL returned [code]." | Same as above |
| Response not a valid ZIP | "That URL didn't return a GTFS zip file." | Upload manually |
| ZIP doesn't contain GTFS required files | "We got a ZIP but it doesn't look like GTFS." | Validation details + upload manually |
| Catalog ID not found | "We couldn't find feed [ID] in [catalog]." | Browse catalog / paste URL directly |
| Catalog API unavailable | "[Catalog] is currently unreachable. You can paste the feed URL directly instead." | Manual URL entry |
| File exceeds size limit | "This feed is larger than our import limit ([N] MB)." | Contact support / upload split feed |

---

## 3. Backend requirements

### 3.1 Server-side fetch endpoint

Implement (or extend) a server endpoint that takes a URL and returns a staged feed reference. Do not fetch feed URLs from the browser — CORS will block most third-party hosts, and client-side fetch is exposed to SSRF-via-redirect risk.

Endpoint sketch (adapt to existing API conventions):
- Accepts: `url` (or `source` + catalog ID)
- Returns: opaque session reference the editor can pull from

### 3.2 Security checklist (mandatory)

This endpoint is a public, unauthenticated URL fetcher. Treat it as a security-critical surface.

- **SSRF protection.** Resolve the hostname before fetching. Block private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, IPv6 equivalents), `localhost`, and any cloud metadata endpoints (`169.254.169.254`).
- **Redirect handling.** Follow redirects, but apply SSRF checks at each hop. Cap redirect depth at 5.
- **Size limit.** Reject responses larger than 100 MB. Enforce via streaming download with byte counter, not just `Content-Length` header (which can lie).
- **Timeout.** 30-second total budget for fetch + parse.
- **Content-Type check.** Accept `application/zip`, `application/octet-stream`, and reject obviously-wrong types like `text/html` early. Fall back to magic-byte sniffing — `Content-Type` is not authoritative.
- **ZIP bomb defense.** Limit uncompressed size to a reasonable cap (e.g., 500 MB) and limit per-file decompression rate.
- **No HTML rendering of feed content.** Fields like `feed_info.feed_contact_url`, `agency.agency_url`, `routes.route_url` are user-supplied and may contain malicious URLs or script. Treat as untrusted strings throughout. Never `dangerouslySetInnerHTML` or equivalent.
- **Rate limiting.** Per-IP rate limit on the import endpoint to prevent abuse as a free URL fetcher proxy.
- **Logging.** Log fetched URLs and source attribution for abuse review. Do not log fetched content.

### 3.3 Catalog API integration

For `source=mobilitydb` and `source=transitland`:
- Store API keys / credentials server-side (env vars or secrets manager). Never expose to client.
- Apply a short timeout (10s) on the catalog lookup step. If lookup times out, surface the "[Catalog] is currently unreachable" error path.
- Cache resolved feed URLs for a short TTL (e.g., 5 minutes) keyed by catalog ID, to avoid hammering catalog APIs on repeated clicks.

### 3.4 Analytics

Track each successful and failed import with: `source` (or `direct` for URL-only), `ref` parameter if present, success/failure, error class, timestamp. Aggregate counts feed into product analytics and into the gtfsfeeds.net dashboard once that exists.

---

## 4. Frontend requirements

### 4.1 `/import` route

When the route loads:

1. Parse URL parameters, show a "Loading feed from [URL or catalog ID]..." state immediately
2. Call the backend import endpoint
3. On success: route into the editor with the feed loaded
4. On error: show the error message from §2.5 with the path-forward CTA

### 4.2 First-time visitor experience

A deep-link is often a user's first contact with GTFS Builder. The import experience must work without an account (assuming the free tier permits anonymous editing per the business plan):

- Don't gate import behind sign-up
- Surface "Save your work — create a free account" prompts after the user has engaged with the editor, not before they've seen it
- Track conversion: deep-link clicks → editor sessions → account signups

### 4.3 Attribution display

If `ref` is present and matches a known partner (e.g., `mobilitydb`, `transitland`, `gtfs_validator`), show a small "Loaded from [partner name]" badge in the editor header. This is for trust ("yes, this is the same feed you saw on Mobility Database") and for partner goodwill.

---

## 5. User-facing documentation

### 5.1 Documentation page

Create a public docs page at `gtfsbuilder.net/docs/deep-links` (or wherever the existing docs structure puts integration pages). Audience: developers and ecosystem partners considering adding an "Edit in GTFS Builder" button.

Content outline:

1. **What it is.** A URL pattern that opens any GTFS feed in GTFS Builder ready to edit.
2. **Quick start.** Three copy-paste examples — one URL-based, one Mobility Database, one transit.land — with rendered button HTML snippets.
3. **URL parameters reference.** Table of all supported parameters, descriptions, examples.
4. **Catalog support.** Section for each catalog (MobilityData, transit.land), with link to the catalog and explanation of which ID to use.
5. **Button snippets.** Pre-styled HTML/CSS snippets partners can copy and paste. At minimum a text link version and a logo-button version. Provide an SVG of the GTFS Builder logo for partners to use.
6. **Errors and edge cases.** What happens when a feed is unreachable / oversized / not GTFS. So partners can set user expectations.
7. **Rate limits and reliability.** Document the rate limit and target uptime. Partners need to know what to expect.
8. **Contact.** How to reach Mark / Vector & Vertex for partnership conversations.

### 5.2 Linking from existing docs and homepage

- Add a "For ecosystem partners" or "Integrations" link in the site footer pointing to the deep-link docs
- Mention deep-links in any existing "Importing a feed" docs page
- Consider a homepage callout once the spec has at least one external integration live

### 5.3 Marketing-side asset

Generate a small partner badge / button generator (optional, ship in v1.1 if v1 timeline is tight):

- User pastes a feed URL or catalog ID
- Page outputs HTML/Markdown snippet they can paste into their site
- Shows live preview of what the button will look like

---

## 6. Acceptance criteria

The feature is ready to ship when:

1. `gtfsbuilder.net/import?url=<valid_feed_url>` opens the editor with the feed loaded, for at least 10 real-world feeds spanning small/medium/large agencies and including at least one GTFS-Flex feed
2. `gtfsbuilder.net/import?source=mobilitydb&feed_id=<id>` works for at least 5 sample MDB feed IDs
3. `gtfsbuilder.net/import?source=transitland&onestop_id=<id>` works for at least 5 sample Onestop IDs
4. Every error case in §2.5 has been manually tested and produces a usable user-facing message
5. SSRF test suite passes: requests to `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, and a redirect chain ending at a private IP are all rejected
6. Size limit enforced: a 200 MB ZIP is rejected with the size-limit error
7. Rate limit in place and tested
8. `/docs/deep-links` page is live and includes working copy-paste examples
9. Footer link to deep-link docs is in place
10. Basic analytics events fire and are visible in the product analytics dashboard

---

## 7. Out of scope (future work)

- A hosted button-generator UI (§5.3) — ship in v1.1 if v1 timeline is tight
- Catalog-aware deep links for catalogs beyond MobilityData and transit.land
- Deep-link variant for opening a specific *route* or *stop* within an already-loaded feed (e.g., `?focus=route_id:123`) — useful later for validator integration but not in v1
- "Save back to catalog" round-trip (publish edited feed back to the catalog the deep-link came from) — much more complex, requires catalog write APIs that may not exist
- Webhook callbacks to partner catalogs when an edited feed is published

---

## 8. Notes for Claude Code

- The existing GTFS Builder codebase is the source of truth for tech stack, conventions, auth model, and how feeds are currently imported. Read it first before deciding on implementation approach.
- The free tier per the business plan permits anonymous editing — don't add an authentication gate to the deep-link flow.
- The Mobility Database API requires registration; check whether Mark has credentials already, or request that he obtain them before implementation. Same for transit.land.
- Keep the security checklist in §3.2 as a self-review gate before considering the feature ready.
- Mark's preference is for terse implementations that match existing patterns over architectural rewrites. If the existing import flow can be extended rather than replaced, prefer that.
