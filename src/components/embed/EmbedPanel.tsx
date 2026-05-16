import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { patchProject } from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';

const FEEDS_ORIGIN =
  (import.meta.env.VITE_FEEDS_ORIGIN as string | undefined) ||
  (typeof window !== 'undefined' && window.location.hostname.startsWith('staging.')
    ? 'https://staging-feeds.gtfsstudio.net'
    : 'https://feeds.gtfsstudio.net');

interface PublicationInfo {
  slug: string;
  snapshotId: string;
}

/**
 * "Embed" tab in the bottom panel. Lets the agency copy iframe snippets
 * for the system map and per-route embeds. Only visible after a feed is
 * published — embeds read from the canonical published snapshot.
 */
export function EmbedPanel() {
  const routes = useStore((s) => s.routes);
  const currentPublication = useStore((s) => s.currentPublication);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const activeServerProjectId = useStore((s) => s.activeServerProjectId);

  const project = activeServerProjectId
    ? feedsProjects.find((p) => p.id === activeServerProjectId)
    : null;

  const pub: PublicationInfo | null =
    project && currentPublication ? { slug: project.slug, snapshotId: currentPublication.snapshotId } : null;

  if (!pub || !project) {
    return (
      <div className="p-6 text-sm text-warm-gray">
        Publish this feed first to get embeddable links. Once published, the system map and
        per-route widgets are available at{' '}
        <code className="text-coral">{FEEDS_ORIGIN}/&lt;slug&gt;/embed/...</code>.
      </div>
    );
  }

  return (
    <div className="overflow-y-auto p-6 space-y-6">
      <BrandColorSection projectId={project.id} initialColor={project.brandPrimaryColor ?? null} />
      <SystemMapSnippet slug={pub.slug} />
      <RouteSnippets slug={pub.slug} routes={routes} />
    </div>
  );
}

function BrandColorSection({
  projectId,
  initialColor,
}: {
  projectId: string;
  initialColor: string | null;
}) {
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const [color, setColor] = useState<string>(initialColor ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setColor(initialColor ?? '');
  }, [initialColor]);

  const valid = color === '' || /^[0-9a-fA-F]{6}$/.test(color);
  const dirty = (color || null) !== (initialColor || null);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const updated = await patchProject(projectId, {
        brandPrimaryColor: color === '' ? null : color.toLowerCase(),
      });
      upsertFeedProject(updated);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1600);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Brand color</h3>
      <p className="text-xs text-warm-gray mb-2">
        Hex color used for the active service-day tab and accent links on every embed page.
        Leave blank to use the default coral.
      </p>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={`#${color || 'e8734a'}`}
          onChange={(e) => setColor(e.target.value.replace(/^#/, '').toLowerCase())}
          className="w-10 h-10 rounded-md border border-sand cursor-pointer"
          aria-label="Brand color picker"
        />
        <div className="flex items-center gap-1 font-mono text-sm">
          <span className="text-warm-gray">#</span>
          <input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6))}
            placeholder="e8734a"
            className={`w-24 px-2 py-1 rounded-md border ${
              valid ? 'border-sand' : 'border-red-400'
            } focus:outline-none focus:border-coral text-sm`}
          />
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!valid || !dirty || saving}
          className="px-3 py-1.5 rounded-md text-xs font-heading font-bold bg-coral text-white hover:bg-[#d4603a] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : savedFlash ? 'Saved' : 'Save'}
        </button>
        {color === '' ? null : (
          <button
            type="button"
            onClick={() => setColor('')}
            disabled={saving}
            className="text-xs text-warm-gray hover:text-coral underline"
          >
            Reset to default
          </button>
        )}
      </div>
      {error && (
        <div className="mt-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}
    </section>
  );
}

function SystemMapSnippet({ slug }: { slug: string }) {
  const url = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/embed/system-map`;
  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">System map</h3>
      <p className="text-xs text-warm-gray mb-2">
        An interactive map of every route + a clickable list of routes.
      </p>
      <CopyableSnippet
        label="iframe"
        snippet={`<iframe src="${url}" width="100%" height="700" frameborder="0" loading="lazy" title="Transit system map"></iframe>`}
      />
      <PreviewLink url={url} />
    </section>
  );
}

function RouteSnippets({
  slug,
  routes,
}: {
  slug: string;
  routes: { route_id: string; route_short_name: string; route_long_name: string; route_color: string; route_text_color: string }[];
}) {
  const sorted = useMemo(
    () =>
      routes.slice().sort((a, b) => {
        const an = a.route_short_name || a.route_id;
        const bn = b.route_short_name || b.route_id;
        return an.localeCompare(bn, undefined, { numeric: true });
      }),
    [routes],
  );

  if (sorted.length === 0) {
    return (
      <section>
        <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Per-route embeds</h3>
        <p className="text-xs text-warm-gray">No routes defined yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h3 className="font-heading font-bold text-sm text-dark-brown mb-1">Per-route embeds</h3>
      <p className="text-xs text-warm-gray mb-2">
        One iframe per route. Includes the route map, schedule table, and a service-day selector
        (defaults to today).
      </p>
      <div className="space-y-3">
        {sorted.map((r) => {
          const url = `${FEEDS_ORIGIN}/${encodeURIComponent(slug)}/embed/route/${encodeURIComponent(r.route_id)}`;
          return (
            <div key={r.route_id} className="border border-sand rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <span
                  className="inline-block px-2 py-0.5 rounded text-xs font-bold"
                  style={{
                    background: `#${r.route_color || 'cccccc'}`,
                    color: `#${r.route_text_color || '000000'}`,
                  }}
                >
                  {r.route_short_name || r.route_id}
                </span>
                <span className="text-sm text-dark-brown font-medium">{r.route_long_name}</span>
              </div>
              <CopyableSnippet
                label="iframe"
                snippet={`<iframe src="${url}" width="100%" height="700" frameborder="0" loading="lazy" title="${escapeAttr(r.route_long_name || r.route_short_name || r.route_id)}"></iframe>`}
              />
              <PreviewLink url={url} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CopyableSnippet({ snippet }: { label: string; snippet: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore — user can still select-and-copy.
    }
  };
  return (
    <div className="flex items-stretch gap-2">
      <code className="flex-1 text-[11px] font-mono bg-cream border border-sand rounded-md px-2 py-1.5 break-all">
        {snippet}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="px-3 py-1 rounded-md text-xs font-heading font-bold bg-sand text-brown hover:bg-coral-light hover:text-coral transition-colors"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function PreviewLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-block mt-2 text-xs text-coral font-semibold hover:underline"
    >
      Open preview →
    </a>
  );
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/&/g, '&amp;');
}
