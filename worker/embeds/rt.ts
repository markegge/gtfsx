// ─── GTFS-Realtime passthrough ───────────────────────────────────────────────
//
// Agencies register the RT feed URLs they already run in `project_rt_feed`
// (kind = 'vehicle_positions' | 'trip_updates' | 'alerts'; see migration 0003
// and worker/projects/routes.ts PUT /:id/rt-feeds). Until now those URLs were
// metadata only — forwarded in feed_info.json but never served.
//
// This module turns the registered URLs into a real passthrough on the feeds
// origin so embeds (and integrators) get a same-origin, CORS-open RT surface
// that inherits the feed's slug:
//
//     GET feeds.*/<slug>/rt/vehicle_positions.pb     (raw protobuf, proxied)
//     GET feeds.*/<slug>/rt/vehicle_positions.json    (decoded to JSON)
//     GET feeds.*/<slug>/rt/trip_updates.pb | .json
//     GET feeds.*/<slug>/rt/alerts.pb | .json          (agency-registered alerts)
//
// We DO NOT fabricate an RT source: if the agency hasn't registered a URL for
// the requested kind, this 404s. The `managed=1` alerts row (our own served
// alerts.pb, written by the Service Alerts feature) is excluded — that already
// has its own /<slug>/alerts.pb endpoint.
//
// Gated like the rest of the embed surface: the owner must hold the `embeds`
// entitlement (403 otherwise). RT is inherently live, so responses use a very
// short edge cache (s-maxage=15) and never a snapshot ETag.

import { html, raw } from 'hono/html';
import type { Env } from '../env';
import { planHasFeature } from '../billing/plans';
import type { Plan } from '../projects/quotas';
import { decodeFeedMessage, feedMessageToJson } from '../alerts/render';

export type RtKind = 'vehicle_positions' | 'trip_updates' | 'alerts';
export type RtFormat = 'pb' | 'json';

const RT_KINDS: readonly RtKind[] = ['vehicle_positions', 'trip_updates', 'alerts'];

// feeds.*/<slug>/rt/<kind>.<pb|json>
export const RT_RE = /^\/([a-z0-9][a-z0-9-]*)\/rt\/([a-z_]+)\.(pb|json)$/;

/** True for any path this module handles. */
export function isRtPath(pathname: string): boolean {
  const m = pathname.match(RT_RE);
  if (!m) return false;
  return (RT_KINDS as readonly string[]).includes(m[2]) && (m[3] === 'pb' || m[3] === 'json');
}

interface RtOwnerRow {
  project_id: string;
  owner_type: string;
  owner_id: string;
}

