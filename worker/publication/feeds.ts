// Public feed distribution for feeds.gtfsstudio.net (and any hostname starting
// with `feeds.`). No auth cookies ever reach this handler — it routes from
// worker/index.ts before entering Hono.
//
// Supported routes:
//   GET /<slug>/gtfs.zip               canonical published feed
//   GET /<slug>/feed_info.json         sidecar metadata (BE-74)
//   GET /<slug>/draft/<token>.zip      unlisted review URL (BE-60)
//   GET /robots.txt                    disallow everything (feeds aren't for crawling)
//
// Cache headers tuned for GTFS ingestors (OTP, Transitland, Google, Apple):
//   canonical   public, max-age=3600, s-maxage=3600, ETag, Last-Modified
//   draft       private, max-age=300, X-Robots-Tag: noindex, no ETag
//   404 / 410   never cached (no Cache-Control; the Worker returns fresh each time)

import type { Env } from '../env';
import { sha256Hex } from '../util/crypto';
import { getFeedBlob } from '../projects/r2';
import { ungzip } from './ungzip';
import { renderRouteEmbed } from '../embeds/route';
import { renderSystemMapEmbed } from '../embeds/systemMap';
import { renderStopEmbed } from '../embeds/stop';
import { renderLandingPage } from '../embeds/landing';

interface PublicationRow {
  project_id: string;
  version_id: string;
  published_at: number;
  canonical_slug: string;
  zip_r2_key: string;
  slug: string; // from feed_project
  name: string;
  description: string | null;
  state_r2_key: string; // from feed_version (for sidecar)
}

interface DraftRow {
  token_hash: string;
  project_id: string;
  version_id: string;
  expires_at: number;
  revoked_at: number | null;
  slug: string;
}

