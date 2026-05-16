import { useCallback, useEffect, useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { AuthButton } from '../auth/AuthButton';
import { ErrorBanner } from './adminShared';
import { formatDateTime } from './adminFormat';
import {
  auditCsvUrl,
  listAuditEvents,
  type AdminAuditEvent,
  type AdminAuditFilters,
} from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

const SUBJECT_TYPES = ['', 'user', 'org', 'project', 'snapshot', 'publication', 'session'];

function toEpochOrUndef(datetimeLocal: string): number | undefined {
  if (!datetimeLocal) return undefined;
  const ms = new Date(datetimeLocal).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function AdminAuditPage() {
  const [actorUserId, setActorUserId] = useState('');
  const [subjectType, setSubjectType] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [applied, setApplied] = useState<AdminAuditFilters>({});
  const [page, setPage] = useState(1);
  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAuditEvents({ ...applied, page, pageSize: 50 });
      setEvents(res.events);
      setHasNext(res.hasNext);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [applied, page]);

  useEffect(() => {
    load();
  }, [load]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const next: AdminAuditFilters = {};
    if (actorUserId.trim()) next.actorUserId = actorUserId.trim();
    if (subjectType) next.subjectType = subjectType;
    if (subjectId.trim()) next.subjectId = subjectId.trim();
    if (action.trim()) next.action = action.trim();
    const fromMs = toEpochOrUndef(from);
    const toMs = toEpochOrUndef(to);
    if (fromMs !== undefined) next.from = fromMs;
    if (toMs !== undefined) next.to = toMs;
    setApplied(next);
    setPage(1);
  };

  const resetFilters = () => {
    setActorUserId('');
    setSubjectType('');
    setSubjectId('');
    setAction('');
    setFrom('');
    setTo('');
    setApplied({});
    setPage(1);
  };

  return (
    <AdminLayout
      title="Audit log"
      subtitle="All admin and security-relevant events. Newest first. 50 per page."
      headerExtra={
        <a
          href={auditCsvUrl(applied)}
          download="audit.csv"
          className="px-4 py-2.5 rounded-lg font-heading font-bold text-sm bg-coral text-white hover:bg-[#d4603a] transition-colors inline-flex items-center"
        >
          Download CSV
        </a>
      }
    >
      <form
        onSubmit={apply}
        className="bg-white border border-sand rounded-2xl p-4 mb-5 grid grid-cols-1 md:grid-cols-3 gap-3"
      >
        <label className="block">
          <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Actor user id
          </span>
          <input
            value={actorUserId}
            onChange={(e) => setActorUserId(e.target.value)}
            placeholder="user id"
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Subject type
          </span>
          <select
            value={subjectType}
            onChange={(e) => setSubjectType(e.target.value)}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          >
            {SUBJECT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t || 'Any'}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Subject id
          </span>
          <input
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            placeholder="optional id"
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Action
          </span>
          <input
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. admin.user.patch"
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            From
          </span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            To
          </span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          />
        </label>
        <div className="md:col-span-3 flex gap-2 justify-end">
          <AuthButton type="button" variant="secondary" onClick={resetFilters}>
            Reset
          </AuthButton>
          <AuthButton type="submit">Apply filters</AuthButton>
        </div>
      </form>

      <ErrorBanner>{error}</ErrorBanner>

      <div className="bg-white border border-sand rounded-2xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-cream text-left text-[11px] uppercase tracking-wide text-warm-gray font-semibold">
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Subject</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Metadata</th>
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
            {!loading && events.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-warm-gray">
                  No events match the filters.
                </td>
              </tr>
            )}
            {!loading &&
              events.map((e) => (
                <tr key={e.id} className="border-t border-sand hover:bg-cream/40 align-top">
                  <td className="px-4 py-3 text-warm-gray whitespace-nowrap">
                    {formatDateTime(e.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-dark-brown font-mono text-xs whitespace-nowrap">
                    {e.action}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {e.actorEmail ? (
                      <span className="text-dark-brown">{e.actorEmail}</span>
                    ) : (
                      <span className="text-warm-gray">—</span>
                    )}
                    {e.actorUserId && (
                      <div className="text-[10px] text-warm-gray font-mono">
                        {e.actorUserId.slice(0, 8)}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-warm-gray">
                    {e.subjectType}
                    {e.subjectId && (
                      <div className="text-[10px] font-mono">{e.subjectId.slice(0, 8)}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-warm-gray">
                    {e.ip || '—'}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-warm-gray max-w-[360px] break-words">
                    {e.metadataJson || '—'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm">
        <div className="text-warm-gray">Page {page}</div>
        <div className="flex gap-2">
          <AuthButton
            variant="secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
          >
            Previous
          </AuthButton>
          <AuthButton
            variant="secondary"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext || loading}
          >
            Next
          </AuthButton>
        </div>
      </div>
    </AdminLayout>
  );
}
