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

// Cache the PMTiles instance per archive to avoid re-reading the header on every tile request.
const archiveCache = new Map<string, PMTiles>();

function getArchive(env: Env, archive: string): PMTiles {
  let p = archiveCache.get(archive);
  if (!p) {
    p = new PMTiles(new R2Source(env.TILES, `${archive}.pmtiles`));
    archiveCache.set(archive, p);
  }
  return p;
}

const TILE_RE = /^\/_demand-tiles\/([a-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(TILE_RE);
    if (!match) {
      return env.ASSETS.fetch(request);
    }
    const [, archive, zStr, xStr, yStr] = match;
    const z = Number(zStr), x = Number(xStr), y = Number(yStr);

    try {
      const pmtiles = getArchive(env, archive);
      const tile = await pmtiles.getZxy(z, x, y);
      if (!tile) {
        return new Response(null, {
          status: 204,
          headers: { 'Cache-Control': 'public, max-age=86400' },
        });
      }
      return new Response(tile.data, {
        headers: {
          'Content-Type': 'application/x-protobuf',
          'Cache-Control': 'public, max-age=86400, s-maxage=2592000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(`Tile error: ${(err as Error).message}`, { status: 500 });
    }
  },
};
