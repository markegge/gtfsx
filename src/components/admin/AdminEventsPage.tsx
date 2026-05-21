import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { AuthButton } from '../auth/AuthButton';
import { ErrorBanner } from './adminShared';
import {
  getEventsSummary,
  type AdminEventsSummaryRow,
  type AdminEventsSummaryTotals,
} from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

type Preset = '7d' | '30d' | 'all' | 'custom';

function presetWindow(preset: Preset): { from?: number; to?: number } {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (preset === '7d') return { from: now - 7 * day, to: now };
  if (preset === '30d') return { from: now - 30 * day, to: now };
  return {};
}

// Convert unix-ms to the value <input type="date"> expects (YYYY-MM-DD), in
// the user's local timezone.
function msToDateInput(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateInputToMs(value: string, end: boolean): number | undefined {
  if (!value) return undefined;
  // Interpret as local midnight; for `end`, snap to 23:59:59.999.
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  const date = new Date(y, m - 1, d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function AdminEventsPage() {
  const [preset, setPreset] = useState<Preset>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [rows, setRows] = useState<AdminEventsSummaryRow[]>([]);
  const [totals, setTotals] = useState<AdminEventsSummaryTotals>({
    visits: 0,
    pageViews: 0,
    editorSessions: 0,
    exports: 0,
    paywallViews: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWindow = useMemo(() => {
    if (preset === 'custom') {
      return {
        from: dateInputToMs(customFrom, false),
        to: dateInputToMs(customTo, true),
      };
    }
    return presetWindow(preset);
  }, [preset, customFrom, customTo]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getEventsSummary(activeWindow);
      setRows(res.rows);
      setTotals(res.totals);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [activeWindow]);

  useEffect(() => {
    // For preset windows, load immediately. For custom, only load when both
    // dates are provided — otherwise the window is open-ended and confusing.
    if (preset !== 'custom') {
      load();
      return;
    }
    if (customFrom && customTo) {
      load();
    }
  }, [load, preset, customFrom, customTo]);

  // Default custom range to "today − 7 days … today" the first time the user
  // switches to it, so they have a sensible starting point.
  useEffect(() => {
    if (preset !== 'custom') return;
    if (customFrom || customTo) return;
    const now = Date.now();
    setCustomFrom(msToDateInput(now - 7 * 24 * 60 * 60 * 1000));
    setCustomTo(msToDateInput(now));
  }, [preset, customFrom, customTo]);

  const totalRefs = rows.length;

  return (
    <AdminLayout
      title="Events"
      subtitle="Cookieless funnel analytics — visits, editor sessions, exports, and paywall views by inbound referral tag (?ref=)."
    >
      <div className="bg-white border border-sand rounded-2xl p-4 mb-5 flex flex-wrap items-end gap-3">
        <div className="flex gap-1 p-1 bg-cream rounded-lg">
          {(['7d', '30d', 'all', 'custom'] as Preset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPreset(p)}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
                preset === p
                  ? 'bg-coral text-white'
                  : 'text-warm-gray hover:text-dark-brown'
              }`}
            >
              {p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : p === 'all' ? 'All time' : 'Custom'}
            </button>
          ))}
        </div>

        {preset === 'custom' && (
          <>
            <label className="block">
              <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                From
              </span>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                To
              </span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
              />
            </label>
          </>
        )}

        <div className="ml-auto">
          <AuthButton variant="secondary" onClick={load} disabled={loading}>
            Refresh
          </AuthButton>
        </div>
      </div>

      <ErrorBanner>{error}</ErrorBanner>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        <SummaryCard label="Visits" value={totals.visits} />
        <SummaryCard label="Editor sessions" value={totals.editorSessions} />
        <SummaryCard label="Feeds exported" value={totals.exports} />
        <SummaryCard label="Paywall views" value={totals.paywallViews} />
        <SummaryCard label="Page views" value={totals.pageViews} />
      </div>

      <div className="bg-white border border-sand rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
              <th className="px-4 py-3">Referral (ref)</th>
              <th className="px-4 py-3 text-right">Visits</th>
              <th className="px-4 py-3 text-right">Editor</th>
              <th className="px-4 py-3 text-right">Exports</th>
              <th className="px-4 py-3 text-right">Paywall</th>
              <th className="px-4 py-3 text-right">Page views</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-warm-gray">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-warm-gray">
                  No events in this window.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((row) => (
                <tr
                  key={row.ref ?? '__direct__'}
                  className="border-t border-sand hover:bg-cream/40"
                >
                  <td className="px-4 py-3 text-dark-brown">
                    {row.ref ? (
                      <span className="font-mono text-xs">{row.ref}</span>
                    ) : (
                      <span className="text-warm-gray italic">direct / no ref</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-dark-brown font-semibold tabular-nums">
                    {row.visits.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-dark-brown tabular-nums">
                    {row.editorSessions.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-dark-brown tabular-nums">
                    {row.exports.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-dark-brown tabular-nums">
                    {row.paywallViews.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-warm-gray tabular-nums">
                    {row.pageViews.toLocaleString()}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-warm-gray leading-relaxed">
        Across {totalRefs.toLocaleString()} referral {totalRefs === 1 ? 'source' : 'sources'} in this window.
        A <strong>visit</strong> is a distinct browser session (per tab); <strong>editor</strong> counts
        sessions that opened the editor; <strong>exports</strong> and <strong>paywall</strong> views are raw
        event counts; <strong>page views</strong> is every route change. Inbound refs are captured from{' '}
        <code className="font-mono">?ref=…</code> on the first request of each session and persist
        for the rest of that session.
      </p>
    </AdminLayout>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white border border-sand rounded-2xl px-5 py-4">
      <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
        {label}
      </div>
      <div className="mt-1 text-2xl font-heading font-extrabold text-dark-brown tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
