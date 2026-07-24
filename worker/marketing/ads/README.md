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

Four conversion actions map to the four uploaded event kinds:

| Name | Category | Event kind | Status |
|---|---|---|---|
| `feed_exported` | Converted lead | `feed_exported` | exists (created 2026-05-26) |
| `paywall_view` | Qualified lead | `paywall_view` | exists (created 2026-05-26) |
| `demo_request` | Book appointment | `demo_request` (POST `/api/demo-leads`, the /book-demo lead-form submit) | exists (created 2026-07-12, ctId 7682006138) |
| `sign_up` | Sign-up | `sign_up` (POST `/auth/signup`, fresh account signup carrying an ad click id) | needs creation (see §4) |

> **`demo_request` now fires on the lead-form submit, not a redirect click.**
> `/book-demo` used to 302 straight to the booking calendar and count the
> conversion on that redirect. It now serves a lead form; the conversion is
> emitted when the visitor submits it (POST `/api/demo-leads` →
> `insertEvent('demo_request', …)`). Deliberate consequence: reported
> conversion volume drops (a form submit is a higher bar than a redirect
> click), but signal quality rises, so Google Ads optimizes on genuine intent
> rather than every outbound click. The event name, gclid stamping, and
> conversion action are unchanged, so the uploader needs no changes.

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

#### Creating the `sign_up` conversion action (one-time, Ads UI)

Same procedure as `demo_request` above — create an **Import → Track
conversions from clicks** action named `sign_up` (category **Sign-up**,
*Don't use a value*, Count **One**, 90-day window), then store its numeric ID:

```bash
wrangler versions secret put GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP   # numeric ID
```

The `sign_up` event is written server-side by the `/auth/signup` fresh-signup
path (`insertEvent('sign_up', …)`) — only when the signup carried a captured
ad click id (gclid/gbraid/wbraid), and only on a genuinely fresh signup (never
on a login or a pending-verification retry). Organic signups write nothing.
This secret is **optional** in exactly the same way as `demo_request`: leave it
unset and the other three kinds keep uploading while `sign_up` rows stay
pending (yellow note on the admin status page) until it's set.

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
wrangler secret put GOOGLE_ADS_CONVERSION_ACTION_SIGN_UP         # numeric ID (optional — see §4)
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

## Data Manager API migration (2026-07)

**Why:** around 2026-06-22 Google de-allowlisted this account from the legacy
`ConversionUploadService.UploadClickConversions` endpoint. Every upload now
returns `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` → *"New integrations for
uploading click conversions should use the Data Manager API."* This is not a
version or credential problem (verified across API versions v21–v24); the
endpoint is simply closed to us. The supported replacement is the **Data Manager
API** (`datamanager.googleapis.com`).

The uploader now takes the Data Manager path automatically once its two secrets
are set (`GOOGLE_DATAMANAGER_REFRESH_TOKEN` + `GOOGLE_DATAMANAGER_PROJECT_ID`);
until then it uses the legacy path, which is dead but now *fails loudly* (emails
the owner, marks rows failed) instead of silently marking rejections as
uploaded. The Data Manager path also uploads `gbraid`/`wbraid` clicks, not just
`gclid`.

**What's different from the legacy path:** no developer token and no
`login-customer-id` header — the login/manager account and the conversion action
are carried in the request body. It reuses the existing OAuth client
(`GOOGLE_ADS_CLIENT_ID`/`SECRET`), but the refresh token must be minted with the
`https://www.googleapis.com/auth/datamanager` scope (the current one is
adwords-scoped and won't work), and every request sends an `x-goog-user-project`
header naming the Cloud project.

### OAuth runbook (the part that needs Mark)

Everything except the account grant is a repeat of the original setup with a new
scope. The user `mark@eateggs.com` already owns the Ads account, so no extra
access grant is needed.

1. **Enable the API.** In the SAME Google Cloud project that holds the OAuth
   client (created in §2 above, e.g. `gtfsx-ads-oci`): APIs & Services → Library
   → search **"Data Manager API"** → **Enable**.
2. **Note the project ID.** Cloud console → project picker (or the dashboard
   "Project ID", e.g. `gtfsx-ads-oci`). This is `GOOGLE_DATAMANAGER_PROJECT_ID`.
3. **Mint the refresh token** with the datamanager scope. Run the SAME bootstrap
   snippet as §3 above, reusing the same `CLIENT_ID`/`CLIENT_SECRET`, with only
   the scope changed:

   ```python
   # ...identical to the §3 snippet, but:
   SCOPE = "https://www.googleapis.com/auth/datamanager"
   ```

   Approve the consent screen; copy the printed `refresh_token`.
4. **Hand it off.** Paste both values into `.dev.vars` (Claude will
   `wrangler secret put` them to prod):

   ```
   GOOGLE_DATAMANAGER_REFRESH_TOKEN=<the refresh_token from step 3>
   GOOGLE_DATAMANAGER_PROJECT_ID=<the project id from step 2>
   ```

5. **Verify + backfill** (Claude/owner, after the secrets land): the admin OCI
   status page (`/api/admin/events/oci-status`) should show *"Uploading via the
   Data Manager API"*. Hit **Run upload now** to smoke-test, confirm the run
   reports uploads (not failures), then **Requeue rejected conversions** to
   re-send the rows that were wrongly marked uploaded during the outage (safe —
   Google de-dupes by `transactionId`).

**Manager account (`loginAccount`).** The uploader includes
`destinations[].loginAccount` from `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (a prod secret)
when present. If a `validateOnly` test ever reports the login/manager account is
wrong or unnecessary, adjust or unset that secret — the operating account
(`GOOGLE_ADS_CUSTOMER_ID`) is always sent.

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
