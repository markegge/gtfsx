// URL-safety helpers shared by the forum markdown renderer. Kept in their own
// module (not Markdown.tsx) so they can be unit-tested and so the component
// file only exports components (react-refresh / fast-refresh requirement).

// Env-aware public feeds origin (mirrors EmbedPanel / PublishPanel / orgsApi):
// published feeds and forum images are served from feeds.gtfsx.com in prod and
// staging-feeds.gtfsx.com on staging. VITE_FEEDS_ORIGIN overrides when set, but
// it is NOT defined at build time, so we fall back the same staging-aware way
// the other consumers do — otherwise the feeds host is missing from the image
// allowlist and feeds.gtfsx.com images wrongly fall back to alt text.
function feedsOriginHost(): string | null {
  const origin =
    (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
    (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
      ? 'https://staging-feeds.gtfsx.com'
      : 'https://feeds.gtfsx.com');
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

// Dedicated forum-image host (img.gtfsx.com / staging-img.gtfsx.com). NEW
// uploads return URLs here; the feeds host (above) stays allow-listed so
// already-posted feeds.gtfsx.com image URLs keep rendering. Mirrors the
// staging-aware fallback used for the feeds host.
function imagesOriginHost(): string | null {
  const origin =
    (import.meta.env.VITE_IMAGES_ORIGIN as string | undefined) ||
    (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
      ? 'https://staging-img.gtfsx.com'
      : 'https://img.gtfsx.com');
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

// Allow only images served from our own forum-images path. Relative paths
// (`/_forum-images/…`) and absolute URLs on the SPA origin, the public feeds
// origin, or the dedicated image origin all pass; anything else falls back to
// alt text — same allowlist enforced server-side in worker/forum/markdown.ts.
export function safeImageSrc(raw: string): string | null {
  const prefix = '/_forum-images/';
  if (raw.startsWith(prefix)) return raw;
  try {
    const u = new URL(raw, window.location.origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.pathname.startsWith(prefix)) return null;
    // Same-origin (SPA host), the public feeds origin, or the image origin only.
    const allowed = [window.location.host, feedsOriginHost(), imagesOriginHost()].filter(Boolean) as string[];
    if (!allowed.includes(u.host)) return null;
    return u.toString();
  } catch {
    return null;
  }
}