/** Resolve the published project + its owner plan + the RT URL for a kind. */
async function resolveRtSource(
  env: Env,
  slug: string,
  kind: RtKind,
): Promise<{ ownerPlan: Plan; url: string } | { error: 'no_feed' | 'no_source' }> {
  const proj = await env.DB.prepare(
    `SELECT pub.project_id AS project_id, p.owner_type AS owner_type, p.owner_id AS owner_id
       FROM publication pub
       JOIN feed_project p ON p.id = pub.project_id AND p.deleted_at IS NULL
      WHERE pub.canonical_slug = ?
      LIMIT 1`,
  )
    .bind(slug)
    .first<RtOwnerRow>();
  if (!proj) return { error: 'no_feed' };

  // External (managed=0) source registered by the agency for this kind.
  const rt = await env.DB.prepare(
    `SELECT url FROM project_rt_feed WHERE project_id = ? AND kind = ? AND managed = 0 ORDER BY created_at LIMIT 1`,
  )
    .bind(proj.project_id, kind)
    .first<{ url: string }>();
  if (!rt?.url) return { error: 'no_source' };

  let ownerPlan: Plan = 'free';
  if (proj.owner_type === 'org') {
    const org = await env.DB.prepare(
      `SELECT plan FROM organization WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(proj.owner_id)
      .first<{ plan: string }>();
    if (org?.plan) ownerPlan = org.plan as Plan;
  } else {
    const user = await env.DB.prepare(`SELECT plan FROM user WHERE id = ?`)
      .bind(proj.owner_id)
      .first<{ plan: string }>();
    if (user?.plan) ownerPlan = user.plan as Plan;
  }

  return { ownerPlan, url: rt.url };
}

function rtError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Handle GET feeds.<host>/<slug>/rt/<kind>.<pb|json>. Proxies the agency-
 * registered upstream RT feed. Assumes the caller confirmed GET/HEAD.
 */
export async function handleRtRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const m = url.pathname.match(RT_RE);
  if (!m) return rtError(404, 'not_found', 'No such RT endpoint.');
  const slug = m[1];
  const kind = m[2] as RtKind;
  const format = m[3] as RtFormat;
  if (!(RT_KINDS as readonly string[]).includes(kind)) {
    return rtError(404, 'not_found', 'Unknown RT kind.');
  }

  const resolved = await resolveRtSource(env, slug, kind);
  if ('error' in resolved) {
    if (resolved.error === 'no_feed') return rtError(404, 'not_found', 'No feed published here.');
    return rtError(404, 'no_rt_source', `No ${kind} feed is registered for this feed.`);
  }
  if (!planHasFeature(resolved.ownerPlan, 'embeds')) {
    return rtError(403, 'plan_required', 'RT passthrough requires the Planner plan or higher.');
  }

  let upstream: Response;
  try {
    upstream = await fetch(resolved.url, {
      method: 'GET',
      headers: { Accept: 'application/x-protobuf, application/octet-stream' },
      // Coalesce upstream polling at the edge — the agency's RT updates every
      // ~15-30s; we cache the upstream fetch for 15s.
      cf: { cacheTtl: 15, cacheEverything: true },
    });
  } catch {
    return rtError(502, 'upstream_unreachable', 'Could not reach the upstream RT feed.');
  }
  if (!upstream.ok) {
    return rtError(502, 'upstream_error', `Upstream RT feed returned ${upstream.status}.`);
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer());

  if (format === 'json') {
    let json: Record<string, unknown>;
    try {
      json = feedMessageToJson(decodeFeedMessage(bytes));
    } catch {
      return rtError(502, 'decode_failed', 'Upstream RT payload was not valid GTFS-Realtime protobuf.');
    }
    const headers = rtJsonHeaders();
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(JSON.stringify(json), { status: 200, headers });
  }

  // Raw protobuf passthrough.
  const headers = new Headers({
    'Content-Type': 'application/x-protobuf',
    'Cache-Control': 'public, max-age=10, s-maxage=15',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(bytes, { status: 200, headers });
}

function rtJsonHeaders(): Headers {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=10, s-maxage=15',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'X-Content-Type-Options': 'nosniff',
  });
}

/**
 * Whether the project has an agency-registered (managed=0) source for a kind.
 * Used to decide — at HTML-render time, which is cache-safe because it doesn't
 * depend on the live RT payload — whether to emit the client-side RT enhancer.
 */
export async function hasRtSource(env: Env, projectId: string, kind: RtKind): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS one FROM project_rt_feed WHERE project_id = ? AND kind = ? AND managed = 0 LIMIT 1`,
  )
    .bind(projectId, kind)
    .first<{ one: number }>();
  return !!row;
}

// ─── Client-side RT enhancer for the stop embed ──────────────────────────────
//
// Rendered into the (edge-cached) stop embed HTML when the feed has a
// trip_updates source. It runs in the rider's browser and fetches the live
// trip_updates JSON from the same-origin passthrough, then annotates each
// departure <li data-trip data-stop> with a live predicted time. Because it
// fetches client-side, the cached HTML never carries stale RT data — caching
// stays intact. Pure static script (the only interpolated values are the
// JSON-encoded same-origin URL + the localized "Live" label).
export function renderRtStopEnhancer(slug: string, stopId: string, liveLabel: string) {
  const rtUrl = `/${encodeURIComponent(slug)}/rt/trip_updates.json`;
  const js = `(function(){
  try {
    var URL_=${JSON.stringify(rtUrl)}, LIVE=${JSON.stringify(liveLabel)}, STOP=${JSON.stringify(stopId)};
    function fmt(sec){var d=new Date(sec*1000);var h=d.getHours(),m=d.getMinutes();var ap=h>=12?'p':'a';var h12=h%12;if(h12===0)h12=12;return h12+':'+(m<10?'0'+m:m)+ap;}
    function apply(json){
      var ent=(json&&json.entity)||[];var byTrip={};
      for(var i=0;i<ent.length;i++){var tu=ent[i].tripUpdate;if(!tu||!tu.trip||!tu.trip.tripId)continue;var sus=tu.stopTimeUpdate||[];for(var j=0;j<sus.length;j++){var su=sus[j];if(su.stopId!==STOP)continue;var tm=(su.departure&&su.departure.time)||(su.arrival&&su.arrival.time);if(tm)byTrip[tu.trip.tripId]=Number(tm);}}
      var items=document.querySelectorAll('li[data-trip]');
      for(var k=0;k<items.length;k++){var li=items[k];var t=li.getAttribute('data-trip');if(byTrip[t]==null)continue;var span=li.querySelector('.dep-live');if(!span){span=document.createElement('span');span.className='dep-live';li.querySelector('.dep-time').appendChild(span);}span.textContent=' '+LIVE+' '+fmt(byTrip[t]);li.classList.add('has-live');}
    }
    function poll(){fetch(URL_,{mode:'cors'}).then(function(r){return r.ok?r.json():null;}).then(function(j){if(j)apply(j);}).catch(function(){});}
    poll();setInterval(poll,30000);
  } catch(e){}
})();`;
  // Minimal styling for the live badge; scoped, tiny.
  const css = `.dep-live{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:600;background:#dcfce7;color:#166534;}`;
  return html`<style>${raw(css)}</style><script>${raw(js)}</script>`;
}
