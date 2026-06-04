import type { Env } from '../env';

// ─── widgets.js — declarative web-component loader ──────────────────────────
//
// Served at  feeds.*/widgets.js  (origin-level, not slug-scoped).
//
// Drops four custom elements onto any host page. Each one resolves to a
// sandboxed <iframe> pointing at the matching server-rendered embed page on
// this same FEEDS origin — so the widgets inherit every property of the
// existing embeds for free: read-only, scoped to the canonical published
// snapshot, edge-cached, version-id ETag, brand color/logo, the GTFS·X badge
// gate, and CSP `frame-ancestors *`. No new data surface is exposed.
//
//   <gtfs-system-map feed="my-agency"></gtfs-system-map>
//   <gtfs-route-map   feed="my-agency" route="R1"></gtfs-route-map>
//   <gtfs-schedule    feed="my-agency" route="R1"></gtfs-schedule>
//   <gtfs-stop        feed="my-agency" stop="STOP123"></gtfs-stop>
//
// Common attributes:
//   feed     (required) the published feed slug
//   height   iframe height in px (default per element)
//   title    iframe title for a11y (sensible default per element)
//   service  optional service-profile id (route/schedule) to preselect a tab
//   accent   optional 6-char hex accent override (per-widget theming)
//   theme    optional 'light' | 'dark' color scheme
//   font     optional 'system' | 'serif' | 'mono' | 'rounded'
//   lang     optional BCP-47 language for the embed chrome (e.g. 'es')
//
// The script reads its own <script src> to learn the origin, so the same
// file works on prod, staging, and local dev without rebuilding.

