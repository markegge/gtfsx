// Cookieless analytics beacon. Sends one POST per route change with the
// current pathname, a per-tab session id (sessionStorage), and the inbound
// `?ref=` referral tag captured once at session start.
//
// Failures are silent — analytics is best-effort and must never disrupt the
// user. `fetch(..., { keepalive: true })` lets the request complete even if
// the page is unloading, while still allowing us to set the X-GB-Client
// header that our CSRF middleware requires.

const SESSION_KEY = 'gb_track_session';
const REF_KEY = 'gb_track_ref';
const GCLID_KEY = 'gb_track_gclid';
const GBRAID_KEY = 'gb_track_gbraid';
const WBRAID_KEY = 'gb_track_wbraid';

function randomId(): string {
  // 16 bytes of entropy as hex — plenty for a session id.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = randomId();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return randomId();
  }
}

function getRef(): string | null {
  try {
    return sessionStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
}

function getStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

// On first call of the session, look for `?ref=...` in the current URL,
// persist it for the rest of the session, and strip it from the address bar
// so it doesn't leak into shared links.
export function captureRefFromUrl(): void {
  try {
    if (sessionStorage.getItem(REF_KEY) !== null) return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('ref');
    if (!raw) return;
    const trimmed = raw.trim().slice(0, 128);
    if (!trimmed) return;
    sessionStorage.setItem(REF_KEY, trimmed);
    params.delete('ref');
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  } catch {
    // sessionStorage blocked or URL manipulation failed — ignore.
  }
}

// Capture one `?<param>=` click identifier into sessionStorage and strip it
// from the address bar. First-touch wins per identifier: if it's already
// stored, leave it — a user who arrived via an ad, browsed, and returned
// organically should still be credited to the original ad click. Returns true
// if it stripped a param (so the caller can push a single replaceState).
function captureParam(param: string, storageKey: string, params: URLSearchParams): boolean {
  if (sessionStorage.getItem(storageKey) !== null) return false;
  const raw = params.get(param);
  if (!raw) return false;
  const trimmed = raw.trim().slice(0, 256);
  if (!trimmed) return false;
  sessionStorage.setItem(storageKey, trimmed);
  params.delete(param);
  return true;
}

// Capture Google Ads' click identifiers — gclid, and the privacy-safe gbraid
// (iOS app→web) / wbraid (web→web under consent limits). Capturing only gclid
// dropped every iOS/consent-limited click (migration 0030); the Data Manager
// uploader accepts whichever one a session carries. Name kept (called from
// src/App.tsx) though it now covers all three.
export function captureGclidFromUrl(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const stripped =
      [
        captureParam('gclid', GCLID_KEY, params),
        captureParam('gbraid', GBRAID_KEY, params),
        captureParam('wbraid', WBRAID_KEY, params),
      ].some(Boolean);
    if (!stripped) return;
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  } catch {
    // sessionStorage blocked or URL manipulation failed — ignore.
  }
}

// The Google Ads click identifiers captured for this session (gclid/gbraid/
// wbraid), first-touch, from sessionStorage. Forwarded by conversion forms —
// e.g. the signup form stamps them onto its POST so the server can emit a
// click-ID-attributed `sign_up` event (mirrors the demo-lead carry-through).
// Returns nulls when nothing was captured or storage is blocked.
export function getStoredClickIds(): {
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
} {
  return {
    gclid: getStored(GCLID_KEY),
    gbraid: getStored(GBRAID_KEY),
    wbraid: getStored(WBRAID_KEY),
  };
}

// Keep in sync with the zod enum in worker/events/routes.ts. demo_request is
// recorded server-side by GET /book-demo (worker/marketing/bookDemo.ts) — it
// is listed for type parity only and has no client beacon call site.
type TrackKind =
  | 'page_view'
  | 'editor_loaded'
  | 'feed_exported'
  | 'paywall_view'
  | 'cta_click'
  | 'demo_request';

function send(kind: TrackKind, opts?: { path?: string; label?: string | null }): void {
  try {
    const path =
      opts?.path ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
    void fetch('/api/events/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GB-Client': 'web',
      },
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify({
        kind,
        path,
        ref: getRef(),
        sessionId: getSessionId(),
        label: opts?.label ?? null,
        gclid: getStored(GCLID_KEY),
        gbraid: getStored(GBRAID_KEY),
        wbraid: getStored(WBRAID_KEY),
      }),
    }).catch(() => {
      // Network errors are expected (e.g. offline, ad blocker) — silent.
    });
  } catch {
    // Defensive: never let a tracking error surface to the user.
  }
}

export function trackPageview(path: string): void {
  send('page_view', { path });
}

// Fires once when the editor shell mounts — lets us count "editor sessions"
// (distinct session_ids with this event) separately from marketing-page visits.
export function trackEditorLoaded(): void {
  send('editor_loaded');
}

// Fires after a valid GTFS zip is downloaded — the "value delivered" proxy.
export function trackFeedExported(): void {
  send('feed_exported');
}

// Fires when a Pro/Agency paywall is shown; `feature` is the gated feature key.
export function trackPaywallView(feature: string): void {
  send('paywall_view', { label: feature });
}

// Fires when a marketing CTA is clicked; `name` identifies the specific CTA
// (e.g. 'pricing_fix_my_feed_click'). Lets us measure intent on inquiry flows.
export function trackCtaClick(name: string): void {
  send('cta_click', { label: name });
}
