import { html } from 'hono/html';
import type { Env } from '../env';
import { loadEmbedFeed } from './loader';
import { embedHeaders, renderLayout } from './layout';
import { renderMap } from './map';
import { renderExpiryWarning } from './route';
import { formatGtfsTime } from './schedule';
import {
  activeServicesOn,
  dayOfWeekInTimezone,
  todayInTimezone,
} from './services';
import type { Route, StopTime, Trip } from './types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Per-stop page: shows the stop, a small map centred on it, and the
 * upcoming departures for today (chronologically, grouped by route).
 */
export async function renderStopEmbed(
  request: Request,
  env: Env,
  slug: string,
  stopId: string,
): Promise<Response> {
  const feed = await loadEmbedFeed(env, slug);
  if (!feed) return new Response('Feed not found', { status: 404 });

  const stop = feed.state.stops.find((s) => s.stop_id === stopId);
  if (!stop) return new Response('Stop not found', { status: 404 });

  const url = new URL(request.url);
  const ifNoneMatch = request.headers.get('If-None-Match');
  const etag = `"${feed.snapshotId}-stop-${stopId}"`;
  if (ifNoneMatch && ifNoneMatch.includes(etag)) {
    const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
    headers.set('ETag', etag);
    return new Response(null, { status: 304, headers });
  }

  const agency = feed.state.agencies[0];
  const tz = agency?.agency_timezone;
  const today = todayInTimezone(tz);
  const dow = dayOfWeekInTimezone(tz);
  const activeToday = activeServicesOn(today, dow, feed.state.calendars, feed.state.calendarDates);

  // Departures from this stop today, with route metadata.
  const tripsById = new Map<string, Trip>(feed.state.trips.map((t) => [t.trip_id, t]));
  const routeById = new Map<string, Route>(feed.state.routes.map((r) => [r.route_id, r]));
  type Departure = {
    timeStr: string;
    timeMinutes: number;
    route: Route;
    headsign: string;
    routeUrl: string;
  };
  const departures: Departure[] = [];
  const routesServingStopIds = new Set<string>();
  for (const st of feed.state.stopTimes) {
    if (st.stop_id !== stopId) continue;
    const trip = tripsById.get(st.trip_id);
    if (!trip) continue;
    routesServingStopIds.add(trip.route_id);
    if (!activeToday.has(trip.service_id)) continue;
    const time = st.departure_time || st.arrival_time;
    if (!time) continue;
    const route = routeById.get(trip.route_id);
    if (!route) continue;
    departures.push({
      timeStr: time,
      timeMinutes: parseToMinutes(time),
      route,
      headsign: trip.trip_headsign || route.route_long_name || '',
      routeUrl: `/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(route.route_id)}`,
    });
  }
  departures.sort((a, b) => a.timeMinutes - b.timeMinutes);

  // Mini-map: just this stop + nearby route shapes lightly drawn.
  const mapData = {
    type: 'system' as const,
    shapes: [],
    stops: [
      { id: stop.stop_id, name: stop.stop_name, lat: stop.stop_lat, lon: stop.stop_lon },
    ],
  };
  const map = renderMap(mapData, env.MAPBOX_TOKEN);

  const routesServingStop = Array.from(routesServingStopIds)
    .map((id) => routeById.get(id))
    .filter((r): r is Route => !!r)
    .sort((a, b) => {
      const an = a.route_short_name || a.route_id;
      const bn = b.route_short_name || b.route_id;
      return an.localeCompare(bn, undefined, { numeric: true });
    });

  const dayName = DAY_NAMES[dow] ?? '';
  const expiryWarning = renderExpiryWarning(feed.state.feedInfo?.feed_end_date, today);
  const agencyName = agency?.agency_name ?? feed.projectName;

  const departuresList =
    departures.length === 0
      ? html`<p class="empty">No more departures today from this stop.</p>`
      : html`
          <ol class="departures">
            ${departures.slice(0, 60).map(
              (d) => html`
                <li>
                  <span class="dep-time">${formatGtfsTime(d.timeStr)}</span>
                  <a class="dep-route" href="${d.routeUrl}">
                    <span
                      class="route-badge"
                      style="background: #${d.route.route_color || 'cccccc'}; color: #${d.route.route_text_color || '000000'};"
                      >${d.route.route_short_name || d.route.route_id}</span
                    >
                    <span class="dep-headsign">${d.headsign}</span>
                  </a>
                </li>
              `,
            )}
          </ol>
        `;

  const routesList = routesServingStop.map((r) => {
    const color = `#${r.route_color || 'cccccc'}`;
    const text = `#${r.route_text_color || '000000'}`;
    const short = r.route_short_name || r.route_id;
    return html`
      <a href="/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(r.route_id)}">
        <span class="route-badge" style="background: ${color}; color: ${text};">${short}</span>
        <span class="name">${r.route_long_name}</span>
      </a>
    `;
  });

  const stopAccessibility = formatAccessibility(stop.wheelchair_boarding);
  const titleText = `${stop.stop_name} — ${agencyName}`;
  const description = `Departures from ${stop.stop_name} on ${agencyName}.`;

  const body = html`
    <header class="embed-header">
      ${feed.brandLogoUrl
        ? html`<img class="brand-logo" src="${feed.brandLogoUrl}" alt="${agencyName} logo" />`
        : ''}
      <div>
        <h1>${stop.stop_name}</h1>
        <div class="effective">
          ${stop.stop_code ? html`Stop ID: ${stop.stop_code} · ` : ''}${routesServingStop.length} route${routesServingStop.length === 1 ? '' : 's'}${stopAccessibility ? html` · ${stopAccessibility}` : ''}
        </div>
      </div>
    </header>
    ${expiryWarning}
    ${map}
    <h3>Departures today (${dayName})</h3>
    ${departuresList}
    ${routesServingStop.length > 0
      ? html`
          <h3>Routes that serve this stop</h3>
          <div class="route-list">${routesList}</div>
        `
      : ''}
    <footer class="embed-footer">
      Powered by <a href="https://gtfsstudio.net" target="_blank" rel="noopener">GTFS Studio</a>
      · ${agencyName}
    </footer>
  `;

  const html5 = await renderLayout({
    title: titleText,
    social: { title: titleText, description, url: url.toString() },
    brandColor: feed.brandPrimaryColor,
    body: await body,
  });
  const headers = embedHeaders(feed.snapshotId, feed.publishedAt);
  headers.set('ETag', etag);
  return new Response(String(html5), { status: 200, headers });
}

function parseToMinutes(t: string): number {
  const m = /^(\d+):(\d{2})/.exec(t.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function formatAccessibility(code: number | undefined): string | null {
  if (code === 1) return 'Wheelchair accessible';
  if (code === 2) return 'Not wheelchair accessible';
  return null;
}
