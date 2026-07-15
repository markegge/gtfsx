import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../store';
import { AuthButton } from '../auth/AuthButton';
import { Badge } from '../ui/Badge';
import { ApiError } from '../../services/authApi';
import {
  createCatalogSubmission,
  deleteCatalogSubmission,
  deleteRtFeed,
  listCatalogSubmissions,
  listRtFeeds,
  putRtFeeds,
  type CatalogName,
  type CatalogStatus,
  type CatalogSubmission,
  type RtFeed,
  type RtFeedKind,
} from '../../services/distributionApi';

// ───────────────────────────────────────────────────────────────────────────
// "Manual-listing" catalogs are tracked locally — there's no programmatic
// submission flow, the user just clicks the external link, gets themselves
// listed, then checks the box so they remember. We keep this per-user+project
// in localStorage.
// ───────────────────────────────────────────────────────────────────────────

type ManualCatalog = 'google' | 'apple' | 'transit_app';

const MANUAL_STORAGE_KEY = (projectId: string) => `gb:distribution:manual:${projectId}`;

function loadManualFlags(projectId: string): Record<ManualCatalog, boolean> {
  try {
    const raw = localStorage.getItem(MANUAL_STORAGE_KEY(projectId));
    if (!raw) return { google: false, apple: false, transit_app: false };
    const parsed = JSON.parse(raw) as Partial<Record<ManualCatalog, boolean>>;
    return {
      google: !!parsed.google,
      apple: !!parsed.apple,
      transit_app: !!parsed.transit_app,
    };
  } catch {
    return { google: false, apple: false, transit_app: false };
  }
}

function saveManualFlags(projectId: string, flags: Record<ManualCatalog, boolean>) {
  try {
    localStorage.setItem(MANUAL_STORAGE_KEY(projectId), JSON.stringify(flags));
  } catch {
    // swallow — localStorage may be full or blocked
  }
}

