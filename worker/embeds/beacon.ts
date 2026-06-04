// ─── Embed impression counters ───────────────────────────────────────────────
//
// A tiny, cache-safe view counter for embeds. The embed HTML pages are
// edge-cached (so the server doesn't see most loads), so we count via a 1x1
// beacon that the page pings from the browser on load:
//
//     GET feeds.*/<slug>/embed/beacon?kind=stop&target=STOP123
//
// The beacon response is `no-store` (never cached) and increments a daily
// aggregate row in `embed_impression`. No PII is recorded — no IP, no
// User-Agent, no session, no user id; just a per-(project, day, kind, target)
// running count. The owner reads it back via GET /api/projects/:id/embed-impressions.
//
// Gating note: the embeds themselves are already behind the `embeds` paywall on
// the authoring side. The beacon is a public write of an anonymous counter, so
// it is intentionally un-gated (a non-embeds feed simply never emits the
// beacon snippet). It is rate-limited to keep it from being abused as a
// write amplifier.

import { html, raw } from 'hono/html';
import type { Env } from '../env';
import { clientIp, rateLimit } from '../util/rateLimit';

export type ImpressionKind = 'system-map' | 'route' | 'stop' | 'schedule' | 'landing';

const VALID_KINDS: readonly ImpressionKind[] = ['system-map', 'route', 'stop', 'schedule', 'landing'];

// 1x1 transparent GIF (43 bytes) — smallest broadly-supported pixel.
const PIXEL_GIF = Uint8Array.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

export const BEACON_RE = /^\/([a-z0-9][a-z0-9-]*)\/embed\/beacon\/?$/;

function pixelResponse(): Response {
  return new Response(PIXEL_GIF, {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      // Never cache — every load must reach the Worker so it can count. The
      // edge-cached HTML page is what we keep cheap; this pixel stays dynamic.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Handle GET feeds.<host>/<slug>/embed/beacon. Resolves the slug → published
 * project, validates the kind, and bumps the daily aggregate. Always returns
 * the 1x1 pixel (even on unknown slug / bad params) so a broken beacon never
 * shows a broken image on the rider's page.
 */
export async function handleBeacon(request: Request, env: Env, slug: string): Promise<Response> {
  const url = new URL(request.url);
  const kindParam = (url.searchParams.get('kind') ?? '') as ImpressionKind;
  const targetRaw = url.searchParams.get('target') ?? '';

  if (!VALID_KINDS.includes(kindParam)) return pixelResponse();

  // Whole-feed kinds carry no target; per-entity kinds may. Cap the stored
  // target so a hostile query string can't bloat the table. Empty when absent.
  const target = targetRaw.slice(0, 128);

  // Resolve the published project for this slug. Only counts for live feeds;
  // unpublished slugs are silently ignored (still return the pixel).
  const pub = await env.DB.prepare(
    `SELECT pub.project_id AS project_id
       FROM publication pub
       JOIN feed_project p ON p.id = pub.project_id AND p.deleted_at IS NULL
      WHERE pub.canonical_slug = ?
      LIMIT 1`,
  )
    .bind(slug)
    .first<{ project_id: string }>();
  if (!pub) return pixelResponse();

  // Soft rate limit per IP so the beacon can't be hammered into a write
  // amplifier. The IP is used ONLY for this transient counter key and is never
  // stored. Generous (600/min) — a real embed pings once per page load.
  try {
    await rateLimit(env, { key: `embed-beacon:${clientIp(request)}`, limit: 600, windowSec: 60 });
  } catch {
    // Over the limit — still return the pixel, just don't count.
    return pixelResponse();
  }

  try {
    await env.DB.prepare(
      `INSERT INTO embed_impression (project_id, day, kind, target, views)
         VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (project_id, day, kind, target)
         DO UPDATE SET views = views + 1`,
    )
      .bind(pub.project_id, todayUtc(), kindParam, target)
      .run();
  } catch {
    // Counting is best-effort; never fail the pixel on a DB hiccup.
  }

  return pixelResponse();
}

/**
 * The client-side beacon snippet embedded into an embed page. It pings the
 * beacon endpoint once on load. Uses an <img> as the no-JS fallback path and
 * `navigator.sendBeacon`/`fetch(keepalive)` when JS is available so it survives
 * even an immediate navigation away. `kind`/`target` are the dimensions to count.
 *
 * Crucially this runs in the browser, so it fires on every *view* even when the
 * page HTML itself is served from the edge cache — the counter never defeats
 * caching.
 */
export function renderImpressionBeacon(slug: string, kind: ImpressionKind, target?: string) {
  const qs = new URLSearchParams({ kind });
  if (target) qs.set('target', target);
  const path = `/${encodeURIComponent(slug)}/embed/beacon?${qs.toString()}`;
  // The inline script is static (no interpolated user data beyond the JSON-safe
  // path) and self-contained. The <noscript> <img> covers JS-disabled clients.
  const js = `(function(){try{var p=${JSON.stringify(path)};if(navigator.sendBeacon){navigator.sendBeacon(p);}else{fetch(p,{method:'GET',keepalive:true,mode:'no-cors'});}}catch(e){var i=new Image();i.src=${JSON.stringify(path)};}})();`;
  return html`<script>${raw(js)}</script><noscript><img src="${path}" alt="" width="1" height="1" style="position:absolute;width:1px;height:1px;opacity:0" /></noscript>`;
}
