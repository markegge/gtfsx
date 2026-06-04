import { html } from 'hono/html';
import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { embedHeaders, renderLayout, embedFooter } from './layout';
import { buildSystemMapData, renderMap } from './map';
import { renderExpiryWarning } from './route';
import { todayInTimezone } from './services';
import { resolveLang } from './i18n';
import { parseTheme, themeCacheKey, themeStyle } from './theme';
import { renderImpressionBeacon } from './beacon';

export async function renderSystemMapEmbed(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return new Response('Feed not found', { status: 404 });

  const url = new URL(request.url);
  const agency = feed.state.agencies[0];

  // Theme + language fold into the ETag for cache safety (see route.ts).
  const theme = parseTheme(url.searchParams);
  const { lang, t } = resolveLang(
    url.searchParams.get('lang'),
    feed.state.feedInfo?.feed_lang,
    agency?.agency_lang,
  );
  const variant = `${themeCacheKey(theme)}-${lang}`;

  const ifNoneMatch = request.headers.get('If-None-Match');
  const etag = `"${feed.snapshotId}-system-${variant}"`;
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
    headers.set('ETag', etag);
    return new Response(null, { status: 304, headers });
  }

  const data = buildSystemMapData(feed.state, slug);
  const map = renderMap(data, env.MAPBOX_TOKEN);
  const tz = agency?.agency_timezone;
  const today = todayInTimezone(tz);
  const expiryWarning = renderExpiryWarning(feed.state.feedInfo?.feed_end_date, today, t);

  const routeLinks = feed.state.routes
    .slice()
    .sort((a, b) => {
      const an = a.route_short_name || a.route_id;
      const bn = b.route_short_name || b.route_id;
      return an.localeCompare(bn, undefined, { numeric: true });
    })
    .map((r) => {
      const color = `#${r.route_color || 'cccccc'}`;
      const text = `#${r.route_text_color || '000000'}`;
      const short = r.route_short_name || r.route_id;
      const long = r.route_long_name || '';
      return html`
        <a href="/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(r.route_id)}">
          <span class="route-badge" style="background: ${color}; color: ${text};">${short}</span>
          <span class="name">${long}</span>
        </a>
      `;
    });

  const agencyName = agency?.agency_name ?? feed.projectName;
  const titleText = `${agencyName} — System Map`;
  const description = `Interactive system map for ${agencyName}. ${feed.state.routes.length} routes, ${feed.state.stops.length} stops.`;

  const body = html`
    <header class="embed-header">
      ${feed.brandLogoUrl
        ? html`<img class="brand-logo" src="${feed.brandLogoUrl}" alt="${agencyName} logo" />`
        : ''}
      <div>
        <h1>${agencyName}</h1>
        <div class="effective">${t.systemMap} · ${t.routeCount(feed.state.routes.length)} · ${feed.state.stops.length} stops</div>
      </div>
    </header>
    ${expiryWarning}
    ${map}
    <h3>${t.routes}</h3>
    <div class="route-list">${routeLinks}</div>
    ${embedFooter(feed.ownerPlan, undefined, t.poweredBy)}
    ${renderImpressionBeacon(slug, 'system-map')}
  `;

  const html5 = await renderLayout({
    title: titleText,
    social: {
      title: titleText,
      description,
      url: url.toString(),
    },
    brandColor: feed.brandPrimaryColor,
    themeStyle: themeStyle(theme),
    lang,
    body: await body,
  });

  const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
  headers.set('ETag', etag);
  return new Response(String(html5), { status: 200, headers });
}
