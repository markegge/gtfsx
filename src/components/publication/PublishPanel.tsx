import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import { Badge } from '../ui/Badge';
import {
  fetchSnapshotState,
  getPublicationHistory,
  listSnapshots,
  publishProject,
  rollbackPublication,
  unpublishProject,
  schedulePublish,
  cancelScheduledPublish,
  type ProjectSnapshot,
  type PublicationInfo,
  type ScheduledPublishInfo,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { exportGtfsZip } from '../../services/gtfsExport';
import { applySnapshotToStore, buildSnapshot } from '../../db/serverPersistence';
import { DraftLinksSection, toEditorDeepLink } from './DraftLinksPanel';
import { NtdP50Panel } from './NtdP50Panel';

// SPDX identifiers publishers actually use for open transit data. "Leave unset"
// is a first-class choice — we never guess a license on someone's behalf.
const LICENSE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Not specified' },
  { value: 'CC0-1.0', label: 'CC0 1.0 — public domain dedication' },
  { value: 'CC-BY-4.0', label: 'CC BY 4.0 — attribution' },
  { value: 'ODbL-1.0', label: 'ODbL 1.0 — open database, share-alike' },
];

// Env-aware public feeds origin (mirrors EmbedPanel): staging publishes to
// staging-feeds.gtfsx.com, prod to feeds.gtfsx.com. Used for the canonical-URL
// fallback when the /history response omits it.
const FEEDS_ORIGIN =
  (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
  (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
    ? 'https://staging-feeds.gtfsx.com'
    : 'https://feeds.gtfsx.com');

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

// epoch ms ↔ <input type="datetime-local"> value (browser-local), mirroring
// the helpers in AlertsEditor but in milliseconds (publication timestamps are ms).
function toLocalDatetimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalDatetimeInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Swap store to the given snapshot's saved state, run the exporter, then restore.
// Auto-save may fire a redundant save of the restored state (harmless — same
// bytes as what the server already holds).
async function renderSnapshotZip(projectId: string, snapshotId: string): Promise<Blob> {
  const snapshotBefore = buildSnapshot();
  const snapshotState = await fetchSnapshotState(projectId, snapshotId);
  try {
    applySnapshotToStore(snapshotState);
    return await exportGtfsZip();
  } finally {
    applySnapshotToStore(snapshotBefore);
  }
}

type BannerKind = 'success' | 'error' | 'info';
interface Banner {
  kind: BannerKind;
  message: string;
  url?: string;
}

interface RemovedIds {
  agencies?: string[];
  routes?: string[];
  stops?: string[];
  trips?: string[];
}

/** Acknowledgements the user has already given for this publish attempt. */
interface IgnoreFlags {
  ignoreRtBreakage?: boolean;
  ignoreAgencyChurn?: boolean;
}

// Publishing now and scheduling a publish trip the SAME two 409 gates
// (rt_breakage, agency_id_churn) against the same baseline — the server runs one
// shared check for both. So both are modelled as one retryable action: a gate
// 409 parks the action, the modal collects the acknowledgement, and we replay the
// action verbatim with the extra flag. For a schedule, the acknowledgement is
// persisted server-side and replayed by the cron at fire time — which is the
// whole point: at fire time the user is asleep and cannot acknowledge anything.
type PendingAction =
  | { kind: 'publish'; snapshotId: string; flags: IgnoreFlags }
  | { kind: 'schedule'; snapshotId: string; scheduledFor: number; flags: IgnoreFlags };

function withFlag(action: PendingAction, flag: keyof IgnoreFlags): PendingAction {
  const flags: IgnoreFlags = { ...action.flags, [flag]: true };
  return action.kind === 'publish' ? { ...action, flags } : { ...action, flags };
}

/** Ack suffixes, shared by the publish + schedule success banners. */
function ackNotes(flags: IgnoreFlags): string[] {
  const notes: string[] = [];
  if (flags.ignoreRtBreakage) notes.push('GTFS-RT breakage acknowledged.');
  if (flags.ignoreAgencyChurn) {
    notes.push('agency_id change acknowledged — update your NTD P-50 crosswalk.');
  }
  return notes;
}

export function PublishPanel() {
  const projectId = useStore((s) => s.activeServerProjectId);
  const snapshotList = useStore((s) => s.snapshotList);
  const setSnapshotList = useStore((s) => s.setSnapshotList);
  const publicationHistory = useStore((s) => s.publicationHistory);
  const currentPublication = useStore((s) => s.currentPublication);
  const setPublicationHistory = useStore((s) => s.setPublicationHistory);
  const setCurrentPublication = useStore((s) => s.setCurrentPublication);
  // The license lives in the editor's feed state (the source of truth) — the
  // server column is only a projection written at publish. It is editable
  // outside this panel too, so it must not be mirrored into local component
  // state. (An agency's NTD / external ID lives on the Agency entity and is
  // edited in the Agency panel — see NtdP50Panel below, which reads it.)
  const licenseSpdx = useStore((s) => s.licenseSpdx);
  const setLicenseSpdx = useStore((s) => s.setLicenseSpdx);
  const feedsProjects = useStore((s) => s.feedsProjects);

  const [loading, setLoading] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [ignoreWarnings, setIgnoreWarnings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unpublishConfirm, setUnpublishConfirm] = useState(false);
  const [rtBreakage, setRtBreakage] = useState<{
    removed: RemovedIds;
    action: PendingAction;
  } | null>(null);
  const [agencyChurn, setAgencyChurn] = useState<{
    agencies: string[];
    action: PendingAction;
  } | null>(null);
  const [publishErrors, setPublishErrors] = useState<string[] | null>(null);
  const [scheduled, setScheduled] = useState<ScheduledPublishInfo | null>(null);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const activeProject = feedsProjects.find((p) => p.id === projectId) ?? null;

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setBanner(null);
    try {
      const [snapshotsRes, historyRes] = await Promise.all([
        listSnapshots(projectId),
        getPublicationHistory(projectId),
      ]);
      setSnapshotList(snapshotsRes.snapshots);
      setPublicationHistory(historyRes.history);
      setCurrentPublication(historyRes.current);
      setScheduled(historyRes.scheduled);
      if (!selectedSnapshotId && snapshotsRes.snapshots.length > 0) {
        setSelectedSnapshotId(snapshotsRes.snapshots[0].id);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load publication info';
      setBanner({ kind: 'error', message: msg });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, setSnapshotList, setPublicationHistory, setCurrentPublication]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectedSnapshot = useMemo(
    () => snapshotList.find((v) => v.id === selectedSnapshotId) ?? null,
    [snapshotList, selectedSnapshotId],
  );

  if (!projectId) {
    return (
      <div className="p-4 text-sm text-warm-gray">
        Publishing is only available for feeds saved to your account.
      </div>
    );
  }

  // One path for every entry point — publish now, schedule for later, and the
  // "…anyway" retries after an rt_breakage or agency_id_churn acknowledgement.
  // `action.flags` carries the acks accumulated so far, so acking one gate and
  // then tripping the other keeps the first ack.
  const runAction = async (action: PendingAction) => {
    if (!projectId) return;
    setBusy(true);
    setBanner(null);
    setPublishErrors(null);
    setRtBreakage(null);
    setAgencyChurn(null);
    try {
      // Render the ZIP now, for both paths: the cron has no client to render at
      // fire time, so a scheduled publish's bytes are captured at schedule time.
      const zip = await renderSnapshotZip(projectId, action.snapshotId);
      if (action.kind === 'publish') {
        const result = await publishProject(projectId, {
          snapshotId: action.snapshotId,
          ignoreWarnings: ignoreWarnings || undefined,
          ...action.flags,
          // Project the feed's license onto the publication so feed_info.json and
          // dmfr.json can carry it.
          licenseSpdx: licenseSpdx ?? null,
          zip,
        });
        setBanner({
          kind: 'success',
          message: ['Feed published.', ...ackNotes(action.flags)].join(' '),
          url: result.publication.canonicalUrl,
        });
      } else {
        await schedulePublish(projectId, {
          snapshotId: action.snapshotId,
          scheduledFor: action.scheduledFor,
          ignoreWarnings: ignoreWarnings || undefined,
          // Persisted on the scheduled row and replayed by the cron at fire time.
          ...action.flags,
          zip,
        });
        setBanner({
          kind: 'success',
          message: [
            `Scheduled to publish on ${formatDate(action.scheduledFor)}.`,
            ...ackNotes(action.flags),
          ].join(' '),
        });
        setScheduleMode(false);
        setScheduleAt('');
      }
      setIgnoreWarnings(false);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        const code = err.code as string;
        const removed = (err.extra?.removed ?? {}) as RemovedIds;
        if (code === 'rt_breakage') {
          setRtBreakage({ removed, action });
        } else if (code === 'agency_id_churn') {
          setAgencyChurn({ agencies: removed.agencies ?? [], action });
        } else if (code === 'validation_failed') {
          const issues = (err.extra?.issues as unknown[]) ?? [];
          const errList: string[] = [err.message];
          if (Array.isArray(issues)) {
            for (const i of issues) {
              const m = (i as { message?: string })?.message;
              if (m) errList.push(m);
            }
          }
          setPublishErrors(errList);
        } else {
          setBanner({ kind: 'error', message: err.message });
        }
      } else {
        setBanner({
          kind: 'error',
          message: action.kind === 'publish' ? 'Publish failed' : 'Could not schedule publish',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const handlePublish = async () => {
    if (!selectedSnapshot) return;
    await runAction({ kind: 'publish', snapshotId: selectedSnapshot.id, flags: {} });
  };

  const handleIgnoreRtBreakage = async () => {
    if (!rtBreakage) return;
    await runAction(withFlag(rtBreakage.action, 'ignoreRtBreakage'));
  };

  const handleIgnoreAgencyChurn = async () => {
    if (!agencyChurn) return;
    await runAction(withFlag(agencyChurn.action, 'ignoreAgencyChurn'));
  };

  const handleUnpublish = async () => {
    if (!projectId) return;
    setBusy(true);
    setBanner(null);
    try {
      await unpublishProject(projectId);
      setUnpublishConfirm(false);
      setBanner({ kind: 'info', message: 'Feed unpublished. The canonical URL now returns 404.' });
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Unpublish failed';
      setBanner({ kind: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async (snapshotId: string) => {
    if (!projectId) return;
    setBusy(true);
    setBanner(null);
    try {
      let result: { publication: PublicationInfo };
      try {
        result = await rollbackPublication(projectId, snapshotId);
      } catch (err) {
        // If no stored ZIP for that snapshot, fall back to re-rendering + multipart.
        if (err instanceof ApiError && err.code === 'validation_failed') {
          const zip = await renderSnapshotZip(projectId, snapshotId);
          // Restoring a previously-published snapshot is itself the
          // acknowledgement — don't re-prompt for agency_id churn here.
          result = await publishProject(projectId, {
            snapshotId,
            ignoreWarnings: true,
            ignoreAgencyChurn: true,
            zip,
          });
        } else {
          throw err;
        }
      }
      setBanner({
        kind: 'success',
        message: 'Publication restored.',
        url: result.publication.canonicalUrl,
      });
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Restore failed';
      setBanner({ kind: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  };

  // Scheduling runs the same ID-stability gates as an immediate publish, so it
  // can 409 and open the same modals — the user acknowledges NOW, while they're
  // here, and the cron replays the acknowledgement when it fires.
  const handleSchedule = async () => {
    if (!selectedSnapshot || !projectId) return;
    const ms = fromLocalDatetimeInput(scheduleAt);
    if (ms == null) {
      setBanner({ kind: 'error', message: 'Pick a date and time to schedule.' });
      return;
    }
    await runAction({
      kind: 'schedule',
      snapshotId: selectedSnapshot.id,
      scheduledFor: ms,
      flags: {},
    });
  };

  const handleCancelSchedule = async () => {
    if (!projectId) return;
    setBusy(true);
    setBanner(null);
    try {
      await cancelScheduledPublish(projectId);
      setBanner({ kind: 'info', message: 'Scheduled publish cancelled.' });
      await refresh();
    } catch (err) {
      setBanner({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not cancel the schedule' });
    } finally {
      setBusy(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setBanner({ kind: 'info', message: 'Copied to clipboard.' });
    } catch {
      setBanner({ kind: 'error', message: 'Could not copy — copy manually.' });
    }
  };

  const currentPubSnapshotId = currentPublication?.snapshotId ?? null;
  const canonicalUrl =
    currentPublication?.canonicalUrl ??
    (currentPublication && activeProject ? `${FEEDS_ORIGIN}/${activeProject.slug}/gtfs.zip` : null);
  const publishDisabled =
    !selectedSnapshot ||
    busy ||
    (selectedSnapshot.validationErrors ?? 0) > 0 ||
    selectedSnapshot.id === currentPubSnapshotId ||
    ((selectedSnapshot.validationWarnings ?? 0) > 0 && !ignoreWarnings);
  // Scheduling allows the current snapshot (a future re-publish is fine) but
  // requires a chosen time and the same validation gate.
  const scheduleDisabled =
    !selectedSnapshot ||
    busy ||
    !scheduleAt ||
    (selectedSnapshot.validationErrors ?? 0) > 0 ||
    ((selectedSnapshot.validationWarnings ?? 0) > 0 && !ignoreWarnings);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto p-4 space-y-5">
        {banner && <BannerView banner={banner} onDismiss={() => setBanner(null)} />}

        <section className="bg-white border border-sand rounded-xl p-4">
          <h3 className="font-heading font-bold text-base text-dark-brown mb-2">
            Current publication
          </h3>
          {loading && !currentPublication ? (
            <p className="text-sm text-warm-gray">Loading…</p>
          ) : currentPublication ? (
            <CurrentPublicationView
              pub={currentPublication}
              onCopy={copyToClipboard}
              onUnpublish={() => setUnpublishConfirm(true)}
            />
          ) : (
            <p className="text-sm text-warm-gray">Not published yet.</p>
          )}
        </section>

        <section className="bg-white border border-sand rounded-xl p-4">
          <h3 className="font-heading font-bold text-base text-dark-brown mb-3">
            Publish a snapshot
          </h3>
          {snapshotList.length === 0 ? (
            <p className="text-sm text-warm-gray">
              No saved snapshots yet. Save one from the Snapshots tab first.
            </p>
          ) : (
            <>
              <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                Snapshot
              </label>
              <select
                value={selectedSnapshotId ?? ''}
                onChange={(e) => {
                  setSelectedSnapshotId(e.target.value);
                  setIgnoreWarnings(false);
                  setPublishErrors(null);
                }}
                className="w-full px-3 py-2 border-2 border-sand rounded-lg bg-cream text-sm text-dark-brown focus:outline-none focus:border-coral focus:bg-white mb-3"
              >
                {snapshotList.map((v) => (
                  <option key={v.id} value={v.id}>
                    {(v.label || `untitled`) + ' — ' + formatDate(v.createdAt)}
                    {v.id === currentPubSnapshotId ? ' · PUBLISHED' : ''}
                  </option>
                ))}
              </select>

              {selectedSnapshot && <SnapshotSummaryTable snapshot={selectedSnapshot} />}

              {selectedSnapshot && selectedSnapshot.validationErrors > 0 && (
                <div className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                  This snapshot has {selectedSnapshot.validationErrors} validation error
                  {selectedSnapshot.validationErrors === 1 ? '' : 's'}. Fix them in the editor and
                  save a new snapshot before publishing.
                </div>
              )}

              {selectedSnapshot &&
                selectedSnapshot.validationErrors === 0 &&
                selectedSnapshot.validationWarnings > 0 && (
                  <label className="mt-3 flex items-start gap-2 text-xs text-warm-gray cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ignoreWarnings}
                      onChange={(e) => setIgnoreWarnings(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Publish despite {selectedSnapshot.validationWarnings} warning
                      {selectedSnapshot.validationWarnings === 1 ? '' : 's'}.
                    </span>
                  </label>
                )}

              {selectedSnapshot &&
                selectedSnapshot.id === currentPubSnapshotId &&
                selectedSnapshot.validationErrors === 0 && (
                  <div className="mt-3 px-3 py-2 rounded-md bg-cream border border-sand text-warm-gray text-xs">
                    This snapshot is already the current publication.
                  </div>
                )}

              {publishErrors && (
                <div className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                  <div className="font-semibold mb-1">Publish rejected:</div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    {publishErrors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}

              {scheduled?.status === 'pending' && (
                <div className="mt-3 px-3 py-2 rounded-md bg-gold-light border border-gold text-amber-800 text-xs flex items-center justify-between gap-3">
                  <span>
                    ⏰ Scheduled to publish snapshot{' '}
                    <span className="font-mono">{scheduled.snapshotId.slice(0, 10)}</span> on{' '}
                    {formatDate(scheduled.scheduledFor)} (within ~15 min of that time).
                  </span>
                  <button
                    className="text-coral hover:underline whitespace-nowrap font-semibold"
                    disabled={busy}
                    onClick={handleCancelSchedule}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {scheduled?.status === 'failed' && (
                <div className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                  Last scheduled publish failed: {scheduled.failureReason || 'unknown error'}.
                </div>
              )}

              {/* Feed license — travels with the publication into feed_info.json
                  and the DMFR document (feeds.gtfsx.com/<slug>/dmfr.json).
                  Optional. */}
              <div className="mt-4 sm:max-w-sm">
                <label
                  htmlFor="publish-license"
                  className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1"
                >
                  Feed license <span className="normal-case font-normal">(optional)</span>
                </label>
                <select
                  id="publish-license"
                  value={licenseSpdx ?? ''}
                  onChange={(e) => setLicenseSpdx(e.target.value)}
                  className="w-full px-3 py-2 border-2 border-sand rounded-lg bg-cream text-sm text-dark-brown focus:outline-none focus:border-coral focus:bg-white"
                >
                  {LICENSE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-warm-gray">
                  SPDX identifier. Published in your feed's metadata so reusers know the terms.
                </p>
              </div>

              <label className="mt-4 flex items-center gap-2 text-xs text-dark-brown cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={scheduleMode}
                  onChange={(e) => setScheduleMode(e.target.checked)}
                  className="accent-coral w-4 h-4"
                />
                Schedule for later instead of publishing now
              </label>

              {scheduleMode ? (
                <div className="mt-3">
                  <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
                    Publish at
                  </label>
                  <input
                    type="datetime-local"
                    value={scheduleAt}
                    min={toLocalDatetimeInput(Date.now() + 2 * 60_000)}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className="w-full px-3 py-2 border-2 border-sand rounded-lg bg-cream text-sm text-dark-brown focus:outline-none focus:border-coral focus:bg-white"
                  />
                  <p className="mt-1 text-[11px] text-warm-gray">
                    Your local time. The snapshot publishes automatically at the next check after
                    this time (within ~15 min) — you don't need to keep this open.
                  </p>
                  <div className="mt-3">
                    <AuthButton onClick={handleSchedule} disabled={scheduleDisabled}>
                      {busy ? 'Scheduling…' : 'Schedule publish'}
                    </AuthButton>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <AuthButton onClick={handlePublish} disabled={publishDisabled}>
                    {busy ? 'Publishing…' : 'Publish now'}
                  </AuthButton>
                </div>
              )}
            </>
          )}
        </section>

        <DraftLinksSection projectId={projectId} snapshotList={snapshotList} setBanner={setBanner} />

        {currentPublication && <NtdP50Panel canonicalUrl={canonicalUrl} />}

        <section className="bg-white border border-sand rounded-xl p-4">
          <h3 className="font-heading font-bold text-base text-dark-brown mb-3">
            Publication history
          </h3>
          {publicationHistory.length === 0 ? (
            <p className="text-sm text-warm-gray">No publication events yet.</p>
          ) : (
            <div className="max-h-64 overflow-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray">
                  <tr>
                    <th className="px-2 py-2">When</th>
                    <th className="px-2 py-2">Action</th>
                    <th className="px-2 py-2">Snapshot</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {publicationHistory.map((h) => {
                    const isRollbackable =
                      h.snapshotId != null &&
                      h.snapshotId !== currentPubSnapshotId &&
                      snapshotList.some((v) => v.id === h.snapshotId);
                    return (
                      <tr key={h.id} className="border-t border-sand">
                        <td className="px-2 py-2 text-warm-gray whitespace-nowrap">
                          {formatDate(h.createdAt)}
                        </td>
                        <td className="px-2 py-2">
                          <HistoryActionBadge action={h.action} />
                        </td>
                        <td className="px-2 py-2 font-mono text-xs text-dark-brown">
                          {h.snapshotId ? h.snapshotId.slice(0, 10) : '—'}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          {isRollbackable && h.snapshotId && (
                            <button
                              className="text-xs text-coral hover:underline"
                              disabled={busy}
                              onClick={() => handleRollback(h.snapshotId as string)}
                            >
                              Restore this publication
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {unpublishConfirm && (
        <ConfirmModal
          title="Unpublish feed?"
          body="The canonical URL will return 404 until you publish again. Existing downstream consumers (Google Maps, Transit app, etc.) may stop receiving updates."
          confirmLabel="Unpublish"
          danger
          onCancel={() => setUnpublishConfirm(false)}
          onConfirm={handleUnpublish}
          busy={busy}
        />
      )}

      {rtBreakage && (
        <RtBreakageModal
          removed={rtBreakage.removed}
          mode={rtBreakage.action.kind}
          busy={busy}
          onCancel={() => setRtBreakage(null)}
          onConfirm={handleIgnoreRtBreakage}
        />
      )}

      {agencyChurn && (
        <AgencyChurnModal
          agencies={agencyChurn.agencies}
          mode={agencyChurn.action.kind}
          busy={busy}
          onCancel={() => setAgencyChurn(null)}
          onConfirm={handleIgnoreAgencyChurn}
        />
      )}

    </div>
  );
}

function BannerView({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  const styles: Record<BannerKind, string> = {
    success: 'bg-teal-light text-teal border-teal/40',
    error: 'bg-red-50 text-red-700 border-red-200',
    info: 'bg-cream text-dark-brown border-sand',
  };
  return (
    <div className={`px-4 py-3 rounded-lg border text-sm flex items-start gap-3 ${styles[banner.kind]}`}>
      <div className="flex-1">
        <div>{banner.message}</div>
        {banner.url && (
          <div className="mt-1 flex items-center gap-2">
            <code className="text-xs font-mono break-all">{banner.url}</code>
            <button
              onClick={() => navigator.clipboard?.writeText(banner.url!).catch(() => {})}
              className="text-xs underline hover:text-coral"
            >
              Copy
            </button>
          </div>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="w-6 h-6 rounded hover:bg-white/50 text-warm-gray"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}

function CurrentPublicationView({
  pub,
  onCopy,
  onUnpublish,
}: {
  pub: { snapshotId: string; publishedAt: number; canonicalUrl?: string };
  onCopy: (s: string) => void;
  onUnpublish: () => void;
}) {
  // Resolve the canonical URL from the active feed's slug when the API response
  // didn't include one (the /history endpoint's "current" field doesn't).
  const feedsProjects = useStore((s) => s.feedsProjects);
  const activeProjectId = useStore((s) => s.activeServerProjectId);
  const project = feedsProjects.find((p) => p.id === activeProjectId);
  const url =
    pub.canonicalUrl ??
    (project
      ? `${FEEDS_ORIGIN}/${project.slug}/gtfs.zip`
      : null);

  // Local "Copied!" affordance for the editor-link button, mirroring the
  // "Share for review" section's copy UX.
  const [editorCopied, setEditorCopied] = useState(false);
  const copyEditorLink = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(toEditorDeepLink(url));
      setEditorCopied(true);
      setTimeout(() => setEditorCopied(false), 1500);
    } catch {
      // Fall back to the banner-based copy if the Clipboard API is blocked.
      onCopy(toEditorDeepLink(url));
    }
  };

  return (
    <div className="space-y-3">
      {url && (
        <>
          {/* Direct feed URL — for GTFS ingestors (Google, Transit, OTP…). */}
          <div>
            <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Feed URL (GTFS .zip)
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs font-mono text-dark-brown bg-cream px-2 py-1 rounded break-all flex-1">
                {url}
              </code>
              <button
                onClick={() => onCopy(url)}
                className="text-xs px-2 py-1 rounded-md bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors whitespace-nowrap"
              >
                Copy URL
              </button>
            </div>
          </div>

          {/* Editor deep-link — opens THIS published feed in the GTFS·X editor. */}
          <div>
            <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
              Editor link — opens this feed in the GTFS·X editor
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <code className="text-xs font-mono text-dark-brown bg-cream px-2 py-1 rounded break-all flex-1">
                {toEditorDeepLink(url)}
              </code>
              <button
                onClick={copyEditorLink}
                title="Copies a link that opens this published feed in the GTFS·X editor"
                className={`text-xs px-2 py-1 rounded-md transition-colors whitespace-nowrap ${
                  editorCopied
                    ? 'bg-teal text-white'
                    : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
                }`}
              >
                {editorCopied ? 'Copied!' : 'Copy editor link'}
              </button>
              <a
                href={toEditorDeepLink(url)}
                target="_blank"
                rel="noopener noreferrer"
                title="Opens this published feed in the GTFS·X editor"
                className="text-xs px-2 py-1 rounded-md bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors whitespace-nowrap"
              >
                Open in editor
              </a>
            </div>
            <p className="text-[11px] text-warm-gray mt-1">
              Share this link so anyone can open the published feed directly in the GTFS·X editor —
              no account needed.
            </p>
          </div>
        </>
      )}
      <div className="text-xs text-warm-gray">
        Published {formatDate(pub.publishedAt)} · snapshot{' '}
        <span className="font-mono">{pub.snapshotId.slice(0, 10)}</span>
      </div>
      <div>
        <button
          onClick={onUnpublish}
          className="text-xs text-red-600 hover:underline"
        >
          Unpublish
        </button>
      </div>
    </div>
  );
}

function SnapshotSummaryTable({ snapshot }: { snapshot: ProjectSnapshot }) {
  const s = snapshot.summary ?? {};
  const rows: [string, string][] = [
    ['Routes', String((s.routeCount as number | undefined) ?? '—')],
    ['Stops', String((s.stopCount as number | undefined) ?? '—')],
    ['Trips', String((s.tripCount as number | undefined) ?? '—')],
    [
      'Service window',
      s.feedStartDate || s.feedEndDate
        ? `${(s.feedStartDate as string) ?? '—'} → ${(s.feedEndDate as string) ?? '—'}`
        : '—',
    ],
  ];
  return (
    <div className="bg-cream border border-sand rounded-md p-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <span className="text-warm-gray">{k}</span>
            <span className="text-dark-brown font-medium">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-1 flex-wrap">
        {snapshot.validationErrors > 0 && (
          <Badge variant="error">{snapshot.validationErrors} errors</Badge>
        )}
        {snapshot.validationWarnings > 0 && (
          <Badge variant="warning">{snapshot.validationWarnings} warnings</Badge>
        )}
        {snapshot.validationErrors === 0 && snapshot.validationWarnings === 0 && (
          <Badge variant="success">Clean</Badge>
        )}
      </div>
    </div>
  );
}

function HistoryActionBadge({ action }: { action: string }) {
  if (action === 'publish') return <Badge variant="success">Publish</Badge>;
  if (action === 'unpublish') return <Badge variant="warning">Unpublish</Badge>;
  if (action === 'rollback') return <Badge variant="info">Rollback</Badge>;
  return <Badge variant="info">{action}</Badge>;
}

// Both gate modals serve two callers: "Publish now" and "Schedule publish". In
// schedule mode the acknowledgement is stored and replayed by the cron, so the
// copy says so — the user is agreeing to something that happens later.
type GateMode = 'publish' | 'schedule';

const confirmLabel = (mode: GateMode, busy: boolean): string => {
  if (mode === 'schedule') return busy ? 'Scheduling…' : 'Schedule anyway';
  return busy ? 'Publishing…' : 'Publish anyway';
};

function ScheduleAckNote({ mode }: { mode: GateMode }) {
  if (mode !== 'schedule') return null;
  return (
    <p className="text-xs text-warm-gray mb-4 px-3 py-2 rounded-md bg-cream border border-sand">
      We check this now because nobody is here to ask when the schedule fires. Acknowledging is
      recorded with the schedule and applied at publish time. If your published feed changes before
      then, we'll re-check and hold the publish rather than publish something you didn't agree to.
    </p>
  );
}

function RtBreakageModal({
  removed,
  mode,
  onCancel,
  onConfirm,
  busy,
}: {
  removed: RemovedIds;
  mode: GateMode;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  const sections: [string, string[] | undefined][] = [
    ['Agencies', removed.agencies],
    ['Routes', removed.routes],
    ['Stops', removed.stops],
    ['Trips', removed.trips],
  ];
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-lg mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">
          GTFS-Realtime breakage detected
        </h3>
        <p className="text-sm text-warm-gray mb-4">
          Publishing this snapshot will remove or rename IDs that your registered GTFS-Realtime feed
          references. Downstream trip-update and vehicle-position consumers may break until your RT
          producer catches up.
        </p>
        <ScheduleAckNote mode={mode} />
        <div className="max-h-64 overflow-auto bg-cream border border-sand rounded-md p-3 text-xs font-mono text-dark-brown">
          {sections.map(([label, ids]) =>
            ids && ids.length > 0 ? (
              <div key={label} className="mb-2">
                <div className="font-heading font-bold text-warm-gray uppercase tracking-wide text-[10px] mb-1">
                  {label} ({ids.length})
                </div>
                <div className="flex flex-wrap gap-1">
                  {ids.slice(0, 50).map((id) => (
                    <span key={id} className="bg-white px-1.5 py-0.5 rounded border border-sand">
                      {id}
                    </span>
                  ))}
                  {ids.length > 50 && (
                    <span className="text-warm-gray">… and {ids.length - 50} more</span>
                  )}
                </div>
              </div>
            ) : null,
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton variant="danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel(mode, busy)}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}

// agency_id churn (409 agency_id_churn). Same acknowledge-and-proceed shape as
// RtBreakageModal, but a different failure: FTA's P-50 form crosswalks a
// published feed to its NTD ID by agency_id, so dropping or renaming one breaks
// the NTD crosswalk even for feeds with no GTFS-Realtime at all.
function AgencyChurnModal({
  agencies,
  mode,
  onCancel,
  onConfirm,
  busy,
}: {
  agencies: string[];
  mode: GateMode;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-lg mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">
          agency_id changed — this breaks your NTD crosswalk
        </h3>
        <p className="text-sm text-warm-gray mb-4">
          These <code className="font-mono">agency_id</code> values are in your published feed but
          not in the snapshot you're about to publish. FTA's enhanced P-50 form matches your feed to
          your National Transit Database ID by <code className="font-mono">agency_id</code>, and any
          downstream consumer keyed on it (trip planners, analytics, your own RT producer) will lose
          the link too.
        </p>
        <p className="text-sm text-warm-gray mb-4">
          The safe fix is to keep the existing <code className="font-mono">agency_id</code> values
          and change <code className="font-mono">agency_name</code> instead. If the change is
          intentional, {mode === 'schedule' ? 'schedule' : 'publish'} anyway — then refile your P-50
          with the new IDs.
        </p>
        <ScheduleAckNote mode={mode} />
        <div className="max-h-48 overflow-auto bg-cream border border-sand rounded-md p-3 text-xs font-mono text-dark-brown">
          <div className="font-heading font-bold text-warm-gray uppercase tracking-wide text-[10px] mb-1">
            Removed agency_id ({agencies.length})
          </div>
          <div className="flex flex-wrap gap-1">
            {agencies.slice(0, 50).map((id) => (
              <span key={id} className="bg-white px-1.5 py-0.5 rounded border border-sand">
                {id}
              </span>
            ))}
            {agencies.length > 50 && (
              <span className="text-warm-gray">… and {agencies.length - 50} more</span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton variant="danger" onClick={onConfirm} disabled={busy}>
            {confirmLabel(mode, busy)}
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

// Shared with DraftLinksPanel — extracting to a separate file would also work,
// but the helper is tightly coupled to the snapshot/sync state used here.
// eslint-disable-next-line react-refresh/only-export-components
export { renderSnapshotZip };
