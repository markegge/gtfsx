import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { Badge } from '../ui/Badge';
import {
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  saveSnapshot,
  type ProjectSnapshot,
  type SnapshotSummary,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { runValidation } from '../../services/validation';
import { calculateSystemStats } from '../../services/costEstimation';
import { loadProjectFromServer } from '../../db/serverPersistence';

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildSummary(state: ReturnType<typeof useStore.getState>): SnapshotSummary {
  const stats = calculateSystemStats(state);

  const serviceDays = new Set<string>();
  for (const cd of state.calendarDates) {
    serviceDays.add(`${cd.service_id}:${cd.date}`);
  }
  for (const c of state.calendars) {
    const active = [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday].reduce<number>(
      (sum, v) => sum + (v ? 1 : 0),
      0,
    );
    serviceDays.add(`pattern:${c.service_id}:${active}`);
  }

  let feedStartDate: string | null = state.feedInfo?.feed_start_date ?? null;
  let feedEndDate: string | null = state.feedInfo?.feed_end_date ?? null;
  if (!feedStartDate || !feedEndDate) {
    let min: string | null = null;
    let max: string | null = null;
    for (const c of state.calendars) {
      if (c.start_date && (!min || c.start_date < min)) min = c.start_date;
      if (c.end_date && (!max || c.end_date > max)) max = c.end_date;
    }
    feedStartDate = feedStartDate || min;
    feedEndDate = feedEndDate || max;
  }

  return {
    routeCount: state.routes.length,
    stopCount: state.stops.length,
    tripCount: state.trips.length,
    serviceDayCount: serviceDays.size,
    feedStartDate,
    feedEndDate,
    revenueHoursWeekly: Math.round(stats.totalRevenueHoursWeekly * 10) / 10,
  };
}

export function SnapshotHistoryPanel() {
  const projectId = useStore((s) => s.activeServerProjectId);
  const snapshotList = useStore((s) => s.snapshotList);
  const setSnapshotList = useStore((s) => s.setSnapshotList);
  const setRestoredBanner = useStore((s) => s.setRestoredBanner);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSave, setShowSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<ProjectSnapshot | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSnapshot | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listSnapshots(projectId);
      setSnapshotList(res.snapshots);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load snapshots';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [projectId, setSnapshotList]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-warm-gray">
        Snapshots are only available for feeds saved to your account.
      </div>
    );
  }

  const handleSaveSnapshot = async (label: string) => {
    setBusy(true);
    setError(null);
    try {
      const state = useStore.getState();
      const messages = runValidation(state);
      const errors = messages.filter((m) => m.severity === 'error').length;
      const warnings = messages.filter((m) => m.severity === 'warning').length;
      const summary = buildSummary(state);

      // Build snapshot using same keys as serverPersistence
      const DATA_KEYS = [
        'agencies', 'calendars', 'calendarDates', 'routes', 'routeStops',
        'stops', 'trips', 'stopTimes', 'shapes', 'feedInfo',
        'fareAttributes', 'fareRules', 'flexZones',
        'projectId', 'projectName',
      ] as const;
      const snapshot: Record<string, unknown> = {};
      for (const key of DATA_KEYS) {
        snapshot[key] = (state as unknown as Record<string, unknown>)[key];
      }

      await saveSnapshot(projectId, {
        label: label.trim() || undefined,
        summary,
        validationErrors: errors,
        validationWarnings: warnings,
        snapshot,
      });
      setShowSave(false);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Save failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async (snapshot: ProjectSnapshot) => {
    setBusy(true);
    setError(null);
    try {
      await restoreSnapshot(projectId, snapshot.id);
      await loadProjectFromServer(projectId);
      setRestoreTarget(null);
      setRestoredBanner(
        `Snapshot ${snapshot.label ? `"${snapshot.label}"` : snapshot.id.slice(0, 8)} restored — local changes have been replaced.`,
      );
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Restore failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (snapshot: ProjectSnapshot) => {
    setBusy(true);
    setError(null);
    try {
      await deleteSnapshot(projectId, snapshot.id);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Delete failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sand">
        <div className="text-sm font-heading font-semibold text-dark-brown">Saved snapshots</div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="text-xs text-warm-gray hover:text-coral disabled:opacity-50"
            title="Refresh"
          >
            Refresh
          </button>
          <AuthButton onClick={() => setShowSave(true)} disabled={busy}>
            Save snapshot
          </AuthButton>
        </div>
      </div>

      {error && (
        <div className="mx-4 my-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && snapshotList.length === 0 ? (
          <div className="p-4 text-sm text-warm-gray">Loading…</div>
        ) : snapshotList.length === 0 ? (
          <div className="p-4 text-sm text-warm-gray">
            No saved snapshots yet. Click "Save snapshot" to capture the current feed.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-cream/80 backdrop-blur">
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray">
                <th className="px-4 py-2">Label</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Routes</th>
                <th className="px-3 py-2">Stops</th>
                <th className="px-3 py-2">Trips</th>
                <th className="px-3 py-2">Validation</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {snapshotList.map((v) => {
                const summary = v.summary ?? {};
                return (
                  <tr key={v.id} className="border-t border-sand">
                    <td className="px-4 py-2 font-medium text-dark-brown">
                      {v.label || <span className="text-warm-gray italic">untitled</span>}
                    </td>
                    <td className="px-3 py-2 text-warm-gray whitespace-nowrap">{formatDate(v.createdAt)}</td>
                    <td className="px-3 py-2 text-dark-brown">{(summary.routeCount as number) ?? '—'}</td>
                    <td className="px-3 py-2 text-dark-brown">{(summary.stopCount as number) ?? '—'}</td>
                    <td className="px-3 py-2 text-dark-brown">{(summary.tripCount as number) ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        {v.validationErrors > 0 && (
                          <Badge variant="error">{v.validationErrors} errors</Badge>
                        )}
                        {v.validationWarnings > 0 && (
                          <Badge variant="warning">{v.validationWarnings} warn</Badge>
                        )}
                        {v.validationErrors === 0 && v.validationWarnings === 0 && (
                          <Badge variant="success">Clean</Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        className="text-xs text-coral hover:underline mr-3"
                        onClick={() => setRestoreTarget(v)}
                      >
                        Restore
                      </button>
                      <button
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => setDeleteTarget(v)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showSave && <SaveSnapshotDialog onSave={handleSaveSnapshot} onCancel={() => setShowSave(false)} busy={busy} />}

      {restoreTarget && (
        <ConfirmModal
          title="Restore this snapshot?"
          body={`This will replace your current working draft with "${restoreTarget.label || restoreTarget.id.slice(0, 8)}". Your current draft will be lost unless you save it as a snapshot first.`}
          confirmLabel="Restore"
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => handleRestore(restoreTarget)}
          busy={busy}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete snapshot?"
          body={`"${deleteTarget.label || deleteTarget.id.slice(0, 8)}" will be permanently removed.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
          busy={busy}
        />
      )}
    </div>
  );
}

function defaultSnapshotLabel(): string {
  // Locale-formatted "May 28, 2026, 8:00 AM" — sortable by date, readable
  // at a glance, and instantly meaningful for the common "I'm just
  // snapshotting today's state" workflow.
  return new Date().toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function SaveSnapshotDialog({
  onSave,
  onCancel,
  busy,
}: {
  onSave: (label: string) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  // Default the label to today's date+time so the field is never empty —
  // user can hit Save immediately for a date-stamped snapshot, or type
  // over the pre-selected text for a custom label.
  const [label, setLabel] = useState(defaultSnapshotLabel);
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">Save snapshot</h3>
        <p className="text-sm text-warm-gray mb-3">
          Captures the current feed state. Snapshots are immutable once saved.
        </p>
        <FormField
          label="Label"
          value={label}
          onChange={setLabel}
          placeholder="e.g. March 2026 service change"
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton onClick={() => onSave(label)} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
  danger,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-sm mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">{title}</h3>
        <p className="text-sm text-warm-gray mb-5">{body}</p>
        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}
