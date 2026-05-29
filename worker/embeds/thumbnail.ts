// Route-map thumbnail generation. Renders a feed's whole-system map (every
// route drawn in its route_color, auto-fit) via the Mapbox Static Images API
// and caches two sizes in R2. Used as the public feed landing page's og:image
// and as the image on feed cards in the feeds list.
//
// The Static Images API takes map overlays in the URL and caps the whole URL
// at ~8192 chars, so route shapes are Douglas-Peucker-simplified and
// polyline-encoded (compact), with the simplification tolerance auto-tuned up
// until the assembled URL fits the budget — maximising fidelity per request.
//
// Generation is best-effort: callers run it in ctx.waitUntil and must not let
// a failure break the save/publish that triggered it.

import type { Env } from '../env';
import { getFeedBlob, putFeedBlob, thumbnailKey } from '../projects/r2';
import { buildSystemMapData } from './map';
import type { FeedState } from './types';

const STATIC_BASE = 'https://api.mapbox.com/styles/v1/mapbox/light-v11/static';
// Leave headroom under Mapbox's ~8192 limit for the style/base/token/params.
const URL_BUDGET = 7900;
const SIZES = [
  { size: 'lg' as const, w: 1200, h: 630 },
  { size: 'sm' as const, w: 400, h: 300 },
];

// ─── Geometry hash (the autosave gate) ───────────────────────────────────────

/**
 * Stable hash of just the thumbnail-relevant data — each route shape's points
 * and its color. Returns null when there's nothing to draw (no shapes), so the
 * caller can skip generation. Changes iff the rendered map would change, so a
 * routine autosave (stop rename, calendar tweak, …) leaves it untouched and we
 * don't re-hit Mapbox.
 */
