import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import { ApiError } from '../../services/authApi';
import { listProjectAudit, type AuditEvent } from '../../services/distributionApi';
import { AuditTable } from './AuditTable';

const PAGE_SIZE = 50;

export function ProjectAuditPanel() {
  const projectId = useStore((s) => s.activeServerProjectId);
  const currentUser = useStore((s) => s.currentUser);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const loadInitial = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    setDone(false);
    try {
      const res = await listProjectAudit(projectId, { limit: PAGE_SIZE });
      setEvents(res.events);
      if (res.events.length < PAGE_SIZE) setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  const loadMore = async () => {
    if (!projectId || events.length === 0 || done) return;
    setLoadingMore(true);
    setError(null);
    try {
      const last = events[events.length - 1];
      const res = await listProjectAudit(projectId, { limit: PAGE_SIZE, before: last.id });
      setEvents((prev) => [...prev, ...res.events]);
      if (res.events.length < PAGE_SIZE) setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more activity');
    } finally {
      setLoadingMore(false);
    }
  };

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-warm-gray">
        Activity log is only available for feeds saved to your account.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sand">
        <div className="text-sm font-heading font-semibold text-dark-brown">Activity log</div>
        <button
          onClick={loadInitial}
          disabled={loading}
          className="text-xs text-warm-gray hover:text-coral disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="mx-4 my-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && events.length === 0 ? (
          <p className="p-4 text-sm text-warm-gray">Loading…</p>
        ) : (
          <AuditTable events={events} currentUserId={currentUser?.id ?? null} />
        )}

        {events.length > 0 && !done && (
          <div className="flex justify-center py-3">
            <AuthButton variant="secondary" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </AuthButton>
          </div>
        )}
      </div>
    </div>
  );
}
