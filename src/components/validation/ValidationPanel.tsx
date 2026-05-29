import { useMemo } from 'react';
import { useStore } from '../../store';
import { runValidation } from '../../services/validation';
import { Badge } from '../ui/Badge';

export function ValidationPanel() {
  const state = useStore();
  // Depend on the specific entity slices the validator reads; `state` as a
  // whole would re-trigger on every unrelated store change (UI state,
  // selection, etc.). Listing the slices is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => runValidation(state), [
    state.agencies, state.calendars, state.calendarDates,
    state.routes, state.stops, state.trips, state.stopTimes, state.shapes,
  ]);

  const errors = messages.filter((m) => m.severity === 'error');
  const warnings = messages.filter((m) => m.severity === 'warning');

  const handleClick = (m: typeof messages[0]) => {
    if (m.entity_type === 'agency') state.setSidebarSection('agency');
    else if (m.entity_type === 'calendar') state.setSidebarSection('calendar');
    else if (m.entity_type === 'route') {
      state.setSidebarSection('routes');
      if (m.entity_id) state.selectRoute(m.entity_id);
    }
    else if (m.entity_type === 'stop') {
      state.setSidebarSection('stops');
      if (m.entity_id) state.selectStop(m.entity_id);
    }
    else if (m.entity_type === 'trip' || m.entity_type === 'stop_time') {
      // Timetable lives in the bottom panel now; the right rail no longer
      // hosts it. Surface the bottom panel on the timetable tab and pre-select
      // the route AND the trip's service + direction (+ shape pattern) so the
      // grid opens on exactly the cell the issue is about, not just the route.
      state.setBottomPanelOpen(true);
      state.setBottomPanelTab('timetable');
      if (m.entity_id) {
        const trip = state.trips.find((t) => t.trip_id === m.entity_id);
        if (trip) {
          state.selectRoute(trip.route_id);
          state.setTimetableServiceId(trip.service_id);
          state.setTimetableDirectionId(trip.direction_id);
          if (trip.shape_id) state.setTimetableShapeId(trip.shape_id);
        }
      }
    }
  };

  return (
    <div className="p-2 h-full overflow-y-auto min-h-0">
      <div className="flex items-center gap-2 px-2 mb-2 sticky top-0 bg-white py-1 z-10">
        <span className="font-heading font-bold text-sm">Validation</span>
        {errors.length > 0 && <Badge variant="error">{errors.length} Errors</Badge>}
        {warnings.length > 0 && <Badge variant="warning">{warnings.length} Warnings</Badge>}
        {messages.length === 0 && <Badge variant="success">All good</Badge>}
      </div>

      {messages.length === 0 ? (
        <p className="text-sm text-warm-gray px-2">No issues found. Your feed looks good!</p>
      ) : (
        <div className="flex flex-col">
          {messages.map((m) => (
            <button
              key={m.id}
              onClick={() => handleClick(m)}
              className="flex items-start gap-3 px-3 py-2.5 hover:bg-cream transition-colors text-left border-b border-[#F5F0EB]"
            >
              <Badge variant={m.severity === 'error' ? 'error' : 'warning'}>
                {m.severity === 'error' ? 'Error' : 'Warn'}
              </Badge>
              <div>
                <p className="text-[13px] text-dark-brown">{m.message}</p>
                {m.entity_type && (
                  <p className="text-[11px] text-warm-gray mt-0.5">
                    {m.entity_type} {m.entity_id ? `→ ${m.entity_id}` : ''} · Click to view
                  </p>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