export function thumbnailGeomHash(state: FeedState): string | null {
  const data = buildSystemMapData(state);
  if (data.shapes.length === 0) return null;
  // Round coords to 5 decimals (~1 m) so float noise doesn't churn the hash.
  const parts = data.shapes
    .map((s) => `${s.color}:${s.coords.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';')}`)
    .sort();
  return fnv1a(parts.join('|'));
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── Geometry simplification + encoding ──────────────────────────────────────

const COS_LAT = (lat: number) => Math.cos((lat * Math.PI) / 180);

/**
 * Douglas-Peucker simplification (iterative, clamped-segment distance). Keeps
 * points where the line bends, drops them on straight runs. Coords are
 * [lon, lat]; epsilon is in degrees, longitude scaled by cos(lat) so the
 * tolerance is roughly isotropic. Endpoints are always kept.
 */
function simplify(points: [number, number][], eps: number): [number, number][] {
  if (points.length < 3) return points.slice();
  const cl = COS_LAT(points[0][1]);
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const ax = points[s][0] * cl;
    const ay = points[s][1];
    const bx = points[e][0] * cl;
    const by = points[e][1];
    const dx = bx - ax;
    const dy = by - ay;
    const dd = dx * dx + dy * dy;
    let dmax = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = points[i][0] * cl;
      const py = points[i][1];
      let t = dd === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / dd;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (d > dmax) {
        dmax = d;
        idx = i;
      }
    }
    if (dmax > eps && idx !== -1) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Google encoded-polyline (precision 5). Input coords are [lon, lat]; the
 * algorithm encodes (lat, lon) deltas.
 */
function encodePolyline(coords: [number, number][]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const enc = (v: number): string => {
    let val = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (val >= 0x20) {
      s += String.fromCharCode((0x20 | (val & 0x1f)) + 63);
      val >>>= 5;
    }
    s += String.fromCharCode(val + 63);
    return s;
  };
  for (const [lon, lat] of coords) {
    const ilat = Math.round(lat * 1e5);
    const ilon = Math.round(lon * 1e5);
    out += enc(ilat - prevLat) + enc(ilon - prevLon);
    prevLat = ilat;
    prevLon = ilon;
  }
  return out;
}

interface ColoredShape {
  coords: [number, number][];
  color: string; // 6-char hex, no leading '#'
}

function buildOverlay(shapes: ColoredShape[], eps: number): string {
  return shapes
    .map((s) => {
      const simplified = simplify(s.coords, eps);
      const poly = encodeURIComponent(encodePolyline(simplified));
      return `path-5+${s.color}-0.95(${poly})`;
    })
    .join(',');
}

// ─── Generation ──────────────────────────────────────────────────────────────

export interface ThumbnailResult {
  lg: Uint8Array;
  sm: Uint8Array;
}

/**
 * Render both thumbnail sizes for a feed state. Returns null when there are no
 * route shapes to draw. Throws on Mapbox / network errors (callers catch).
 */
export async function renderRouteThumbnail(state: FeedState, env: Env): Promise<ThumbnailResult | null> {
  if (!env.MAPBOX_TOKEN) {
    console.warn('[thumbnail] MAPBOX_TOKEN not configured — skipping');
    return null;
  }
  const data = buildSystemMapData(state);
  const shapes: ColoredShape[] = data.shapes.map((s) => ({
    coords: s.coords,
    color: (s.color.startsWith('#') ? s.color.slice(1) : s.color) || '666666',
  }));
  if (shapes.length === 0) return null;

  // Auto-tune the simplification tolerance: start near-full-resolution and
  // coarsen until the larger image's URL fits the budget.
  let eps = 0.000003;
  let overlay = buildOverlay(shapes, eps);
  for (let i = 0; i < 40 && urlLen(overlay, 1200, 630, env) > URL_BUDGET; i++) {
    eps *= 1.4;
    overlay = buildOverlay(shapes, eps);
  }

  const out: Partial<ThumbnailResult> = {};
  for (const { size, w, h } of SIZES) {
    const url = staticUrl(overlay, w, h, env);
    const res = await fetchMapbox(url, env);
    if (!res.ok) {
      throw new Error(`mapbox static ${size} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    out[size] = new Uint8Array(await res.arrayBuffer());
  }
  return out as ThumbnailResult;
}

function staticUrl(overlay: string, w: number, h: number, env: Env): string {
  return `${STATIC_BASE}/${overlay}/auto/${w}x${h}@2x?padding=40&access_token=${env.MAPBOX_TOKEN}`;
}

function urlLen(overlay: string, w: number, h: number, env: Env): number {
  return staticUrl(overlay, w, h, env).length;
}

// The Mapbox token is URL-restricted to gtfsx.com origins, so a server-side
// request must present an allowed Referer. APP_ORIGIN is www.gtfsx.com in prod
// and staging.gtfsx.com in staging — both on the token's allow-list.
function fetchMapbox(url: string, env: Env): Promise<Response> {
  const referer = (env.APP_ORIGIN || 'https://www.gtfsx.com').replace(/\/$/, '') + '/';
  return fetch(url, { headers: { Referer: referer } });
}

/**
 * Generate + store the thumbnail for a project from a feed state, gated on the
 * geometry hash. No-ops when geometry is unchanged or there's nothing to draw.
 * Best-effort: logs and swallows errors so it never breaks the caller. Intended
 * for ctx.waitUntil. Returns true when a new thumbnail was written.
 */
export async function generateAndStoreThumbnail(
  env: Env,
  projectId: string,
  state: FeedState,
  currentHash: string | null,
): Promise<boolean> {
  try {
    const hash = thumbnailGeomHash(state);
    if (hash === null) return false; // nothing to draw
    if (hash === currentHash) return false; // geometry unchanged → skip Mapbox
    const imgs = await renderRouteThumbnail(state, env);
    if (!imgs) return false;
    await Promise.all([
      putFeedBlob(env, thumbnailKey(projectId, 'lg'), imgs.lg, { contentType: 'image/png' }),
      putFeedBlob(env, thumbnailKey(projectId, 'sm'), imgs.sm, { contentType: 'image/png' }),
    ]);
    await env.DB.prepare(
      `UPDATE feed_project
          SET thumbnail_geom_hash = ?, thumbnail_version = thumbnail_version + 1
        WHERE id = ?`,
    )
      .bind(hash, projectId)
      .run();
    return true;
  } catch (err) {
    console.error('[thumbnail] generation failed', { projectId, err: String(err) });
    return false;
  }
}

/**
 * Read the project's current thumbnail geom hash, then generate+store if the
 * given state's geometry differs. The convenience entry point for the save and
 * publish triggers — best-effort, safe for ctx.waitUntil.
 */
export async function maybeRegenerateThumbnail(
  env: Env,
  projectId: string,
  state: FeedState,
): Promise<boolean> {
  const cur = await env.DB.prepare(`SELECT thumbnail_geom_hash FROM feed_project WHERE id = ?`)
    .bind(projectId)
    .first<{ thumbnail_geom_hash: string | null }>();
  return generateAndStoreThumbnail(env, projectId, state, cur?.thumbnail_geom_hash ?? null);
}

/**
 * Decompress + parse a gzipped feed-state blob (working state or snapshot) into
 * a FeedState. Mirrors the parsing in loadEmbedFeed. Returns null on failure.
 */
export async function loadFeedStateFromKey(env: Env, r2Key: string): Promise<FeedState | null> {
  const blob = await getFeedBlob(env, r2Key);
  if (!blob) return null;
  try {
    const decompressed = blob.body.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(decompressed).text();
    const parsed = JSON.parse(text) as Partial<FeedState>;
    return {
      agencies: parsed.agencies ?? [],
      calendars: parsed.calendars ?? [],
      calendarDates: parsed.calendarDates ?? [],
      routes: parsed.routes ?? [],
      stops: parsed.stops ?? [],
      trips: parsed.trips ?? [],
      stopTimes: parsed.stopTimes ?? [],
      shapes: parsed.shapes ?? [],
      feedInfo: parsed.feedInfo ?? null,
    };
  } catch (err) {
    console.error('[thumbnail] state parse failed', { r2Key, err: String(err) });
    return null;
  }
}

/** Parse a FeedState from an already-in-memory gzipped buffer (the save path). */
export async function parseFeedStateFromGzip(buf: ArrayBuffer): Promise<FeedState | null> {
  try {
    const decompressed = new Response(buf).body!.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(decompressed).text();
    const parsed = JSON.parse(text) as Partial<FeedState>;
    return {
      agencies: parsed.agencies ?? [],
      calendars: parsed.calendars ?? [],
      calendarDates: parsed.calendarDates ?? [],
      routes: parsed.routes ?? [],
      stops: parsed.stops ?? [],
      trips: parsed.trips ?? [],
      stopTimes: parsed.stopTimes ?? [],
      shapes: parsed.shapes ?? [],
      feedInfo: parsed.feedInfo ?? null,
    };
  } catch (err) {
    console.error('[thumbnail] gzip state parse failed', { err: String(err) });
    return null;
  }
}
