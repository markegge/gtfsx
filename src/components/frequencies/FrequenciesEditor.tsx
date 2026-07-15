import { useState } from 'react';
import { useStore } from '../../store';
import { normalizeTimeInput } from '../../utils/time';

/**
 * frequencies.txt editor — headway-based (frequency) service. A trip listed
 * here runs every `headway_secs` between start_time and end_time instead of on
 * fixed clock times; its stop_times act as the single reference run. A trip can
 * have several non-overlapping windows (e.g. peak vs midday headways).
 *
 * Times accept HH:MM:SS and may cross midnight — enter post-midnight times as
 * "+1 04:30" (validation flags overlaps / end≤start / headway≤0).
 */
export function FrequenciesEditor() {
  const frequencies = useStore((s) => s.frequencies);
  const trips = useStore((s) => s.trips);
  const routes = useStore((s) => s.routes);
  const addFrequency = useStore((s) => s.addFrequency);
  const updateFrequency = useStore((s) => s.updateFrequency);
  const removeFrequency = useStore((s) => s.removeFrequency);

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const tripLabel = (tripId: string) => {
    const t = trips.find((x) => x.trip_id === tripId);
    if (!t) return tripId;
    const r = routes.find((rr) => rr.route_id === t.route_id);
    const rn = r?.route_short_name || r?.route_long_name || t.route_id;
    return `${rn} · ${t.trip_headsign || t.trip_id}`;
  };
  const tripOptions = [...trips]
    .map((t) => ({ value: t.trip_id, label: tripLabel(t.trip_id) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const handleAdd = () => {
    const first = trips[0]?.trip_id || '';
    addFrequency({ trip_id: first, start_time: '06:00:00', end_time: '22:00:00', headway_secs: 600 });
  };

  // Normalize on blur; keep the prior value if the input can't be parsed.
  const onTimeBlur = (idx: number, field: 'start_time' | 'end_time', raw: string, prev: string) => {
    const norm = normalizeTimeInput(raw);
    updateFrequency(idx, { [field]: norm || prev });
  };

  return (
    <div>
      {trips.length === 0 && (
        <div className="mb-3 p-3 rounded-lg bg-gold-light border-2 border-amber-300">
          <p className="text-amber-700 text-sm font-semibold">
            Add trips first — a frequency window applies to an existing trip.
          </p>
        </div>
      )}

      {frequencies.length === 0 ? (
        <div className="mb-3 p-4 rounded-lg bg-cream text-sm text-warm-gray">
          No headway-based service defined. Add a window to run a trip every N minutes
          between a start and end time, instead of listing every clock departure.
        </div>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {frequencies.map((f, idx) => {
            const isCollapsed = collapsed.has(idx);
            const mins = f.headway_secs > 0 ? Math.round((f.headway_secs / 60) * 10) / 10 : 0;
            return (
              <div key={idx} className="border border-sand rounded-lg bg-white">
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-cream"
                  onClick={() => {
                    const next = new Set(collapsed);
                    if (isCollapsed) next.delete(idx); else next.add(idx);
                    setCollapsed(next);
                  }}
                >
                  <span className="font-semibold text-dark-brown text-sm flex-1 truncate">
                    {tripLabel(f.trip_id)}
                  </span>
                  <span className="text-[11px] text-warm-gray whitespace-nowrap tabular-nums">
                    {f.start_time.slice(0, 5)}–{f.end_time.slice(0, 5)} · every {mins} min
                  </span>
                  <span className="text-warm-gray text-xs">{isCollapsed ? '▸' : '▾'}</span>
                </button>
                {!isCollapsed && (
                  <div className="px-3 py-3 border-t border-sand grid grid-cols-2 gap-2">
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide col-span-2">
                      Trip
                      <select
                        value={f.trip_id}
                        onChange={(e) => updateFrequency(idx, { trip_id: e.target.value })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {tripOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Start time
                      <input
                        defaultValue={f.start_time}
                        key={`start-${idx}-${f.start_time}`}
                        onBlur={(e) => onTimeBlur(idx, 'start_time', e.target.value, f.start_time)}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream font-mono tabular-nums"
                      />
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      End time
                      <input
                        defaultValue={f.end_time}
                        key={`end-${idx}-${f.end_time}`}
                        onBlur={(e) => onTimeBlur(idx, 'end_time', e.target.value, f.end_time)}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream font-mono tabular-nums"
                      />
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Headway (seconds)
                      <input
                        type="number"
                        min={1}
                        value={f.headway_secs}
                        onChange={(e) => updateFrequency(idx, { headway_secs: Number(e.target.value) })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream tabular-nums"
                      />
                      <span className="mt-0.5 block text-[10px] normal-case font-normal text-warm-gray">≈ {mins} min</span>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      Type
                      <select
                        value={f.exact_times ?? 0}
                        onChange={(e) => {
                          const v = Number(e.target.value) as 0 | 1;
                          updateFrequency(idx, { exact_times: v === 1 ? 1 : undefined });
                        }}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        <option value={0}>Frequency-based</option>
                        <option value={1}>Schedule-based (exact)</option>
                      </select>
                    </label>
                    <button
                      onClick={() => removeFrequency(idx)}
                      className="col-span-2 mt-1 text-[11px] text-red-400 hover:text-red-600 text-left"
                    >
                      Delete window
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={handleAdd}
        disabled={trips.length === 0}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 border-2 border-dashed border-sand rounded-lg text-sm font-semibold text-warm-gray hover:border-coral hover:text-coral hover:bg-coral-light transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-sand disabled:hover:text-warm-gray disabled:hover:bg-transparent"
      >
        + Add headway window
      </button>
    </div>
  );
}
