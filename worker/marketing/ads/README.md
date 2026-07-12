# Google Ads Offline Conversion Import (OCI)

Server-side conversion uploader that pushes gclid-stamped events from the
`event` table (`feed_exported`, `paywall_view`, `demo_request`) to Google Ads
via the
[uploadClickConversions](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks)
endpoint. Cookieless replacement for the standard `gtag.js` conversion pixel.

Code: `worker/marketing/ads/oci.ts`. Cron: `0 9 * * *` (09:00 UTC ≈ 03:00 MT)
in `wrangler.jsonc`. Status page: `/api/admin/events/oci-status`.

---

## One-time setup — complete (kept as a runbook)

All secrets and conversion actions below exist in prod as of 2026-07-12.
Until every secret below is set in Cloudflare, the uploader logs
`[oci] skipped — env not configured` and exits cleanly. So the cron is
safe to ship before secrets exist; it just won't do anything.

### 1. Google Ads developer token

1. Visit https://ads.google.com/aw/apicenter under `mark@eateggs.com`.
2. Apply for a developer token. Test-level may auto-approve; basic-level
   needs Google review (1–3 business days).
3. Copy the token string.

### 2. Google Cloud project + OAuth client

1. Create a project at https://console.cloud.google.com (e.g. `gtfsx-ads-oci`).
2. Enable the **Google Ads API** in APIs & Services → Library.
3. APIs & Services → Credentials → Create OAuth 2.0 Client ID:
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:8080`
4. Note the **Client ID** and **Client secret**.

### 3. Obtain the long-lived refresh token (one-time, local)

Run this snippet on your laptop. It launches a one-time browser flow that
grants the Google Ads API scope, then prints the refresh token to stdout.

```bash
# scripts/oci-bootstrap.sh — not in the repo; paste into a scratch file.
python3 <<'EOF'
import http.server, socketserver, urllib.parse, webbrowser, json, urllib.request

CLIENT_ID = "PASTE_CLIENT_ID_HERE.apps.googleusercontent.com"
CLIENT_SECRET = "PASTE_CLIENT_SECRET_HERE"
SCOPE = "https://www.googleapis.com/auth/adwords"
PORT = 8080
REDIRECT = f"http://localhost:{PORT}"

auth_url = (
    "https://accounts.google.com/o/oauth2/v2/auth"
    f"?client_id={CLIENT_ID}&redirect_uri={REDIRECT}&response_type=code"
    f"&scope={SCOPE}&access_type=offline&prompt=consent"
)

print("Open this URL in your browser, approve the GTFS·X Google Ads API access, then return here:")
print(auth_url)
webbrowser.open(auth_url)

code_holder = {}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.urlparse(self.path).query
        code_holder["code"] = urllib.parse.parse_qs(q).get("code", [None])[0]
        self.send_response(200); self.end_headers()
        self.wfile.write(b"OK — return to terminal.")
    def log_message(self, *a): pass

with socketserver.TCPServer(("", PORT), H) as srv:
    while "code" not in code_holder:
        srv.handle_request()

req = urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code_holder["code"],
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }).encode(),
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)
print(json.dumps(json.loads(urllib.request.urlopen(req).read()), indent=2))
EOF
```

The printed JSON includes `refresh_token` — save it somewhere safe. It
does not expire unless you revoke it manually.

### 4. Conversion action IDs

Three conversion actions map to the three uploaded event kinds:

| Name | Category | Event kind | Status |
|---|---|---|---|
| `feed_exported` | Converted lead | `feed_exported` | exists (created 2026-05-26) |
| `paywall_view` | Qualified lead | `paywall_view` | exists (created 2026-05-26) |
| `demo_request` | Book appointment | `demo_request` (GET `/book-demo`) | exists (created 2026-07-12, ctId 7682006138) |

Get each ID by: Goals → Summary → click the action → look at the URL,
which contains `&ctId=NNNNNNNNNNN`. That number is the conversion action ID.

#### Creating the `demo_request` conversion action (one-time, Ads UI)

**Done 2026-07-12** (ctId 7682006138; secret set on prod). Steps kept below
for reference if the action ever needs to be recreated.

1. In Google Ads (`mark@eateggs.com`): **Goals → Conversions → Summary →
   "+ New conversion action"**.
2. Choose **Import** → **CRMs, files, or other data sources** →
   **Track conversions from clicks** → Continue. (This is the same import
   type as the two existing actions — the uploader sends the click's gclid,
   not a website tag.)
3. Settings:
   - **Goal and action optimization:** Book appointment (or Submit lead
     form — any lead-type category works; the name is what matters for
     humans, the numeric ID is what the uploader uses).
   - **Conversion name:** `demo_request` — keep it identical to the event
     kind so the Ads UI, the admin status page, and the D1 rows all speak
     the same name.
   - **Value:** *Don't use a value.* (The uploader deliberately omits
     `conversion_value`; a value here would flip the action to value-based
     mode.)
   - **Count:** One. (A visitor who clicks the booking link twice is still
     one demo request.)
   - **Click-through conversion window:** 90 days (matches the uploader's
     gclid TTL).
4. Save, then fetch the numeric ID: Goals → Summary → click `demo_request`
   → copy the `&ctId=NNNNNNNNNNN` number from the URL.
5. Store it (prod, and staging if desired):

   ```bash
   wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST   # numeric ID
   ```

**If this secret is ever unset, `demo_request` uploads go OFF but everything
else keeps working**: unlike the two original action IDs, this one is
optional in `readOciConfig`, so the live `feed_exported`/`paywall_view`
uploads are unaffected. Pending `demo_request` rows accumulate (visible on
`/api/admin/events/oci-status`, which shows a yellow note while the secret
is missing) and upload on the first cron run after it's set — rows older
than 90 days are expired, same as the other kinds.

### 5. Store everything as Worker secrets

```bash
# Prod (gtfs-builder)
wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
wrangler secret put GOOGLE_ADS_CLIENT_ID
wrangler secret put GOOGLE_ADS_CLIENT_SECRET
wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
wrangler secret put GOOGLE_ADS_CUSTOMER_ID            # <your-customer-id> (no hyphens)
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_FEED_EXPORTED   # numeric ID
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_PAYWALL_VIEW    # numeric ID
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_DEMO_REQUEST    # numeric ID (optional — see §4)
```

The cron triggers automatically at 09:00 UTC the next day. To smoke-test
sooner, hit the manual trigger:

```bash
curl -X POST -b "$COOKIE" https://www.gtfsx.com/api/admin/events/oci-run
```

(Or visit `/admin/events/oci-status` in the UI — it has a "Run upload now"
button.) The first successful conversion typically appears in Google Ads UI
under Goals → Summary within ~3 hours.

---

## Operational notes

- **Idempotency.** Once a row is uploaded, `event.oci_uploaded_at` is set to
  the unix-ms timestamp of the upload. The pending-rows query filters on
  `oci_uploaded_at IS NULL`, so the same conversion never goes up twice.
- **90-day gclid TTL.** Google rejects gclids older than ~90 days, so rows
  past that cutoff are marked with the sentinel `oci_uploaded_at = -1` and
  `oci_last_error = 'expired (>90 days)'` instead of being sent.
- **Per-row failures.** The request uses `partial_failure: true`. When
  Google reports an individual row as bad, we increment `oci_attempts` and
  store the error in `oci_last_error`. Once `oci_attempts >= 3` the row is
  marked permanently failed (`oci_uploaded_at = -1`) so it stops being
  retried — check the admin page and investigate.
- **Token rotation.** If the refresh token is revoked (e.g. password reset
  for `mark@eateggs.com`, scope change in Google security settings) the
  uploader will start returning OAuth `invalid_grant` errors. Re-run the
  bootstrap snippet above and `wrangler secret put GOOGLE_ADS_REFRESH_TOKEN`
  with the new value.

## What this module does NOT do

- **No GA4 / gtag.js / any client-side analytics.** The whole point of OCI
  is to keep all conversion tracking server-side. Don't add a pixel.
- **No bid-strategy switch.** The campaign stays on Maximize Clicks until
  Mark manually flips it to Maximize Conversions in the Ads UI, which
  should only happen after ≥30 conversions in a 30-day window have been
  uploaded.
- **No conversion values.** Both actions are configured "Don't use a
  value"; the uploader deliberately omits `conversion_value` from the
  payload. Adding a value would silently switch the action to value-based
  mode in Google's system.
- **No user_id linking.** The session-anonymous architecture is locked
  (see `docs/archive/GOOGLE_ADS_PLAN.md` §4). LTV-weighted bidding would require
  changing that and is out of scope.