// The client-side IIFE. `__ORIGIN__` is replaced at serve time with the
// feeds origin. Authored as a string so it ships verbatim — it runs in the
// host page, NOT in the Worker, and must not depend on any bundler.
const WIDGETS_SCRIPT = String.raw`(function () {
  'use strict';
  if (window.__gtfsxWidgetsLoaded) return;
  window.__gtfsxWidgetsLoaded = true;

  var ORIGIN = '__ORIGIN__';

  function enc(v) {
    return encodeURIComponent(String(v == null ? '' : v));
  }

  function addParam(path, key, val) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + key + '=' + enc(val);
  }

  // Append ?service=<id> when the host set it, so a widget can deep-link a tab.
  function withService(path, el) {
    var svc = el.getAttribute('service');
    return svc ? addParam(path, 'service', svc) : path;
  }

  // Pass theming + language attributes straight through to the embed URL, so a
  // host can theme/localize a single widget without changing the feed's saved
  // brand. Mirrors the embed page params (accent / theme / font / lang). The
  // embed folds these into its ETag, so each themed variant caches separately.
  function withTheme(path, el) {
    var out = path;
    var accent = el.getAttribute('accent');
    if (accent) out = addParam(out, 'accent', accent.replace(/^#/, ''));
    var theme = el.getAttribute('theme');
    if (theme) out = addParam(out, 'theme', theme);
    var font = el.getAttribute('font');
    if (font) out = addParam(out, 'font', font);
    var lang = el.getAttribute('lang');
    if (lang) out = addParam(out, 'lang', lang);
    return out;
  }

  // Each element type maps its attributes to one embed URL path. Returns null
  // (and the element renders a friendly error) when a required attr is missing.
  var BUILDERS = {
    'gtfs-system-map': function (el) {
      var feed = el.getAttribute('feed');
      if (!feed) return null;
      return '/' + enc(feed) + '/embed/system-map';
    },
    'gtfs-route-map': function (el) {
      var feed = el.getAttribute('feed');
      var route = el.getAttribute('route');
      if (!feed || !route) return null;
      return withService('/' + enc(feed) + '/embed/route/' + enc(route) + '?view=map', el);
    },
    'gtfs-schedule': function (el) {
      var feed = el.getAttribute('feed');
      var route = el.getAttribute('route');
      if (!feed || !route) return null;
      return withService('/' + enc(feed) + '/embed/route/' + enc(route) + '?view=schedule', el);
    },
    'gtfs-stop': function (el) {
      var feed = el.getAttribute('feed');
      var stop = el.getAttribute('stop');
      if (!feed || !stop) return null;
      return '/' + enc(feed) + '/embed/stop/' + enc(stop);
    },
  };

  var DEFAULT_HEIGHT = {
    'gtfs-system-map': 700,
    'gtfs-route-map': 380,
    'gtfs-schedule': 520,
    'gtfs-stop': 600,
  };

  var DEFAULT_TITLE = {
    'gtfs-system-map': 'Transit system map',
    'gtfs-route-map': 'Route map',
    'gtfs-schedule': 'Route schedule',
    'gtfs-stop': 'Stop departures',
  };

  function makeError(message) {
    var div = document.createElement('div');
    div.setAttribute('role', 'alert');
    div.style.cssText =
      'font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'color:#991b1b;background:#fee2e2;border:1px solid #fca5a5;' +
      'border-radius:8px;padding:12px 14px;';
    div.textContent = message;
    return div;
  }

  function defineWidget(tag) {
    if (window.customElements.get(tag)) return;

    function Widget() {
      return Reflect.construct(HTMLElement, [], Widget);
    }
    Widget.prototype = Object.create(HTMLElement.prototype);
    Widget.prototype.constructor = Widget;

    Widget.prototype.connectedCallback = function () {
      if (this.__rendered) return;
      this.__rendered = true;
      this.render();
    };

    Widget.prototype.render = function () {
      var path = BUILDERS[tag] ? BUILDERS[tag](this) : null;
      while (this.firstChild) this.removeChild(this.firstChild);

      if (!path) {
        this.appendChild(
          makeError(
            '<' + tag + '> is missing a required attribute. ' +
            'Needs at least feed=, plus ' +
            (tag === 'gtfs-stop' ? 'stop=' : tag === 'gtfs-system-map' ? '(none)' : 'route=') + '.',
          ),
        );
        return;
      }

      // Layer per-widget theming + language onto the resolved embed path.
      path = withTheme(path, this);

      var iframe = document.createElement('iframe');
      iframe.src = ORIGIN + path;
      iframe.loading = 'lazy';
      iframe.title = this.getAttribute('title') || DEFAULT_TITLE[tag] || 'GTFS·X embed';
      // Sandbox: allow the embed's own scripts + popups (the map's stop popups
      // link out), keep it same-origin to the FEEDS host but cross-origin to
      // the host page, and block top-navigation / forms.
      iframe.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin');
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      var h = this.getAttribute('height') || DEFAULT_HEIGHT[tag] || 500;
      iframe.style.cssText =
        'display:block;width:100%;height:' + (/^\d+$/.test(String(h)) ? h + 'px' : h) +
        ';border:0;border-radius:8px;';
      this.appendChild(iframe);
    };

    window.customElements.define(tag, Widget);
  }

  defineWidget('gtfs-system-map');
  defineWidget('gtfs-route-map');
  defineWidget('gtfs-schedule');
  defineWidget('gtfs-stop');
})();
`;

/**
 * Serve the declarative web-component loader. Origin-level (no slug) so a
 * single <script src="https://feeds.gtfsx.com/widgets.js"> covers every feed.
 * Long-cached + immutable per snapshot of the script body (content changes
 * only on deploy, never per-request), with a hashed ETag for revalidation.
 */
export async function renderWidgetsLoader(request: Request, env: Env): Promise<Response> {
  // Resolve the public origin the script should point its iframes at. Prefer
  // FEEDS_ORIGIN; fall back to the request origin so local dev / preview hosts
  // work without configuration.
  let origin = '';
  try {
    origin = env.FEEDS_ORIGIN ? new URL(env.FEEDS_ORIGIN).origin : '';
  } catch {
    origin = '';
  }
  if (!origin) origin = new URL(request.url).origin;

  const body = WIDGETS_SCRIPT.replace('__ORIGIN__', origin);

  // Stable, body-derived ETag so the rare deploy that changes the script
  // invalidates caches while normal traffic revalidates cheaply.
  const etag = `"widgets-${await shortHash(body)}"`;
  if (etagMatches(request.headers.get('If-None-Match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'public, max-age=3600, s-maxage=86400' },
    });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/javascript; charset=utf-8',
    // Cross-origin by design — the host page lives anywhere.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    'X-Content-Type-Options': 'nosniff',
    ETag: etag,
  };
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const tags = ifNoneMatch.split(',').map((s) => s.trim().replace(/^W\//, ''));
  return tags.includes(etag) || tags.includes('*');
}

async function shortHash(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest).slice(0, 8);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
