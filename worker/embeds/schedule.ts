import { html, raw } from 'hono/html';
import type { FeedState, Route, Stop, Trip, StopTime } from './types';

interface TripWithTimes {
  trip: Trip;
  times: StopTime[]; // sorted by stop_sequence
  firstDeparture: string;
  firstDepartureMinutes: number;
}

interface DirectionTable {
  directionId: 0 | 1;
  directionName: string;
  trips: TripWithTimes[];
  // Canonical stop_id order for this direction's grid (rows).
  stopOrder: string[];
}

/**
 * Build the per-direction schedule grid for a route + set of service_ids.
 * Returns one table per direction that has trips. Empty array when the
 * route has no trips for the selected services.
 */
export function buildSchedule(
  route: Route,
  serviceIds: Set<string>,
  state: FeedState,
): DirectionTable[] {
  const tripsForRoute = state.trips.filter(
    (t) => t.route_id === route.route_id && serviceIds.has(t.service_id),
  );
  if (tripsForRoute.length === 0) return [];

  // Index stop_times by trip_id for O(1) lookup.
  const stopTimesByTrip = new Map<string, StopTime[]>();
  for (const st of state.stopTimes) {
    let arr = stopTimesByTrip.get(st.trip_id);
    if (!arr) {
      arr = [];
      stopTimesByTrip.set(st.trip_id, arr);
    }
    arr.push(st);
  }
  for (const arr of stopTimesByTrip.values()) {
    arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  }

  const directions: DirectionTable[] = [];
  for (const dirId of [0, 1] as const) {
    const dirTrips = tripsForRoute.filter((t) => (t.direction_id ?? 0) === dirId);
    if (dirTrips.length === 0) continue;

    const enriched: TripWithTimes[] = [];
    for (const trip of dirTrips) {
      const times = stopTimesByTrip.get(trip.trip_id);
      if (!times || times.length === 0) continue;
      const firstDeparture = times[0].departure_time || times[0].arrival_time || '';
      enriched.push({
        trip,
        times,
        firstDeparture,
        firstDepartureMinutes: parseGtfsTimeToMinutes(firstDeparture),
      });
    }
    if (enriched.length === 0) continue;

    enriched.sort((a, b) => a.firstDepartureMinutes - b.firstDepartureMinutes);

    // Use the longest trip in this direction to seed the canonical
    // stop order. Then merge in any extra stops from other trips that
    // weren't covered, preserving their relative position.
    const longest = enriched.reduce((a, b) => (b.times.length > a.times.length ? b : a));
    const stopOrder: string[] = longest.times.map((t) => t.stop_id);
    const seen = new Set(stopOrder);
    for (const trip of enriched) {
      if (trip === longest) continue;
      let lastIdx = -1;
      for (let i = 0; i < trip.times.length; i++) {
        const sid = trip.times[i].stop_id;
        const known = stopOrder.indexOf(sid);
        if (known >= 0) {
          lastIdx = known;
        } else if (!seen.has(sid)) {
          seen.add(sid);
          if (lastIdx >= 0) {
            stopOrder.splice(lastIdx + 1, 0, sid);
            lastIdx += 1;
          } else {
            stopOrder.unshift(sid);
            lastIdx = 0;
          }
        }
      }
    }

    directions.push({
      directionId: dirId,
      directionName:
        (dirId === 0 ? route._direction_0_name : route._direction_1_name) ||
        (dirId === 0 ? 'Outbound' : 'Inbound'),
      trips: enriched,
      stopOrder,
    });
  }
  return directions;
}

/**
 * Render all schedule tables for a route + service profile.
 */
export function renderScheduleTables(
  route: Route,
  serviceIds: Set<string>,
  state: FeedState,
) {
  const tables = buildSchedule(route, serviceIds, state);
  if (tables.length === 0) {
    return html`<p class="empty">No trips scheduled for this service period.</p>`;
  }
  const stopsById = new Map<string, Stop>(state.stops.map((s) => [s.stop_id, s]));

  const showDirectionHeader = tables.length > 1;
  const parts = tables.map((table) => {
    const stopRows = table.stopOrder.map((stopId) => {
      const stop = stopsById.get(stopId);
      const stopName = stop?.stop_name ?? stopId;
      const cells = table.trips.map((trip) => {
        const t = trip.times.find((x) => x.stop_id === stopId);
        if (!t) return html`<td class="skip">—</td>`;
        const time = t.departure_time || t.arrival_time;
        return html`<td>${formatGtfsTime(time)}</td>`;
      });
      return html`<tr><th scope="row" class="stop-name">${stopName}</th>${cells}</tr>`;
    });

    // Header time = the trip's time at the first stop shown in the table.
    // Falls back to the trip's overall first departure when the trip skips
    // every visible stop (shouldn't happen in practice, but stay defensive).
    const tripHeaders = table.trips.map((trip) => {
      let headerTime = trip.firstDeparture;
      for (const stopId of table.stopOrder) {
        const t = trip.times.find((x) => x.stop_id === stopId);
        if (t) {
          headerTime = t.departure_time || t.arrival_time || headerTime;
          break;
        }
      }
      return html`<th scope="col" class="trip-head">${formatGtfsTime(headerTime)}</th>`;
    });

    const directionLabel = sanitizeDirectionLabel(table.directionName);
    return html`
      <section class="direction">
        ${showDirectionHeader && directionLabel ? html`<h3>${directionLabel}</h3>` : ''}
        <div class="schedule-scroll">
          <table class="schedule">
            <thead>
              <tr><th class="corner">Stop</th>${tripHeaders}</tr>
            </thead>
            <tbody>${stopRows}</tbody>
          </table>
        </div>
      </section>
    `;
  });

  return html`${raw(parts.map((p) => String(p)).join(''))}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Strip user-set direction names that don't help in this view. "(Loop)"
 * is a common editor convention that makes sense as a route description
 * but is redundant here; we'd rather hide the heading than show it.
 */
function sanitizeDirectionLabel(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  if (/^\(\s*loop\s*\)$/i.test(trimmed)) return null;
  return trimmed;
}

function parseGtfsTimeToMinutes(t: string): number {
  // "HH:MM:SS" or "H:MM:SS"; HH may be ≥24 for overnight trips.
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h * 60 + min;
}

/**
 * Format a GTFS time (which can be ≥24h) as a compact 12-hour string.
 *   "08:15:00" → "8:15a"
 *   "17:32:00" → "5:32p"
 *   "25:30:00" → "1:30a +1"
 */
export function formatGtfsTime(t: string): string {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t.trim());
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  let nextDay = false;
  if (h >= 24) {
    h -= 24;
    nextDay = true;
  }
  const suffix = h >= 12 ? 'p' : 'a';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  const minStr = min.toString().padStart(2, '0');
  return `${h12}:${minStr}${suffix}${nextDay ? ' ⁺¹' : ''}`;
}