function notFound(body = 'No feed published here.'): Response {
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function gone(body = 'Gone'): Response {
  return new Response(body, {
    status: 410,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function httpDate(ms: number): string {
  return new Date(ms).toUTCString();
}

function yyyymmdd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Weak-tag compatible ETag comparator.
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  // Strip weak prefix and whitespace, split on comma, normalize quotes.
  const tags = ifNoneMatch.split(',').map((s) => s.trim().replace(/^W\//, ''));
  return tags.includes(etag) || tags.includes('*');
}

async function loadPublication(env: Env, slug: string): Promise<PublicationRow | null> {
  return env.DB.prepare(
    `SELECT pub.project_id, pub.version_id, pub.published_at, pub.canonical_slug, pub.zip_r2_key,
            p.slug, p.name, p.description,
            v.state_r2_key
       FROM publication pub
       JOIN feed_project p ON p.id = pub.project_id
       JOIN feed_version v ON v.id = pub.version_id AND v.project_id = pub.project_id
       WHERE pub.canonical_slug = ?
       LIMIT 1`,
  )
    .bind(slug)
    .first<PublicationRow>();
}

async function loadDraft(env: Env, tokenHash: string): Promise<DraftRow | null> {
  return env.DB.prepare(
    `SELECT d.token_hash, d.project_id, d.version_id, d.expires_at, d.revoked_at,
            p.slug
       FROM draft_link d
       JOIN feed_project p ON p.id = d.project_id
       WHERE d.token_hash = ?
       LIMIT 1`,
  )
    .bind(tokenHash)
    .first<DraftRow>();
}

// ─── Route dispatch ────────────────────────────────────────────────────────────

const CANONICAL_RE = /^\/([a-z0-9][a-z0-9-]*)\/gtfs\.zip$/;
const FEED_INFO_RE = /^\/([a-z0-9][a-z0-9-]*)\/feed_info\.json$/;
const DRAFT_RE = /^\/([a-z0-9][a-z0-9-]*)\/draft\/([A-Za-z0-9_\-]+)\.zip$/;
const EMBED_ROUTE_RE = /^\/([a-z0-9][a-z0-9-]*)\/embed\/route\/([^/?#]+)\/?$/;
const EMBED_STOP_RE = /^\/([a-z0-9][a-z0-9-]*)\/embed\/stop\/([^/?#]+)\/?$/;
const EMBED_SYSMAP_RE = /^\/([a-z0-9][a-z0-9-]*)\/embed\/system-map\/?$/;
const ORG_LOGO_RE = /^\/_\/orgs\/([A-Z0-9]+)\/logo\/?$/i;
const FORUM_IMAGE_RE = /^\/_forum-images\/(images\/[A-Z0-9]+\/[A-Z0-9]+\.(?:jpg|png|gif|webp))$/i;
const LANDING_RE = /^\/([a-z0-9][a-z0-9-]*)\/?$/;

export async function feedsHandler(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  const canonical = url.pathname.match(CANONICAL_RE);
  if (canonical) {
    return serveCanonicalZip(request, env, canonical[1]);
  }
  const info = url.pathname.match(FEED_INFO_RE);
  if (info) {
    return serveFeedInfo(env, info[1]);
  }
  const draft = url.pathname.match(DRAFT_RE);
  if (draft) {
    return serveDraft(request, env, draft[1], draft[2]);
  }

  const embedRoute = url.pathname.match(EMBED_ROUTE_RE);
  if (embedRoute) {
    return renderRouteEmbed(request, env, embedRoute[1], decodeURIComponent(embedRoute[2]));
  }
  const embedStop = url.pathname.match(EMBED_STOP_RE);
  if (embedStop) {
    return renderStopEmbed(request, env, embedStop[1], decodeURIComponent(embedStop[2]));
  }
  const embedSystem = url.pathname.match(EMBED_SYSMAP_RE);
  if (embedSystem) {
    return renderSystemMapEmbed(request, env, embedSystem[1]);
  }
  const orgLogo = url.pathname.match(ORG_LOGO_RE);
  if (orgLogo) {
    return serveOrgLogo(request, env, orgLogo[1]);
  }
  const forumImage = url.pathname.match(FORUM_IMAGE_RE);
  if (forumImage) {
    return serveForumImage(request, env, forumImage[1]);
  }
  // Landing page — must come last so the more-specific embed/zip/draft
  // patterns match first. Excludes reserved subpaths.
  const landing = url.pathname.match(LANDING_RE);
  if (landing) {
    return renderLandingPage(request, env, landing[1]);
  }

  return notFound();
}

// ─── Forum image (public read) ──────────────────────────────────────────────

// Serve user-uploaded forum images from FORUM_IMAGES at
// /_forum-images/images/<userId>/<imageId>.<ext>. The path mirrors the R2
// key 1:1 — image immutability is enforced by content-addressing in the
// upload flow (ULID-keyed). soft-deleted rows are blocked here so a
// /api/forum/uploads delete really removes the image from the public web.
async function serveForumImage(request: Request, env: Env, r2Key: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT content_type, deleted_at FROM forum_image WHERE r2_key = ? LIMIT 1`,
  ).bind(r2Key).first<{ content_type: string; deleted_at: number | null }>();
  if (!row) return notFound('Image not found.');
  if (row.deleted_at) return gone('Image deleted.');

  const obj = await env.FORUM_IMAGES.get(r2Key);
  if (!obj) return notFound('Image not found.');

  const etag = obj.httpEtag;
  if (etagMatches(request.headers.get('If-None-Match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag,
        Vary: 'Accept-Encoding',
      },
    });
  }

  const headers = new Headers({
    'Content-Type': row.content_type,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
    ETag: etag,
    Vary: 'Accept-Encoding',
  });
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}

// ─── Org brand logo (public read) ───────────────────────────────────────────

async function serveOrgLogo(request: Request, env: Env, orgId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT brand_logo_r2_key, brand_logo_content_type, brand_logo_updated_at
       FROM organization WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(orgId)
    .first<{
      brand_logo_r2_key: string | null;
      brand_logo_content_type: string | null;
      brand_logo_updated_at: number | null;
    }>();
  if (!row || !row.brand_logo_r2_key) return notFound('Logo not set.');

  const etag = `"${row.brand_logo_updated_at ?? 0}"`;
  if (etagMatches(request.headers.get('If-None-Match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'public, max-age=300, s-maxage=86400' },
    });
  }

  const obj = await env.FEEDS.get(row.brand_logo_r2_key);
  if (!obj) return notFound('Logo missing.');

  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': row.brand_logo_content_type ?? 'application/octet-stream',
      ETag: etag,
      'Last-Modified': httpDate(row.brand_logo_updated_at ?? Date.now()),
      'Cache-Control': 'public, max-age=300, s-maxage=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── Canonical ZIP ─────────────────────────────────────────────────────────────

async function serveCanonicalZip(request: Request, env: Env, slug: string): Promise<Response> {
  const pub = await loadPublication(env, slug);
  if (!pub) return notFound();

  const etag = `"${pub.version_id}"`;
  const lastModified = httpDate(pub.published_at);

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  }
  const ifModifiedSince = request.headers.get('If-Modified-Since');
  if (!ifNoneMatch && ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (Number.isFinite(since) && since >= Math.floor(pub.published_at / 1000) * 1000) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          'Last-Modified': lastModified,
          'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        },
      });
    }
  }

  const object = await getFeedBlob(env, pub.zip_r2_key);
  if (!object) {
    // Pointer is valid but the blob is missing — treat as gone rather than 500.
    return gone('Feed archive missing.');
  }
  const filename = `${pub.canonical_slug}-${yyyymmdd(pub.published_at)}.zip`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    ETag: etag,
    'Last-Modified': lastModified,
  };
  const size = object.size;
  if (size) headers['Content-Length'] = String(size);

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

// ─── feed_info.json sidecar ────────────────────────────────────────────────────

async function serveFeedInfo(env: Env, slug: string): Promise<Response> {
  const pub = await loadPublication(env, slug);
  if (!pub) return notFound();

  // Try to pull feed_info fields from the snapshotted JSON state. It's okay if
  // these aren't present — the version row is always there, but the feed may
  // not have populated a feed_info table.
  let feedTitle = pub.name;
  let description = pub.description ?? '';
  let feedStart: string | undefined;
  let feedEnd: string | undefined;
  try {
    const stateObj = await getFeedBlob(env, pub.state_r2_key);
    if (stateObj) {
      const text = await ungzip(stateObj.body);
      const parsed = JSON.parse(text) as {
        feedInfo?: { feed_publisher_name?: string; feed_start_date?: string; feed_end_date?: string };
      };
      if (parsed.feedInfo?.feed_publisher_name) feedTitle = parsed.feedInfo.feed_publisher_name;
      feedStart = parsed.feedInfo?.feed_start_date;
      feedEnd = parsed.feedInfo?.feed_end_date;
    }
  } catch {
    // Best-effort — fall back to DB name/description.
  }

  const rtRows = await env.DB.prepare(
    `SELECT kind, url FROM project_rt_feed WHERE project_id = ?`,
  )
    .bind(pub.project_id)
    .all<{ kind: string; url: string }>();

  const catalogRows = await env.DB.prepare(
    `SELECT catalog, external_feed_id, status
       FROM project_catalog_submission
       WHERE project_id = ?`,
  )
    .bind(pub.project_id)
    .all<{ catalog: string; external_feed_id: string | null; status: string }>();

  const distribution: Record<string, { external_feed_id: string | null; status: string }> = {};
  for (const r of catalogRows.results ?? []) {
    distribution[r.catalog] = { external_feed_id: r.external_feed_id, status: r.status };
  }

  const zipUrl = `${env.FEEDS_ORIGIN.replace(/\/$/, '')}/${pub.canonical_slug}/gtfs.zip`;
  const body = {
    feed_title: feedTitle,
    description,
    feed_start_date: feedStart,
    feed_end_date: feedEnd,
    version_id: pub.version_id,
    published_at: new Date(pub.published_at).toISOString(),
    zip_url: zipUrl,
    distribution,
    rt_feeds: (rtRows.results ?? []).map((r) => ({ kind: r.kind, url: r.url })),
  };

  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}

// ─── Draft ZIP ─────────────────────────────────────────────────────────────────

async function serveDraft(
  request: Request,
  env: Env,
  slug: string,
  token: string,
): Promise<Response> {
  const tokenHash = await sha256Hex(token);
  const row = await loadDraft(env, tokenHash);
  if (!row) return notFound('Draft link not found.');
  if (row.slug !== slug) return notFound('Draft link not found.');
  if (row.revoked_at !== null) return gone('Draft link revoked.');
  if (row.expires_at < Date.now()) return gone('Draft link expired.');

  const { draftZipKey } = await import('../projects/r2');
  const object = await getFeedBlob(env, draftZipKey(row.project_id, tokenHash));
  if (!object) return gone('Draft archive missing.');

  const filename = `${row.slug}-draft-${yyyymmdd(Date.now())}.zip`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, max-age=300',
    'X-Robots-Tag': 'noindex',
  };
  const size = object.size;
  if (size) headers['Content-Length'] = String(size);

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
