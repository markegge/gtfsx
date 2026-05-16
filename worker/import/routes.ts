import { Hono } from 'hono';
import type { AppContext, Env } from '../env';
import { clientIp, rateLimit } from '../util/rateLimit';
import { getMobilityDbAccessToken } from '../distribution/mobility';

// Deep-link feed import endpoint.
//
// Two entry paths:
//   GET /api/import/fetch?url=<URL>
//   GET /api/import/fetch?source=mobilitydb&feed_id=<id>
//
// Returns the GTFS .zip bytes streamed directly to the caller on success, or
// a JSON `{ error, message }` body on failure. The frontend at /import drives
// this and feeds the bytes into the existing import pipeline.

const MAX_FETCH_BYTES = 100 * 1024 * 1024;     // 100 MB per spec §3.2
const FETCH_TIMEOUT_MS = 30_000;                // 30 s per spec §3.2
const CATALOG_TIMEOUT_MS = 10_000;              // 10 s per spec §3.3
const MAX_REDIRECTS = 5;                        // per spec §3.2

// Rate limit on the public, unauthenticated fetch endpoint.
const RATE_LIMIT = 30;
const RATE_WINDOW_SEC = 60 * 60; // 30 imports / hour / IP

interface ImportError extends Error {
  status: number;
  code: string;
}

function importError(status: number, code: string, message: string): ImportError {
  const e = new Error(message) as ImportError;
  e.status = status;
  e.code = code;
  return e;
}

function errorResponse(err: ImportError): Response {
  return new Response(
    JSON.stringify({ error: err.code, message: err.message }),
    {
      status: err.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    },
  );
}

// SSRF: reject URLs whose hostname is a literal private IP, loopback, link-
// local, or cloud-metadata target. Workers' runtime additionally blocks
// outbound calls to private networks, but explicit checks are belt-and-
// suspenders and cover hostname-literal cases the runtime might not.
function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === 'localhost.localdomain') return true;

  // IPv4 literal
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 10) return true;                                       // 10.0.0.0/8
    if (a === 127) return true;                                      // 127.0.0.0/8
    if (a === 169 && b === 254) return true;                         // 169.254.0.0/16 (link-local + AWS/GCP metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;                // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                         // 192.168.0.0/16
    if (a === 0) return true;                                        // 0.0.0.0/8
    if (a >= 224) return true;                                       // multicast + reserved
    return false;
  }

  // IPv6 literal — block all literals as a coarse-but-safe rule (we have no
  // reason to fetch feeds via IPv6 literal hostnames).
  if (h.includes(':') || h.startsWith('[')) return true;

  return false;
}

function validateTargetUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw importError(400, 'invalid_url', 'That feed URL is malformed.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw importError(400, 'invalid_url', 'Feed URL must use http or https.');
  }
  if (isPrivateHostname(u.hostname)) {
    throw importError(400, 'private_host', 'Feed URLs pointing at private networks are blocked.');
  }
  return u;
}

// Resolve a Mobility Database feed id to its latest hosted ZIP URL.
async function resolveMobilityDbFeed(env: Env, feedId: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(feedId)) {
    throw importError(400, 'invalid_feed_id', 'Mobility Database feed id is malformed.');
  }

  let token: string;
  try {
    token = await getMobilityDbAccessToken(env);
  } catch {
    throw importError(
      503,
      'catalog_unavailable',
      'Mobility Database is currently unreachable. You can paste the feed URL directly instead.',
    );
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://api.mobilitydatabase.org/v1/gtfs_feeds/${encodeURIComponent(feedId)}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: ctrl.signal,
      },
    );
  } catch {
    throw importError(
      503,
      'catalog_unavailable',
      'Mobility Database is currently unreachable. You can paste the feed URL directly instead.',
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404) {
    throw importError(404, 'catalog_not_found', `We couldn't find feed ${feedId} in Mobility Database.`);
  }
  if (!res.ok) {
    throw importError(
      503,
      'catalog_unavailable',
      'Mobility Database returned an error. Try pasting the feed URL directly.',
    );
  }

  const body = await res.json<{ latest_dataset?: { hosted_url?: string } }>();
  const url = body?.latest_dataset?.hosted_url;
  if (!url) {
    throw importError(
      404,
      'catalog_not_found',
      `Feed ${feedId} doesn't have a current dataset available in Mobility Database.`,
    );
  }
  return url;
}

