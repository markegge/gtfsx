import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { RailSubHeading } from '../ui/RailHeadings';
import type { Timeframe } from '../../types/gtfs';

/**
 * GTFS-Fares v2 Timeframes editor (timeframes.txt). A timeframe_group_id names
 * a time window (e.g. "peak") that may span several rows — one per
 * (start_time, end_time, service_id) slice. Leg rules reference a group via
 * from/to_timeframe_group_id. Rows are addressed by index since the group id is
 * not unique per row.
 *
 * Rows are grouped by timeframe_group_id in the UI; each row carries its own
 * start/end/service. service_id is required; start/end default to the full
 * service day when blank (per the spec).
 */
export function TimeframesEditor() {
  const timeframes = useStore((s) => s.timeframes);
  const calendars = useStore((s) => s.calendars);
  const calendarDates = useStore((s) => s.calendarDates);
  const addTimeframe = useStore((s) => s.addTimeframe);
  const updateTimeframe = useStore((s) => s.updateTimeframe);
  const removeTimeframe = useStore((s) => s.removeTimeframe);

  const [newGroupId, setNewGroupId] = useState('');

  // service_ids come from both calendar.txt and calendar_dates.txt.
  const serviceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of calendars) ids.add(c.service_id);
    for (const d of calendarDates) ids.add(d.service_id);
    return [...ids];
  }, [calendars, calendarDates]);

  // Group rows by timeframe_group_id, preserving each row's array index so
  // update/remove address the right entry.
  const groups = useMemo(() => {
    const m = new Map<string, { tf: Timeframe; index: number }[]>();
    timeframes.forEach((tf, index) => {
      const arr = m.get(tf.timeframe_group_id) ?? [];
      arr.push({ tf, index });
      m.set(tf.timeframe_group_id, arr);
    });
    return [...m.entries()];
  }, [timeframes]);

  const handleAddGroup = () => {
    const id = newGroupId.trim();
    if (!id) return;
    const defaultService = serviceIds[0] ?? '';
    addTimeframe({ timeframe_group_id: id, service_id: defaultService });
    setNewGroupId('');
  };

  const handleAddRowToGroup = (groupId: string) => {
    const defaultService = serviceIds[0] ?? '';
    addTimeframe({ timeframe_group_id: groupId, service_id: defaultService });
  };

  return (
    <div>
      <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-200">
        <p className="text-amber-700 text-sm">
          <strong>Timeframes</strong> define named time windows (e.g. peak / off-peak) that leg
          rules reference. A group can have several rows — one per time window and service. Leave
          start/end blank for the full service day.
        </p>
      </div>

      <RailSubHeading count={groups.length}>Timeframe Groups</RailSubHeading>

      {groups.length === 0 ? (
        <p className="text-[12px] text-warm-gray mb-3">
          No timeframes yet. Name a group below to start.
        </p>
      ) : (
        <div className="space-y-3 mb-4">
          {groups.map(([groupId, rows]) => (
            <div key={groupId} className="border-2 border-sand rounded-lg p-3 bg-cream/40">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="font-heading font-bold text-sm text-dark-brown truncate">{groupId}</span>
                <span className="text-[11px] text-warm-gray">{rows.length} window{rows.length > 1 ? 's' : ''}</span>
              </div>

              <div className="space-y-2">
                {rows.map(({ tf, index }) => (
                  <div key={index} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5 items-center">
                    <input
                      type="time"
                      step={1}
                      value={(tf.start_time ?? '').slice(0, 8)}
                      onChange={(e) => updateTimeframe(index, { start_time: e.target.value || undefined })}
                      title="Start time (blank = service day start)"
                      className="px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-white focus:outline-none focus:border-coral"
                    />
                    <input
                      type="time"
                      step={1}
                      value={(tf.end_time ?? '').slice(0, 8)}
                      onChange={(e) => updateTimeframe(index, { end_time: e.target.value || undefined })}
                      title="End time (blank = service day end)"
                      className="px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-white focus:outline-none focus:border-coral"
                    />
                    <select
                      value={tf.service_id}
                      onChange={(e) => updateTimeframe(index, { service_id: e.target.value })}
                      title="Service"
                      className="px-2 py-1.5 border-2 border-sand rounded-lg text-xs bg-white focus:outline-none focus:border-coral"
                    >
                      {tf.service_id && !serviceIds.includes(tf.service_id) && (
                        <option value={tf.service_id}>{tf.service_id} (missing)</option>
                      )}
                      {serviceIds.length === 0 && <option value="">No services</option>}
                      {serviceIds.map((sid) => (
                        <option key={sid} value={sid}>{sid}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeTimeframe(index)}
                      title="Remove this window"
                      className="text-warm-gray hover:text-red-500 text-xs font-bold transition-colors px-1"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <button
                onClick={() => handleAddRowToGroup(groupId)}
                className="mt-2 text-coral text-xs font-bold hover:text-[#d4603a] transition-colors"
              >
                + Add time window
              </button>
            </div>
          ))}
        </div>
      )}

      <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
        New timeframe group
      </label>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={newGroupId}
          onChange={(e) => setNewGroupId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddGroup(); }}
          placeholder="e.g. peak"
          className="flex-1 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-cream focus:outline-none focus:border-coral focus:bg-white"
        />
        <button
          onClick={handleAddGroup}
          disabled={!newGroupId.trim()}
          className="px-3 py-2 rounded-lg bg-coral text-white text-sm font-bold hover:bg-[#d4603a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add
        </button>
      </div>
    </div>
  );
}
