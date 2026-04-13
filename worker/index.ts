import { PMTiles, type Source, type RangeResponse } from 'pmtiles';

interface Env {
  ASSETS: Fetcher;
  TILES: R2Bucket;
  MOBILITY_DATABASE_REFRESH_TOKEN: string;
}

class R2Source implements Source {
  constructor(private bucket: R2Bucket, private key: string) {}
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.key, { range: { offset, length } });
    if (!obj) throw new Error(`PMTiles not found: ${this.key}`);
    return { data: await obj.arrayBuffer() };
  }
  getKey(): string {
    return this.key;
  }
}

function getArchive(env: Env, archive: string): PMTiles {
  return new PMTiles(new R2Source(env.TILES, `${archive}.pmtiles`));
}

const TILE_RE = /^\/_demand-tiles\/([a-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/i;

async function serveTile(
  request: Request,
  ctx: ExecutionContext,
  env: Env,
  archive: string,
  z: number, x: number, y: number,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const pmtiles = getArchive(env, archive);
  const tile = await pmtiles.getZxy(z, x, y);

  const response = tile
    ? new Response(tile.data, {
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      })
    : new Response(null, {
        status: 204,
        headers: {
          'Cache-Control': 'public, max-age=604800, s-maxage=2592000',
          'Access-Control-Allow-Origin': '*',
        },
      });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ─── Mobility Database catalog search ──────────────────────────────────────────

let cachedMdToken: { value: string; expiresAt: number } | null = null;

async function getMobilityDbAccessToken(env: Env): Promise<string> {
  if (cachedMdToken && Date.now() < cachedMdToken.expiresAt - 60_000) {
    return cachedMdToken.value;
  }
  const r = await fetch('https://api.mobilitydatabase.org/v1/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: env.MOBILITY_DATABASE_REFRESH_TOKEN }),
  });
  if (!r.ok) {
    throw new Error(`Mobility DB token exchange failed: ${r.status} ${await r.text()}`);
  }
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  cachedMdToken = {
    value: j.access_token,
    expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000,
  };
  return cachedMdToken.value;
}

const ALLOWED_SEARCH_PARAMS = new Set([
  'provider', 'producer_url', 'country_code', 'subdivision_name',
  'municipality', 'limit', 'offset',
]);

async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const upstream = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
  for (const [k, v] of url.searchParams) {
    if (ALLOWED_SEARCH_PARAMS.has(k)) upstream.searchParams.set(k, v);
  }
  if (!upstream.searchParams.has('limit')) upstream.searchParams.set('limit', '50');
  if (!upstream.searchParams.has('status')) upstream.searchParams.set('status', 'active');

  let token: string;
  try {
    token = await getMobilityDbAccessToken(env);
  } catch (err) {
    return new Response(`Mobility DB auth failed: ${(err as Error).message}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const r = await fetch(upstream.toString(), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!r.ok) {
    return new Response(`Mobility DB ${r.status}: ${await r.text()}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const feeds = (await r.json()) as any[];
  // Trim to fields the client actually uses, to keep the response small.
  const trimmed = (Array.isArray(feeds) ? feeds : []).map((f) => ({
    id: f.id,
    provider: f.provider,
    feed_name: f.feed_name,
    note: f.note,
    country_code: f.country_code,
    subdivision_name: f.subdivision_name,
    municipality: f.municipality,
    locations: f.locations,
    source_info: f.source_info && { producer_url: f.source_info.producer_url },
    latest_dataset: f.latest_dataset && {
      id: f.latest_dataset.id,
      hosted_url: f.latest_dataset.hosted_url,
      downloaded_at: f.latest_dataset.downloaded_at,
    },
  }));
  return new Response(JSON.stringify({ results: trimmed }), {
    headers: {
      'Content-Type': 'application/json',
      // Catalog metadata changes infrequently; cache 1h at the edge so repeat
      // searches don't pay the token-exchange + upstream round-trip.
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── ZIP download proxy (CORS workaround for agency-hosted feeds) ─────────────

const MAX_FEED_BYTES = 250 * 1024 * 1024; // 250 MiB cap

async function handleProxy(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('missing ?url=', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  let parsed: URL;
  try { parsed = new URL(target); }
  catch { return new Response('bad url', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } }); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return new Response('only http(s)', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://_proxy.cache/${encodeURIComponent(target)}`, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(target, {
    headers: { 'User-Agent': 'gtfsbuilder.net/1.0 (+https://www.gtfsbuilder.net/)' },
    redirect: 'follow',
  });
  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const cl = upstream.headers.get('content-length');
  if (cl && Number(cl) > MAX_FEED_BYTES) {
    return new Response(`feed too large (${(Number(cl) / 1024 / 1024).toFixed(0)} MiB > 250 MiB cap)`, {
      status: 413,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  const ct = upstream.headers.get('content-type') || 'application/zip';
  const response = new Response(upstream.body, {
    headers: {
      'Content-Type': ct,
      ...(cl ? { 'Content-Length': cl } : {}),
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/_import/search') {
      try {
        return await handleSearch(request, env);
      } catch (err) {
        return new Response(`Search error: ${(err as Error).message}`, {
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
    }
    if (url.pathname === '/_import/proxy') {
      try {
        return await handleProxy(request, ctx);
      } catch (err) {
        return new Response(`Proxy error: ${(err as Error).message}`, {
          status: 500,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    const tileMatch = url.pathname.match(TILE_RE);
    if (tileMatch) {
      const [, archive, zStr, xStr, yStr] = tileMatch;
      try {
        return await serveTile(request, ctx, env, archive, Number(zStr), Number(xStr), Number(yStr));
      } catch (err) {
        return new Response(`Tile error: ${(err as Error).message}`, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
