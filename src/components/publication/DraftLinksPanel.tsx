import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import {
  createDraftLink,
  listDraftLinks,
  revokeDraftLink,
  type ProjectSnapshot,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { renderSnapshotZip } from './PublishPanel';

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

function daysUntil(ms: number): number {
  const diff = ms - Date.now();
  return Math.max(0, Math.round(diff / (24 * 60 * 60 * 1000)));
}

// Construct an editor deep-link that opens /import on the current origin with
// the draft ZIP URL as the source. Anyone with the URL can preview the feed
// in an anonymous editor session — no account required, same TTL as the ZIP
// link itself (revocation flows through automatically since the editor proxy
// will get a 410 when fetching the underlying draft URL).
function toEditorDeepLink(zipUrl: string): string {
  return `${window.location.origin}/import?url=${encodeURIComponent(zipUrl)}`;
}

type BannerKind = 'success' | 'error' | 'info';

interface DraftLinksSectionProps {
  projectId: string;
  snapshotList: ProjectSnapshot[];
  setBanner: (b: { kind: BannerKind; message: string; url?: string } | null) => void;
}

export function DraftLinksSection({
  projectId,
  snapshotList,
  setBanner,
}: DraftLinksSectionProps) {
  const draftLinks = useStore((s) => s.draftLinks);
  const setDraftLinks = useStore((s) => s.setDraftLinks);

  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [justCreated, setJustCreated] = useState<{ url: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await listDraftLinks(projectId);
      setDraftLinks(res.links);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load draft links';
      setBanner({ kind: 'error', message: msg });
    } finally {
      setLoading(false);
    }
  }, [projectId, setDraftLinks, setBanner]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async (snapshotId: string, ttlDays: number) => {
    setBusy(true);
    try {
      const zip = await renderSnapshotZip(projectId, snapshotId);
      const res = await createDraftLink(projectId, { snapshotId, ttlDays, zip });
      setJustCreated({ url: res.url, expiresAt: res.expiresAt });
      setShowCreate(false);
      await refresh();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not create link';
      setBanner({ kind: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (tokenHash: string) => {
    setBusy(true);
    try {
      await revokeDraftLink(projectId, tokenHash);
      setRevokeTarget(null);
      await refresh();
      setBanner({ kind: 'info', message: 'Draft link revoked.' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Revoke failed';
      setBanner({ kind: 'error', message: msg });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      // 1.5s is long enough for the user to register the change without
      // making the button feel sticky on the next click.
      setTimeout(() => {
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1500);
    } catch {
      setBanner({ kind: 'error', message: 'Could not copy — copy manually.' });
    }
  };

  return (
    <section className="bg-white border border-sand rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-heading font-bold text-base text-dark-brown">Share for review</h3>
        <AuthButton
          variant="secondary"
          onClick={() => setShowCreate(true)}
          disabled={snapshotList.length === 0 || busy}
        >
          + Create draft link
        </AuthButton>
      </div>
      <p className="text-xs text-warm-gray mb-3">
        Unlisted URL that points to a specific snapshot. Share it for stakeholder review; revoke at
        any time.
      </p>

      {justCreated && (
        <div className="mb-3 px-3 py-3 rounded-lg bg-coral-light border border-coral/30 text-sm">
          <div className="font-semibold text-coral mb-2">Link created — copy it now</div>

          <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            ZIP download
          </div>
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <code className="text-xs font-mono text-dark-brown bg-white px-2 py-1 rounded break-all flex-1">
              {justCreated.url}
            </code>
            <button
              onClick={() => copy(justCreated.url, 'zip')}
              className={`text-xs px-2 py-1 rounded-md text-white transition-colors ${
                copiedKey === 'zip' ? 'bg-teal' : 'bg-coral hover:bg-[#d4603a]'
              }`}
            >
              {copiedKey === 'zip' ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <div className="text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
            Open in editor
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-dark-brown bg-white px-2 py-1 rounded break-all flex-1">
              {toEditorDeepLink(justCreated.url)}
            </code>
            <button
              onClick={() => copy(toEditorDeepLink(justCreated.url), 'editor')}
              className={`text-xs px-2 py-1 rounded-md text-white transition-colors ${
                copiedKey === 'editor' ? 'bg-teal' : 'bg-coral hover:bg-[#d4603a]'
              }`}
            >
              {copiedKey === 'editor' ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={() => setJustCreated(null)}
              className="text-xs px-2 py-1 rounded-md text-warm-gray hover:text-coral"
            >
              Done
            </button>
          </div>

          <div className="text-xs text-warm-gray mt-2">
            Both URLs expire in {daysUntil(justCreated.expiresAt)} days and share the same revocation —
            killing the draft link kills the editor preview too. This is the only time the full URLs
            will be shown; revoke and regenerate if you lose them.
          </div>
        </div>
      )}

      {loading && draftLinks.length === 0 ? (
        <p className="text-sm text-warm-gray">Loading…</p>
      ) : draftLinks.length === 0 ? (
        <p className="text-sm text-warm-gray">No active draft links.</p>
      ) : (
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray">
              <tr>
                <th className="px-2 py-2">ID</th>
                <th className="px-2 py-2">Snapshot</th>
                <th className="px-2 py-2">Created</th>
                <th className="px-2 py-2">Expires</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {draftLinks.map((l) => (
                <tr key={l.tokenHash} className="border-t border-sand">
                  <td className="px-2 py-2 font-mono text-xs text-warm-gray">
                    {l.tokenHash.slice(0, 8)}…
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-dark-brown">
                    {l.snapshotId.slice(0, 10)}
                  </td>
                  <td className="px-2 py-2 text-warm-gray whitespace-nowrap">
                    {formatDate(l.createdAt)}
                  </td>
                  <td className="px-2 py-2 text-warm-gray whitespace-nowrap">
                    {formatDate(l.expiresAt)}{' '}
                    <span className="text-[10px] text-warm-gray">
                      ({daysUntil(l.expiresAt)}d)
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => setRevokeTarget(l.tokenHash)}
                      className="text-xs text-red-600 hover:underline"
                      disabled={busy}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateDraftDialog
          snapshotList={snapshotList}
          busy={busy}
          onCancel={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {revokeTarget && (
        <ConfirmModal
          title="Revoke draft link?"
          body="Anyone holding this link will immediately get a 410 Gone response."
          confirmLabel="Revoke"
          danger
          busy={busy}
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => handleRevoke(revokeTarget)}
        />
      )}
    </section>
  );
}

function CreateDraftDialog({
  snapshotList,
  busy,
  onCancel,
  onCreate,
}: {
  snapshotList: ProjectSnapshot[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (snapshotId: string, ttlDays: number) => void;
}) {
  const [snapshotId, setSnapshotId] = useState<string>(snapshotList[0]?.id ?? '');
  const [ttlDays, setTtlDays] = useState(30);
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Create draft link</h3>
        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Snapshot
        </label>
        <select
          value={snapshotId}
          onChange={(e) => setSnapshotId(e.target.value)}
          className="w-full px-3 py-2 border-2 border-sand rounded-lg bg-cream text-sm text-dark-brown focus:outline-none focus:border-coral focus:bg-white mb-3"
        >
          {snapshotList.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label || 'untitled'} — {new Date(v.createdAt).toLocaleDateString()}
            </option>
          ))}
        </select>

        <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">
          Expires after
        </label>
        <div className="flex gap-2 mb-4">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setTtlDays(d)}
              className={`flex-1 px-3 py-2 rounded-lg text-sm font-heading font-bold transition-colors ${
                ttlDays === d
                  ? 'bg-coral text-white'
                  : 'bg-sand text-brown hover:bg-coral-light hover:text-coral'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton
            onClick={() => onCreate(snapshotId, ttlDays)}
            disabled={busy || !snapshotId}
          >
            {busy ? 'Creating…' : 'Create link'}
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
