import { useState } from 'react';
import { useStore } from '../../store';

const TRANSFER_TYPE_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: 'Recommended',
  1: 'Timed (vehicle waits)',
  2: 'Minimum time required',
  3: 'Not possible',
};

/**
 * transfers.txt editor.
 *
 * Each row links two stop_ids (which may be the same — a same-stop transfer
 * encodes the connect window between vessels arriving at one terminal, the
 * pattern BC Ferries uses for its 45-minute load/unload buffer). When
 * transfer_type=2 the min_transfer_time field is required by the spec.
 */
export function TransfersEditor() {
  const transfers = useStore((s) => s.transfers);
  const stops = useStore((s) => s.stops);
  const addTransfer = useStore((s) => s.addTransfer);
  const updateTransfer = useStore((s) => s.updateTransfer);
  const removeTransfer = useStore((s) => s.removeTransfer);

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const stopOptions = [...stops]
    .sort((a, b) => a.stop_name.localeCompare(b.stop_name))
    .map((s) => ({ value: s.stop_id, label: s.stop_name || s.stop_id }));

  const handleAdd = () => {
    const first = stops[0]?.stop_id || '';
    addTransfer({
      from_stop_id: first,
      to_stop_id: first,
      transfer_type: 2,
      min_transfer_time: 300,
    });
  };

  const stopName = (id: string) =>
    stops.find((s) => s.stop_id === id)?.stop_name || id || '—';

  return (
    <div>
      {stops.length === 0 && (
        <div className="mb-4 p-3 rounded-lg bg-gold-light border-2 border-amber-300">
          <p className="text-amber-700 text-sm font-semibold">
            Add at least one stop before defining transfers.
          </p>
        </div>
      )}

      {transfers.length === 0 ? (
        <div className="mb-3 p-4 rounded-lg bg-cream text-sm text-warm-gray">
          No transfers defined. Add one to describe connection times between
          stops — useful for same-terminal load/unload windows on ferry feeds.
        </div>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {transfers.map((t, idx) => {
            const isCollapsed = collapsed.has(idx);
            const summary = t.from_stop_id === t.to_stop_id
              ? `Same-stop: ${stopName(t.from_stop_id)}`
              : `${stopName(t.from_stop_id)} → ${stopName(t.to_stop_id)}`;
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
                    {summary}
                  </span>
                  <span className="text-[11px] text-warm-gray whitespace-nowrap">
                    {TRANSFER_TYPE_LABELS[t.transfer_type]}
                    {t.transfer_type === 2 && t.min_transfer_time !== undefined && (
                      <> · {Math.round(t.min_transfer_time / 60)} min</>
                    )}
                  </span>
                  <span className="text-warm-gray text-xs">{isCollapsed ? '▸' : '▾'}</span>
                </button>
                {!isCollapsed && (
                  <div className="px-3 py-3 border-t border-sand grid grid-cols-2 gap-2">
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      From stop
                      <select
                        value={t.from_stop_id}
                        onChange={(e) => updateTransfer(idx, { from_stop_id: e.target.value })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {stopOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
                      To stop
                      <select
                        value={t.to_stop_id}
                        onChange={(e) => updateTransfer(idx, { to_stop_id: e.target.value })}
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {stopOptions.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide col-span-2">
                      Transfer type
                      <select
                        value={t.transfer_type}
                        onChange={(e) =>
                          updateTransfer(idx, {
                            transfer_type: Number(e.target.value) as 0 | 1 | 2 | 3,
                          })
                        }
                        className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream"
                      >
                        {Object.entries(TRANSFER_TYPE_LABELS).map(([v, label]) => (
                          <option key={v} value={v}>{label}</option>
                        ))}
                      </select>
                    </label>
                    {t.transfer_type === 2 && (
                      <label className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide col-span-2">
                        Min transfer time (minutes)
                        <input
                          type="number"
                          min={0}
                          value={
                            t.min_transfer_time === undefined
                              ? ''
                              : Math.round(t.min_transfer_time / 60)
                          }
                          onChange={(e) => {
                            const minutes = Number(e.target.value);
                            updateTransfer(idx, {
                              min_transfer_time: Number.isFinite(minutes) ? minutes * 60 : undefined,
                            });
                          }}
                          className="mt-1 w-full px-2 py-1.5 border border-sand rounded-md text-sm bg-cream tabular-nums"
                        />
                      </label>
                    )}
                    <button
                      onClick={() => removeTransfer(idx)}
                      className="col-span-2 mt-1 text-[11px] text-red-400 hover:text-red-600 text-left"
                    >
                      Delete transfer
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
        disabled={stops.length === 0}
        className="w-full px-4 py-2 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-40"
      >
        + Add Transfer
      </button>
    </div>
  );
}
