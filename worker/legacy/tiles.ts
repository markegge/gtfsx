import { PMTiles, type Source, type RangeResponse } from 'pmtiles';
import type { Env } from '../env';

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

export const TILE_RE = /^\/_demand-tiles\/([a-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/i;

export async function serveTile(
  request: Request,
  ctx: ExecutionContext,
  env: Env,
  archive: string,
  z: number,
  x: number,
  y: number,
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
