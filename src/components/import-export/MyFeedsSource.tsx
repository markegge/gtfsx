import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { ApiError } from '../../services/authApi';
import { feedsOrigin, listMyFeeds, type MyFeedItem } from '../../services/myFeedsImport';

function feedsHost(): string {
  try {
    return new URL(feedsOrigin()).host;
  } catch {
    return 'feeds.gtfsx.com';
  }
}

interface Props {
  /** Resolve + import the selected feed. Throws to surface an inline error. */
  onSelect: (feed: MyFeedItem) => Promise<void>;
}

function fmtDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Importer source that lists the signed-in user's own + org feeds and hands a
 * selected (published) feed off to the shared ImportDialog parse → picker →
 * import pipeline. Org-scoped: feeds are listed per workspace (personal or a
 * specific org), and the server only returns feeds the caller can access.
 */
export function MyFeedsSource({ onSelect }: Props) {
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const userOrgs = useStore((s) => s.userOrgs);

  // Workspace options: personal + every org the user belongs to. The user can
  // import from any of their workspaces, defaulting to the active one.
  const options = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: 'personal', label: 'My personal feeds' },
    ];
    for (const org of userOrgs) opts.push({ value: `org:${org.id}`, label: org.name });
    return opts;
  }, [userOrgs]);

  const defaultScope =
    activeWorkspace.type === 'org' ? `org:${activeWorkspace.orgId}` : 'personal';
  const [scope, setScope] = useState(defaultScope);

  const [feeds, setFeeds] = useState<MyFeedItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const load = useCallback(async (s: string) => {
    setLoading(true);
    setError(null);
    setFeeds(null);
    try {
      setFeeds(await listMyFeeds(s));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your feeds.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(scope);
  }, [scope, load]);

  const handleImport = async (feed: MyFeedItem) => {
    if (!feed.published) return;
    setImportError(null);
    setImportingId(feed.id);
    try {
      await onSelect(feed);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {options.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-warm-gray">
          <span className="shrink-0">Workspace</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={loading || importingId !== null}
            className="flex-1 px-3 py-2 border-2 border-sand rounded-lg text-sm bg-white text-dark-brown focus:outline-none focus:border-coral disabled:opacity-50"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>
      )}
      {importError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{importError}</div>
      )}

      {loading ? (
        <div className="border border-sand rounded-lg px-3 py-6 text-center text-sm text-warm-gray">
          Loading your feeds…
        </div>
      ) : feeds && (
        <div className="border border-sand rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-cream text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
            {feeds.length} feed{feeds.length === 1 ? '' : 's'}
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-sand">
            {feeds.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-warm-gray">
                No feeds in this workspace yet.
              </div>
            ) : (
              feeds.map((feed) => {
                const isImporting = importingId === feed.id;
                const disabled = !feed.published || importingId !== null;
                return (
                  <button
                    key={feed.id}
                    type="button"
                    onClick={() => handleImport(feed)}
                    disabled={disabled}
                    title={
                      feed.published
                        ? 'Import routes/stops from this feed'
                        : 'Publish this feed first to import from it'
                    }
                    className={`w-full text-left block select-none px-3 py-2.5 transition-colors ${
                      disabled ? 'opacity-60 cursor-not-allowed' : 'hover:bg-cream'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <span className="block text-sm font-semibold text-dark-brown truncate">{feed.name}</span>
                        <div className="text-[11px] text-warm-gray flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                          <span className="font-mono">{feed.slug}</span>
                          {feed.updatedAt > 0 && <span>· updated {fmtDate(feed.updatedAt)}</span>}
                          {!feed.published && <span className="text-amber-600">· not published</span>}
                        </div>
                      </div>
                      <span className="text-xs text-coral font-semibold whitespace-nowrap pt-0.5">
                        {isImporting ? 'Loading…' : feed.published ? 'Import →' : 'Publish first'}
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      <p className="text-[10px] text-warm-gray/80">
        Imports from your <strong>published</strong> feeds ({feedsHost()}/&lt;slug&gt;/gtfs.zip).
        Publish a feed from the editor to make it importable here.
      </p>
    </div>
  );
}
