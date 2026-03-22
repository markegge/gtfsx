import type { ValidationMessage } from '../types/ui';
import type { AppStore } from '../store';

let msgId = 0;
function msg(severity: 'error' | 'warning', message: string, entity_type?: string, entity_id?: string): ValidationMessage {
  return { id: String(++msgId), severity, message, entity_type, entity_id };
}

export function runValidation(state: AppStore): ValidationMessage[] {
  msgId = 0;
  const messages: ValidationMessage[] = [];

  // Agency checks
  if (state.agencies.length === 0) {
    messages.push(msg('error', 'At least one agency is required'));
  } else {
    for (const a of state.agencies) {
      if (!a.agency_name) messages.push(msg('error', `Agency "${a.agency_id}" is missing a name`, 'agency', a.agency_id));
      if (!a.agency_timezone) messages.push(msg('error', `Agency "${a.agency_id}" is missing a timezone`, 'agency', a.agency_id));
    }
  }

  // Calendar checks
  if (state.calendars.length === 0) {
    messages.push(msg('error', 'At least one service pattern (calendar) is required'));
  } else {
    for (const c of state.calendars) {
      if (!c.start_date) messages.push(msg('error', `Calendar "${c.service_id}" is missing start_date`, 'calendar', c.service_id));
      if (!c.end_date) messages.push(msg('error', `Calendar "${c.service_id}" is missing end_date`, 'calendar', c.service_id));
    }
  }

  // Route checks
  if (state.routes.length === 0) {
    messages.push(msg('warning', 'No routes defined'));
  } else {
    for (const r of state.routes) {
      if (!r.route_short_name && !r.route_long_name) {
        messages.push(msg('error', `Route "${r.route_id}" needs either a short name or long name`, 'route', r.route_id));
      }
      // Check if route has any trips
      const hasTrips = state.trips.some((t) => t.route_id === r.route_id);
      if (!hasTrips) {
        messages.push(msg('warning', `Route "${r.route_short_name || r.route_id}" has no trips`, 'route', r.route_id));
      }
    }
  }

  // Stop checks
  for (const s of state.stops) {
    if (!s.stop_name) messages.push(msg('error', `Stop "${s.stop_id}" is missing a name`, 'stop', s.stop_id));
    if (!s.stop_lat || !s.stop_lon) messages.push(msg('error', `Stop "${s.stop_name || s.stop_id}" has invalid coordinates`, 'stop', s.stop_id));
  }

  // Trip checks
  for (const t of state.trips) {
    if (!state.routes.some((r) => r.route_id === t.route_id)) {
      messages.push(msg('error', `Trip "${t.trip_id}" references non-existent route "${t.route_id}"`, 'trip', t.trip_id));
    }
    if (!state.calendars.some((c) => c.service_id === t.service_id)) {
      messages.push(msg('error', `Trip "${t.trip_id}" references non-existent calendar "${t.service_id}"`, 'trip', t.trip_id));
    }

    // Check stop_times ordering
    const tripStopTimes = state.stopTimes
      .filter((st) => st.trip_id === t.trip_id)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);

    if (tripStopTimes.length === 0) {
      messages.push(msg('warning', `Trip "${t.trip_id}" has no stop times`, 'trip', t.trip_id));
    }

    // Check stop references
    for (const st of tripStopTimes) {
      if (!state.stops.some((s) => s.stop_id === st.stop_id)) {
        messages.push(msg('error', `Stop time references non-existent stop "${st.stop_id}"`, 'stop_time', t.trip_id));
      }
    }
  }

  // Fare checks
  if (state.fareAttributes.length === 0) {
    messages.push(msg('warning', 'No fare information defined — strongly recommended'));
  }
  for (const rule of state.fareRules) {
    if (rule.route_id && !state.routes.some((r) => r.route_id === rule.route_id)) {
      messages.push(msg('error', `Fare rule for fare "${rule.fare_id}" references non-existent route "${rule.route_id}"`, 'fare_rule', rule.fare_id));
    }
  }

  // Unused stops
  const usedStopIds = new Set(state.stopTimes.map((st) => st.stop_id));
  for (const s of state.stops) {
    if (!usedStopIds.has(s.stop_id) && state.stopTimes.length > 0) {
      messages.push(msg('warning', `Stop "${s.stop_name || s.stop_id}" is not used by any trip`, 'stop', s.stop_id));
    }
  }

  return messages;
}