export function DistributionPanel() {
  const projectId = useStore((s) => s.activeServerProjectId);

  if (!projectId) {
    return (
      <div className="px-4 py-6 text-sm text-warm-gray">
        Distribution options are available once you've saved this feed to your account.
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-6">
      <CatalogSection projectId={projectId} />
      <RtFeedsSection projectId={projectId} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Catalog submissions section
// ═══════════════════════════════════════════════════════════════════════════

function CatalogSection({ projectId }: { projectId: string }) {
  const [submissions, setSubmissions] = useState<CatalogSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState<Record<ManualCatalog, boolean>>(
    () => loadManualFlags(projectId),
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listCatalogSubmissions(projectId);
      setSubmissions(res.submissions);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load catalog submissions');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setManual(loadManualFlags(projectId));
  }, [projectId]);

  const byCatalog = (name: CatalogName) => submissions.find((s) => s.catalog === name) ?? null;

  const setManualFlag = (cat: ManualCatalog, value: boolean) => {
    const next = { ...manual, [cat]: value };
    setManual(next);
    saveManualFlags(projectId, next);
  };

  return (
    <section>
      <SectionHeader
        title="Catalog submissions"
        description="Opt in to have your published feed listed in public GTFS catalogs. Submissions happen automatically on every publish."
      />
      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
      <div className="border border-sand rounded-lg divide-y divide-sand">
        <AutomatedCatalogRow
          name="Mobility Database"
          catalog="mobility_db"
          description="The de facto open registry of GTFS feeds (mobilitydata.org)."
          submission={byCatalog('mobility_db')}
          loading={loading}
          projectId={projectId}
          onRefresh={refresh}
        />
        <AutomatedCatalogRow
          name="transit.land"
          catalog="transit_land"
          description="Interline's open transit data platform."
          submission={byCatalog('transit_land')}
          loading={loading}
          projectId={projectId}
          onRefresh={refresh}
          infoNote="Submissions are queued for manual review by transit.land staff."
        />
        <ManualCatalogRow
          name="Google Transit Partners"
          description="Appear in Google Maps transit directions."
          href="https://support.google.com/transitpartners/answer/1111481"
          checked={manual.google}
          onChange={(v) => setManualFlag('google', v)}
        />
        <ManualCatalogRow
          name="Apple Maps Transit"
          description="Appear in Apple Maps transit directions."
          href="https://mapsconnect.apple.com/"
          checked={manual.apple}
          onChange={(v) => setManualFlag('apple', v)}
        />
        <ManualCatalogRow
          name="Transit app"
          description="Consumer transit app used in 250+ cities."
          href="https://transitapp.com/apis"
          checked={manual.transit_app}
          onChange={(v) => setManualFlag('transit_app', v)}
          note="Usually picked up automatically once listed in Mobility Database."
        />
      </div>
    </section>
  );
}

function AutomatedCatalogRow({
  name,
  catalog,
  description,
  submission,
  loading,
  projectId,
  onRefresh,
  infoNote,
}: {
  name: string;
  catalog: CatalogName;
  description: string;
  submission: CatalogSubmission | null;
  loading: boolean;
  projectId: string;
  onRefresh: () => Promise<void>;
  infoNote?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const optedIn = !!submission;

  const toggle = async (next: boolean) => {
    setBusy(true);
    setRowError(null);
    try {
      if (next) {
        await createCatalogSubmission(projectId, catalog);
      } else {
        await deleteCatalogSubmission(projectId, catalog);
      }
      await onRefresh();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    setBusy(true);
    setRowError(null);
    try {
      // POST is idempotent — re-issues the submission and resets status to pending.
      await createCatalogSubmission(projectId, catalog);
      await onRefresh();
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <label className="flex items-start gap-3 cursor-pointer select-none flex-1 min-w-0">
          <input
            type="checkbox"
            checked={optedIn}
            disabled={busy || loading}
            onChange={(e) => toggle(e.target.checked)}
            className="mt-1 accent-coral"
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-dark-brown flex items-center gap-2 flex-wrap">
              {name}
              <StatusBadge status={submission?.status} optedIn={optedIn} />
            </div>
            <div className="text-xs text-warm-gray mt-0.5">{description}</div>
            {infoNote && (
              <div className="text-xs text-purple mt-1 italic">{infoNote}</div>
            )}
            {submission?.lastSubmittedAt && (
              <div className="text-[11px] text-warm-gray mt-1">
                Last submitted {formatDate(submission.lastSubmittedAt)}
              </div>
            )}
          </div>
        </label>
      </div>

      {(submission?.status === 'error' && submission?.lastError) || rowError ? (
        <div className="mt-2 ml-7 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs flex items-start justify-between gap-3">
          <span className="flex-1">{rowError ?? submission?.lastError}</span>
          {submission?.status === 'error' && (
            <button
              onClick={retry}
              disabled={busy}
              className="text-xs font-bold text-red-700 hover:underline disabled:opacity-50 shrink-0"
            >
              Retry
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ManualCatalogRow({
  name,
  description,
  href,
  checked,
  onChange,
  note,
}: {
  name: string;
  description: string;
  href: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  note?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 accent-coral"
          aria-label={`Mark ${name} as listed`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-dark-brown flex items-center gap-2 flex-wrap">
            {name}
            {checked && <Badge variant="success">Listed</Badge>}
          </div>
          <div className="text-xs text-warm-gray mt-0.5">{description}</div>
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-coral hover:underline mt-1 inline-block"
          >
            Apply to {name} →
          </a>
          {note && <div className="text-xs text-warm-gray mt-1 italic">{note}</div>}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status, optedIn }: { status?: CatalogStatus; optedIn: boolean }) {
  if (!optedIn) return null;
  if (status === 'submitted') return <Badge variant="success">Submitted</Badge>;
  if (status === 'error') return <Badge variant="error">Error</Badge>;
  return <Badge variant="warning">Pending</Badge>;
}

// ═══════════════════════════════════════════════════════════════════════════
// RT feeds section
// ═══════════════════════════════════════════════════════════════════════════

function RtFeedsSection({ projectId }: { projectId: string }) {
  const [feeds, setFeeds] = useState<RtFeed[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newKind, setNewKind] = useState<RtFeedKind>('vehicle_positions');
  const [newUrl, setNewUrl] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listRtFeeds(projectId);
      setFeeds(res.feeds);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load RT feeds');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const trimmed = newUrl.trim();
    if (!trimmed) {
      setFormError('URL is required');
      return;
    }
    if (!trimmed.startsWith('https://')) {
      setFormError('URL must start with https://');
      return;
    }
    setBusy(true);
    try {
      const merged = [...feeds.map((f) => ({ kind: f.kind, url: f.url })), { kind: newKind, url: trimmed }];
      const res = await putRtFeeds(projectId, merged);
      setFeeds(res.feeds);
      setNewUrl('');
      setNewKind('vehicle_positions');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not add RT feed');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (rtId: string) => {
    setBusy(true);
    setError(null);
    try {
      await deleteRtFeed(projectId, rtId);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove RT feed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="GTFS-Realtime feeds"
        description="Register the public URLs where your real-time data is served."
      />
      <p className="text-xs text-warm-gray italic mb-3">
        Registering these helps downstream consumers discover your real-time feed and lets us warn
        you on publish if you're about to change IDs referenced by it.
      </p>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="border border-sand rounded-lg overflow-hidden mb-4">
        {loading ? (
          <p className="px-4 py-3 text-sm text-warm-gray">Loading…</p>
        ) : feeds.length === 0 ? (
          <div className="px-4 py-3 text-sm text-warm-gray">No RT feeds registered.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-warm-gray border-b border-sand">
                <th className="px-4 py-2">Kind</th>
                <th className="px-3 py-2">URL</th>
                <th className="px-3 py-2 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((feed) => (
                <tr key={feed.id} className="border-t border-sand">
                  <td className="px-4 py-2 text-dark-brown">{prettyKind(feed.kind)}</td>
                  <td className="px-3 py-2 text-dark-brown truncate max-w-xs">
                    <span className="font-mono text-xs">{feed.url}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => handleRemove(feed.id)}
                      disabled={busy}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <form onSubmit={handleAdd} className="border border-sand rounded-lg p-3 bg-cream/50">
        <div className="text-[11px] font-bold uppercase tracking-wide text-warm-gray mb-2">
          Add RT feed
        </div>
        <div className="flex flex-col md:flex-row gap-2 items-stretch md:items-start">
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as RtFeedKind)}
            className="px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          >
            <option value="vehicle_positions">Vehicle positions</option>
            <option value="trip_updates">Trip updates</option>
            <option value="alerts">Alerts</option>
          </select>
          <input
            type="url"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="https://example.org/gtfs-rt/vehicles.pb"
            className="flex-1 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral"
          />
          <AuthButton type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </AuthButton>
        </div>
        {formError && <p className="text-red-500 text-xs mt-2">{formError}</p>}
      </form>
    </section>
  );
}

function prettyKind(kind: RtFeedKind): string {
  switch (kind) {
    case 'vehicle_positions':
      return 'Vehicle positions';
    case 'trip_updates':
      return 'Trip updates';
    case 'alerts':
      return 'Alerts';
    default:
      return kind;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="font-heading font-bold text-base text-dark-brown">{title}</h3>
      {description && <p className="text-xs text-warm-gray mt-0.5">{description}</p>}
    </div>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
