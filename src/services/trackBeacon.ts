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

function getGclid(): string | null {
  try {
    return sessionStorage.getItem(GCLID_KEY);
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

// Same pattern as captureRefFromUrl, but for Google Ads' ?gclid= identifier.
// First-touch wins: if a gclid is already stored for the session, leave it
// alone — a user who arrived via an ad, browsed, and returned organically
// should still be credited to the original ad click.
export function captureGclidFromUrl(): void {
  try {
    if (sessionStorage.getItem(GCLID_KEY) !== null) return;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('gclid');
    if (!raw) return;
    const trimmed = raw.trim().slice(0, 256);
    if (!trimmed) return;
    sessionStorage.setItem(GCLID_KEY, trimmed);
    params.delete('gclid');
    const qs = params.toString();
    const newUrl =
      window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState(null, '', newUrl);
  } catch {
    // sessionStorage blocked or URL manipulation failed — ignore.
  }
}

type TrackKind = 'page_view' | 'editor_loaded' | 'feed_exported' | 'paywall_view' | 'cta_click';

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
        gclid: getGclid(),
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
