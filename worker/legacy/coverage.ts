/**
 * Serve block-level Coverage FlatGeobuf files from R2 with HTTP Range support.
 *
 * The FlatGeobuf JS client (`flatgeobuf/lib/mjs/http*`) issues HTTP Range
 * requests to read only the header + the spatially-indexed features inside a
 * query bbox, so this route MUST honor `Range` (return 206 + Content-Range) for
 * the client to work. A plain GET (no Range) returns the whole object.
 *
 * Mirrors the R2 read pattern in ./tiles.ts. Objects live in the same `TILES`
 * bucket (gtfs-builder-tiles) under `coverage/<region>.fgb`.
 */
import type { Env } from '../env';

export const COVERAGE_RE = /^\/_coverage\/([a-z0-9_-]+)\.fgb$/i;

const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';

/** Parse a single-range `Range` header against a known object size. Supports
 *  `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`. Returns null when
 *  absent/malformed; throws nothing. */
function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;

  // Suffix range: the last N bytes.
  if (startStr === '') {
    const suffix = parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const start = parseInt(startStr, 10);
  if (!Number.isFinite(start) || start >= size) return null;
  const end = endStr === '' ? size - 1 : Math.min(parseInt(endStr, 10), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
  };
}

export async function serveCoverage(
  request: Request,
  env: Env,
  region: string,
): Promise<Response> {
  const key = `coverage/${region}.fgb`;
  const rangeHeader = request.headers.get('Range');

  if (rangeHeader) {
    // Need the full object size to validate/clamp the range.
    const head = await env.TILES.head(key);
    if (!head) return new Response('Not found', { status: 404, headers: corsHeaders() });

    const range = parseRange(rangeHeader, head.size);
    if (!range) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { ...corsHeaders(), 'Content-Range': `bytes */${head.size}` },
      });
    }

    const obj = await env.TILES.get(key, {
      range: { offset: range.offset, length: range.length },
    });
    if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders() });

    const end = range.offset + range.length - 1;
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${range.offset}-${end}/${head.size}`,
        'Content-Length': String(range.length),
        'Cache-Control': IMMUTABLE,
      },
    });
  }

  const obj = await env.TILES.get(key);
  if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders() });

  return new Response(obj.body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': IMMUTABLE,
    },
  });
}
