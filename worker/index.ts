import { PMTiles, type Source, type RangeResponse } from 'pmtiles';

interface Env {
  ASSETS: Fetcher;
  TILES: R2Bucket;
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
  // Don't cache across requests — if a cold isolate's first fetch failed
  // (eg because the R2 object wasn't uploaded yet), a cached failed
  // instance could serve stale errors. The pmtiles library's own directory
  // caching keeps per-request reads cheap enough.
  return new PMTiles(new R2Source(env.TILES, `${archive}.pmtiles`));
}

const TILE_RE = /^\/_demand-tiles\/([a-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/i;

// Cloudflare's edge cache doesn't front Worker responses by default — we opt
// in explicitly via the Cache API. Cached responses short-circuit the PMTiles
// read entirely, so repeat tile fetches never touch R2.
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(TILE_RE);
    if (!match) {
      return env.ASSETS.fetch(request);
    }
    const [, archive, zStr, xStr, yStr] = match;
    const z = Number(zStr), x = Number(xStr), y = Number(yStr);

    try {
      return await serveTile(request, ctx, env, archive, z, x, y);
    } catch (err) {
      return new Response(`Tile error: ${(err as Error).message}`, { status: 500 });
    }
  },
};