// Fetch the feed ZIP with manual redirect handling (SSRF check per hop),
// streaming size enforcement, and a magic-byte sniff to confirm it really is
// a ZIP. Returns a Uint8Array of the bytes.
async function fetchFeedZip(initialUrl: URL): Promise<Uint8Array> {
  let current = initialUrl;
  let hops = 0;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    while (true) {
      let res: Response;
      try {
        res = await fetch(current.toString(), {
          headers: {
            'User-Agent': 'GTFSStudio-DeepLink/1.0 (+https://www.gtfsstudio.net/docs/deep-links/)',
            Accept: 'application/zip, application/octet-stream;q=0.9, */*;q=0.5',
          },
          redirect: 'manual',
          signal: ctrl.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw importError(504, 'fetch_timeout', `Couldn't reach the feed at ${initialUrl.toString()}.`);
        }
        throw importError(502, 'fetch_failed', `Couldn't reach the feed at ${initialUrl.toString()}.`);
      }

      // Manual redirect — validate target before chasing.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) {
          throw importError(502, 'fetch_failed', `Redirect from ${current.hostname} had no Location header.`);
        }
        if (hops >= MAX_REDIRECTS) {
          throw importError(502, 'fetch_failed', `Too many redirects from ${initialUrl.toString()}.`);
        }
        const next = new URL(loc, current);
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          throw importError(502, 'fetch_failed', `Redirect to non-http(s) target rejected.`);
        }
        if (isPrivateHostname(next.hostname)) {
          throw importError(400, 'private_host', `Redirect chain ended at a private host (${next.hostname}).`);
        }
        current = next;
        hops += 1;
        continue;
      }

      if (!res.ok) {
        throw importError(502, 'fetch_failed', `The feed URL returned ${res.status}.`);
      }

      // Early Content-Type rejection — don't read body for an HTML page.
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.startsWith('text/html') || ct.startsWith('text/plain')) {
        throw importError(415, 'not_zip', `That URL didn't return a GTFS zip file (got ${ct.split(';')[0]}).`);
      }

      if (!res.body) {
        throw importError(502, 'fetch_failed', 'Upstream returned an empty body.');
      }

      // Streaming size enforcement — don't trust Content-Length.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_FETCH_BYTES) {
          await reader.cancel().catch(() => {});
          throw importError(
            413,
            'too_large',
            `This feed is larger than our ${(MAX_FETCH_BYTES / 1024 / 1024).toFixed(0)} MB import limit.`,
          );
        }
        chunks.push(value);
      }

      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
      }

      // ZIP magic bytes: 50 4B 03 04 (PK\x03\x04). Some empty-archive ZIPs use
      // 50 4B 05 06; accept both as belt-and-suspenders.
      if (
        buf.length < 4 ||
        buf[0] !== 0x50 ||
        buf[1] !== 0x4b ||
        !(buf[2] === 0x03 || buf[2] === 0x05) ||
        !(buf[3] === 0x04 || buf[3] === 0x06)
      ) {
        throw importError(415, 'not_zip', "That URL didn't return a GTFS zip file.");
      }

      return buf;
    }
  } finally {
    clearTimeout(timer);
  }
}

export const importRouter = new Hono<AppContext>();

importRouter.get('/fetch', async (c) => {
  const ip = clientIp(c.req.raw);
  await rateLimit(c.env, { key: `import:${ip}`, limit: RATE_LIMIT, windowSec: RATE_WINDOW_SEC });

  const url = c.req.query('url');
  const source = c.req.query('source');

  let targetUrl: URL;
  let sourceLabel: 'direct' | 'mobilitydb' | 'transitland';

  try {
    if (source === 'mobilitydb') {
      const feedId = c.req.query('feed_id');
      if (!feedId) {
        throw importError(400, 'missing_feed_id', 'Mobility Database imports need a feed_id parameter.');
      }
      const resolved = await resolveMobilityDbFeed(c.env, feedId);
      targetUrl = validateTargetUrl(resolved);
      sourceLabel = 'mobilitydb';
    } else if (source === 'transitland') {
      // transit.land integration deferred until an API key is provisioned.
      throw importError(
        501,
        'transitland_not_configured',
        'transit.land integration is not configured yet. Use a direct ?url= for now.',
      );
    } else if (url) {
      targetUrl = validateTargetUrl(url);
      sourceLabel = 'direct';
    } else {
      throw importError(400, 'missing_url', 'We need a GTFS feed URL to import.');
    }

    const bytes = await fetchFeedZip(targetUrl);

    // Best-effort logging (Workers structured logs). No content, just the
    // resolved URL + source. Used for abuse review per spec §3.2.
    console.log(
      JSON.stringify({
        kind: 'import.fetch',
        source: sourceLabel,
        host: targetUrl.hostname,
        bytes: bytes.length,
      }),
    );

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, no-store',
        'X-Import-Source': sourceLabel,
      },
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && 'status' in err) {
      return errorResponse(err as ImportError);
    }
    console.error('[import] unhandled error', err);
    return errorResponse(importError(500, 'internal', 'Something went wrong on our end.'));
  }
});
