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

export function trackPageview(path: string): void {
  try {
    void fetch('/api/events/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GB-Client': 'web',
      },
      credentials: 'omit',
      keepalive: true,
      body: JSON.stringify({
        kind: 'page_view',
        path,
        ref: getRef(),
        sessionId: getSessionId(),
      }),
    }).catch(() => {
      // Network errors are expected (e.g. offline, ad blocker) — silent.
    });
  } catch {
    // Defensive: never let a tracking error surface to the user.
  }
}
