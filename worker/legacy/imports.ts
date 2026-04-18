import type { Env } from '../env';
import { getMobilityDbAccessToken } from '../distribution/mobility';

// ─── Mobility Database catalog search ──────────────────────────────────────────

const ALLOWED_SEARCH_PARAMS = new Set([
  'provider', 'producer_url', 'country_code', 'subdivision_name',
  'municipality', 'limit', 'offset',
]);

export async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const baseParams = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (ALLOWED_SEARCH_PARAMS.has(k) && k !== 'provider') baseParams.set(k, v);
  }
  if (!baseParams.has('limit')) baseParams.set('limit', '50');
  if (!baseParams.has('status')) baseParams.set('status', 'active');

  const providerTerm = (url.searchParams.get('provider') || '').trim();
  const upstreams: URL[] = [];
  if (providerTerm) {
    const byProvider = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
    baseParams.forEach((v, k) => byProvider.searchParams.set(k, v));
    byProvider.searchParams.set('provider', providerTerm);
    upstreams.push(byProvider);

    if (!baseParams.has('municipality')) {
      const byMunicipality = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
      baseParams.forEach((v, k) => byMunicipality.searchParams.set(k, v));
      byMunicipality.searchParams.set('municipality', providerTerm);
      upstreams.push(byMunicipality);
    }
  } else {
    const single = new URL('https://api.mobilitydatabase.org/v1/gtfs_feeds');
    baseParams.forEach((v, k) => single.searchParams.set(k, v));
    upstreams.push(single);
  }

  let token: string;
  try {
    token = await getMobilityDbAccessToken(env);
  } catch (err) {
    return new Response(`Mobility DB auth failed: ${(err as Error).message}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const authHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const responses = await Promise.all(
    upstreams.map((u) => fetch(u.toString(), { headers: authHeaders })),
  );
  const failed = responses.find((r) => !r.ok);
  if (failed) {
    return new Response(`Mobility DB ${failed.status}: ${await failed.text()}`, {
      status: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const feedArrays = (await Promise.all(responses.map((r) => r.json()))) as any[][];
  const seen = new Set<string>();
  const feeds: any[] = [];
  for (const arr of feedArrays) {
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      feeds.push(f);
    }
  }
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
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── ZIP download proxy (CORS workaround for agency-hosted feeds) ─────────────

const MAX_FEED_BYTES = 250 * 1024 * 1024; // 250 MiB cap

export async function handleProxy(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return new Response('missing ?url=', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return new Response('bad url', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
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
