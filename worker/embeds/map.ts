import { html, raw } from 'hono/html';
import type { FeedState, Route, Shape } from './types';

// Mapbox GL JS pinned to a recent stable release.
const MAPBOX_VERSION = 'v3.7.0';

export const mapboxAssetTags = () => html`
  <link rel="stylesheet" href="https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}/mapbox-gl.css" />
  <script src="https://api.mapbox.com/mapbox-gl-js/${MAPBOX_VERSION}/mapbox-gl.js"></script>
`;

interface MapData {
  type: 'route' | 'system';
  // Route shapes (line geometries) keyed by shape_id, with a colour each.
  shapes: { id: string; coords: [number, number][]; color: string }[];
  // Stops to draw as dots.
  stops: { id: string; name: string; lat: number; lon: number }[];
}

/**
 * Build the GeoJSON data for one route (its shapes + stops served).
 */
export function buildRouteMapData(route: Route, state: FeedState): MapData {
  const tripsForRoute = state.trips.filter((t) => t.route_id === route.route_id);
  const shapeIds = new Set<string>();
  for (const t of tripsForRoute) if (t.shape_id) shapeIds.add(t.shape_id);

  const color = `#${route.route_color || '666666'}`;
  const shapes = state.shapes
    .filter((s) => shapeIds.has(s.shape_id))
    .map((s) => ({
      id: s.shape_id,
      coords: shapePoints(s),
      color,
    }))
    .filter((s) => s.coords.length >= 2);

  const stopIdsServed = new Set<string>();
  const tripIds = new Set(tripsForRoute.map((t) => t.trip_id));
  for (const st of state.stopTimes) if (tripIds.has(st.trip_id)) stopIdsServed.add(st.stop_id);

  const stops = state.stops
    .filter((s) => stopIdsServed.has(s.stop_id))
    .map((s) => ({ id: s.stop_id, name: s.stop_name, lat: s.stop_lat, lon: s.stop_lon }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));

  return { type: 'route', shapes, stops };
}

/**
 * Build the GeoJSON data for the whole system (all routes + all stops).
 */
export function buildSystemMapData(state: FeedState): MapData {
  // Per-route trip → shape id, so we can colour each shape with its
  // route_color.
  const shapeColor = new Map<string, string>();
  const routeById = new Map<string, Route>(state.routes.map((r) => [r.route_id, r]));
  for (const trip of state.trips) {
    if (!trip.shape_id) continue;
    if (shapeColor.has(trip.shape_id)) continue;
    const r = routeById.get(trip.route_id);
    shapeColor.set(trip.shape_id, `#${r?.route_color || '666666'}`);
  }

  const shapes = state.shapes
    .map((s) => ({
      id: s.shape_id,
      coords: shapePoints(s),
      color: shapeColor.get(s.shape_id) ?? '#666',
    }))
    .filter((s) => s.coords.length >= 2);

  const stops = state.stops
    .filter((s) => Number.isFinite(s.stop_lat) && Number.isFinite(s.stop_lon))
    .map((s) => ({ id: s.stop_id, name: s.stop_name, lat: s.stop_lat, lon: s.stop_lon }));

  return { type: 'system', shapes, stops };
}

function shapePoints(shape: Shape): [number, number][] {
  return shape.points
    .slice()
    .sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence)
    .map((p) => [p.shape_pt_lon, p.shape_pt_lat] as [number, number]);
}

/**
 * Compute a bounding box [minLon, minLat, maxLon, maxLat] from the data.
 * Returns null when there's nothing to bound.
 */
function bounds(data: MapData): [number, number, number, number] | null {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const s of data.shapes) {
    for (const [lon, lat] of s.coords) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  for (const s of data.stops) {
    if (s.lon < minLon) minLon = s.lon;
    if (s.lon > maxLon) maxLon = s.lon;
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
  }
  if (!Number.isFinite(minLon)) return null;
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Render the map container + initialisation script. Falls back to a
 * "Map unavailable" message when the Mapbox token is missing.
 */
export function renderMap(data: MapData, mapboxToken: string | undefined) {
  if (!mapboxToken) {
    return html`<div class="map-fallback">Map unavailable — Mapbox token not configured.</div>`;
  }

  const bbox = bounds(data);
  // Convert the line + stop data into a single GeoJSON FeatureCollection
  // so the client-side script can add it as one source per type.
  const lineFc = {
    type: 'FeatureCollection',
    features: data.shapes.map((s) => ({
      type: 'Feature',
      properties: { color: s.color },
      geometry: { type: 'LineString', coordinates: s.coords },
    })),
  };
  const stopFc = {
    type: 'FeatureCollection',
    features: data.stops.map((s) => ({
      type: 'Feature',
      properties: { name: s.name },
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    })),
  };

  const initScript = `
    (function() {
      const token = ${JSON.stringify(mapboxToken)};
      const lines = ${JSON.stringify(lineFc)};
      const stops = ${JSON.stringify(stopFc)};
      const bbox = ${bbox ? JSON.stringify(bbox) : 'null'};
      if (!window.mapboxgl) return;
      mapboxgl.accessToken = token;
      const map = new mapboxgl.Map({
        container: 'gtfs-embed-map',
        style: 'mapbox://styles/mapbox/light-v11',
        attributionControl: true,
      });
      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      map.on('load', () => {
        const container = document.getElementById('gtfs-embed-map');
        if (container) container.classList.add('loaded');
        if (lines.features.length > 0) {
          map.addSource('lines', { type: 'geojson', data: lines });
          map.addLayer({
            id: 'lines-casing',
            type: 'line',
            source: 'lines',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#ffffff',
              'line-width': 5,
              'line-opacity': 0.85,
            },
          });
          map.addLayer({
            id: 'lines',
            type: 'line',
            source: 'lines',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': ['get', 'color'],
              'line-width': 3,
              'line-opacity': 0.95,
            },
          });
        }
        if (stops.features.length > 0) {
          map.addSource('stops', { type: 'geojson', data: stops });
          map.addLayer({
            id: 'stops-circle',
            type: 'circle',
            source: 'stops',
            paint: {
              'circle-radius': 4,
              'circle-color': '#ffffff',
              'circle-stroke-color': '#1a1a1a',
              'circle-stroke-width': 1.5,
            },
          });
          map.on('click', 'stops-circle', (e) => {
            const f = e.features && e.features[0];
            if (!f) return;
            new mapboxgl.Popup().setLngLat(f.geometry.coordinates).setText(f.properties.name).addTo(map);
          });
          map.on('mouseenter', 'stops-circle', () => { map.getCanvas().style.cursor = 'pointer'; });
          map.on('mouseleave', 'stops-circle', () => { map.getCanvas().style.cursor = ''; });
        }
        if (bbox) {
          map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 32, animate: false });
        }
      });
    })();
  `;

  return html`
    <div id="gtfs-embed-map" class="map" aria-label="Route map">
      <div class="map-skeleton" aria-hidden="true"></div>
    </div>
    <script>
      ${raw(initScript)}
    </script>
  `;
}
