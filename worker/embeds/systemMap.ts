import { html } from 'hono/html';
import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { embedHeaders, renderLayout } from './layout';
import { buildSystemMapData, renderMap } from './map';
import { renderExpiryWarning } from './route';
import { todayInTimezone } from './services';

export async function renderSystemMapEmbed(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return new Response('Feed not found', { status: 404 });

  const ifNoneMatch = request.headers.get('If-None-Match');
  const etag = `"${feed.versionId}-system"`;
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    const headers = embedHeaders(feed.versionId, feed.publishedAt);
    headers.set('ETag', etag);
    return new Response(null, { status: 304, headers });
  }

  const url = new URL(request.url);
  const agency = feed.state.agencies[0];
  const data = buildSystemMapData(feed.state, slug);
  const map = renderMap(data, env.MAPBOX_TOKEN);
  const tz = agency?.agency_timezone;
  const today = todayInTimezone(tz);
  const expiryWarning = renderExpiryWarning(feed.state.feedInfo?.feed_end_date, today);

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
      <div>
        <h1>${agencyName}</h1>
        <div class="effective">System map · ${feed.state.routes.length} routes · ${feed.state.stops.length} stops</div>
      </div>
    </header>
    ${expiryWarning}
    ${map}
    <h3>Routes</h3>
    <div class="route-list">${routeLinks}</div>
    <footer class="embed-footer">
      Powered by <a href="https://gtfsbuilder.net" target="_blank" rel="noopener">GTFS Builder</a>
    </footer>
  `;

  const html5 = await renderLayout({
    title: titleText,
    social: {
      title: titleText,
      description,
      url: url.toString(),
    },
    brandColor: feed.brandPrimaryColor,
    body: await body,
  });

  const headers = embedHeaders(feed.versionId, feed.publishedAt);
  headers.set('ETag', etag);
  return new Response(String(html5), { status: 200, headers });
}
