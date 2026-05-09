import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { AuthLayout } from '../auth/AuthLayout';
import { AuthButton } from '../auth/AuthButton';
import { FormField } from '../ui/FormField';
import { Badge } from '../ui/Badge';
import {
  createProject,
  deleteProject,
  importProjects,
  listProjects,
  patchProject,
  transferProject,
  type ProjectSummary,
  type TransferResult,
} from '../../services/projectsApi';
import { ApiError } from '../../services/authApi';
import { roleAtLeast } from '../../services/orgsApi';
import { db } from '../../db/dexie';

interface LocalProjectOption {
  id: string;
  name: string;
  snapshot: Record<string, unknown>;
  hasData: boolean;
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function gatherLocalProjects(): Promise<LocalProjectOption[]> {
  try {
    const projects = await db.projects.toArray();
    const out: LocalProjectOption[] = [];
    for (const p of projects) {
      const data = await db.projectData.get(p.id);
      if (!data) continue;
      let snapshot: Record<string, unknown>;
      try {
        snapshot = JSON.parse(data.storeSnapshot) as Record<string, unknown>;
      } catch {
        continue;
      }
      const routes = Array.isArray(snapshot.routes) ? snapshot.routes.length : 0;
      const stops = Array.isArray(snapshot.stops) ? snapshot.stops.length : 0;
      const shapes = Array.isArray(snapshot.shapes) ? snapshot.shapes.length : 0;
      if (routes === 0 && stops === 0 && shapes === 0) continue;
      out.push({ id: p.id, name: p.name || 'Untitled Feed', snapshot, hasData: true });
    }
    return out;
  } catch {
    return [];
  }
}

export function MyFeedsPage() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const hydrateAuth = useStore((s) => s.hydrateAuth);
  const feedsProjects = useStore((s) => s.feedsProjects);
  const feedsQuotaWarning = useStore((s) => s.feedsQuotaWarning);
  const setFeedsProjects = useStore((s) => s.setFeedsProjects);
  const upsertFeedProject = useStore((s) => s.upsertFeedProject);
  const removeFeedProject = useStore((s) => s.removeFeedProject);

  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);

  const [localProjects, setLocalProjects] = useState<LocalProjectOption[]>([]);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importDismissed, setImportDismissed] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<ProjectSummary | null>(null);
  const [moveResult, setMoveResult] = useState<{ message: string } | null>(null);

  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const userOrgs = useStore((s) => s.userOrgs);
  const scope =
    activeWorkspace.type === 'org' ? `org:${activeWorkspace.orgId}` : 'personal';
  const workspaceLabel =
    activeWorkspace.type === 'org'
      ? userOrgs.find((o) => o.id === activeWorkspace.orgId)?.name ?? 'Organization'
      : 'My personal feeds';

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const res = await listProjects({ includeArchived, scope });
      setFeedsProjects(res.projects, res.quota.warning);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not load feeds';
      setListError(msg);
    } finally {
      setLoading(false);
    }
  }, [includeArchived, scope, setFeedsProjects]);

  useEffect(() => {
    if (!authChecked) return;
    if (!currentUser) return;
    fetchList();
  }, [authChecked, currentUser, fetchList]);

  useEffect(() => {
    if (!currentUser) return;
    gatherLocalProjects().then(setLocalProjects);
  }, [currentUser]);

  const importableCount = useMemo(
    () =>
      localProjects.filter(
        (lp) => !feedsProjects.some((fp) => fp.name === lp.name || fp.id === lp.id),
      ).length,
    [localProjects, feedsProjects],
  );

  const handleImport = async () => {
    if (localProjects.length === 0) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const items = localProjects.map((lp) => ({
        name: lp.name,
        snapshot: lp.snapshot,
      }));
      const result = await importProjects(items);
      const importedCount = result.imported.length;
      const skippedCount = result.skipped.length;
      const parts: string[] = [];
      if (importedCount) parts.push(`Imported ${importedCount} feed${importedCount === 1 ? '' : 's'}`);
      if (skippedCount) parts.push(`${skippedCount} skipped`);
      setImportStatus(parts.join(' · ') || 'Done');
      await fetchList();
      setLocalProjects([]);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Import failed';
      setImportStatus(`Import failed: ${msg}`);
    } finally {
      setImporting(false);
    }
  };

  if (!authChecked) {
    return (
      <AuthLayout title="My Feeds">
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!currentUser) {
    navigate(`/login?next=${encodeURIComponent('/feeds')}`, { replace: true });
    return null;
  }

  const visibleLocal = !importDismissed && importableCount > 0;

  return (
    <div className="min-h-full bg-cream">
      <header className="h-14 bg-white border-b border-sand flex items-center px-5 shrink-0">
        <Link
          to="/"
          className="flex items-center gap-2 font-heading font-extrabold text-xl text-coral hover:opacity-80 transition-opacity"
        >
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#E8734A" />
            <path d="M6 24 C10 24, 10 8, 16 8 S22 24, 26 24" stroke="#FFF8F0" strokeWidth="2.5" fill="none" strokeLinecap="round" />
            <circle cx="8" cy="22" r="2.5" fill="#FFF8F0" />
            <circle cx="16" cy="8" r="2.5" fill="#FFF8F0" />
            <circle cx="24" cy="22" r="2.5" fill="#FFF8F0" />
            <rect x="12" y="14" width="8" height="5" rx="1.5" fill="#FFF8F0" />
          </svg>
          GTFS Builder
        </Link>
        <div className="flex-1" />
        <Link
          to="/account"
          className="text-sm text-warm-gray hover:text-coral transition-colors"
        >
          {currentUser.email}
        </Link>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="font-heading font-extrabold text-3xl text-dark-brown">
              {workspaceLabel}
            </h1>
            <p className="text-sm text-warm-gray mt-1">
              {activeWorkspace.type === 'org'
                ? 'Feeds owned by this organization. Switch workspace via the account menu.'
                : 'Feeds saved to your account. They sync across devices.'}
            </p>
          </div>
          <AuthButton onClick={() => setShowCreate(true)}>+ Create feed</AuthButton>
        </div>

        {feedsQuotaWarning && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-gold-light text-amber-700 text-sm border border-amber-200">
            Projects used: {feedsQuotaWarning}. Archive or delete feeds to free space.
          </div>
        )}

        {visibleLocal && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-coral-light text-coral border border-coral/30 text-sm flex items-center gap-3">
            <div className="flex-1">
              <div className="font-semibold">
                We found {importableCount} local project{importableCount === 1 ? '' : 's'} on this device.
              </div>
              <div className="text-warm-gray">Import them to your account to access them from any device.</div>
              {importStatus && <div className="mt-1 text-dark-brown">{importStatus}</div>}
            </div>
            <AuthButton
              onClick={handleImport}
              disabled={importing}
              variant="primary"
            >
              {importing ? 'Importing…' : 'Import'}
            </AuthButton>
            <button
              onClick={() => setImportDismissed(true)}
              className="w-7 h-7 rounded-md text-warm-gray hover:text-coral hover:bg-white transition-colors"
              aria-label="Dismiss"
              title="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <div className="flex items-center gap-4 mb-4 text-sm">
          <label className="flex items-center gap-2 cursor-pointer text-warm-gray">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>

        {listError && (
          <div className="mb-5 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {listError}
          </div>
        )}

        {loading ? (
          <div className="text-warm-gray text-sm">Loading…</div>
        ) : feedsProjects.length === 0 ? (
          <div className="bg-white border border-sand rounded-2xl p-10 text-center">
            <div className="font-heading font-bold text-lg text-dark-brown mb-1">No feeds yet</div>
            <p className="text-warm-gray text-sm mb-4">Create your first one to get started.</p>
            <AuthButton onClick={() => setShowCreate(true)}>+ Create feed</AuthButton>
          </div>
        ) : (
          <div className="grid gap-3">
            {feedsProjects.map((p) => (
              <FeedCard
                key={p.id}
                project={p}
                onOpen={() => navigate(`/feeds/${encodeURIComponent(p.slug)}`)}
                onRename={() => setRenameTarget(p)}
                onMove={() => setMoveTarget(p)}
                onArchiveToggle={async () => {
                  try {
                    const updated = await patchProject(p.id, {
                      archivedAt: p.archivedAt ? null : 'now',
                    });
                    upsertFeedProject(updated);
                    if (!includeArchived && updated.archivedAt) removeFeedProject(p.id);
                  } catch (err) {
                    const msg = err instanceof ApiError ? err.message : 'Update failed';
                    alert(msg);
                  }
                }}
                onDelete={() => setDeleteTarget(p)}
              />
            ))}
          </div>
        )}
      </main>

      {showCreate && (
        <CreateFeedDialog
          onClose={() => setShowCreate(false)}
          onCreated={(p) => {
            upsertFeedProject(p);
            setShowCreate(false);
            navigate(`/feeds/${encodeURIComponent(p.slug)}`);
          }}
        />
      )}

      {renameTarget && (
        <RenameFeedDialog
          project={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={(p) => {
            upsertFeedProject(p);
            setRenameTarget(null);
          }}
        />
      )}

      {moveTarget && (
        <MoveFeedDialog
          project={moveTarget}
          onClose={() => setMoveTarget(null)}
          onMoved={(result) => {
            // The project leaves the current workspace; drop it from the list.
            removeFeedProject(moveTarget.id);
            setMoveTarget(null);
            const dest =
              result.project.ownerType === 'user'
                ? 'your personal feeds'
                : userOrgs.find((o) => o.id === result.project.ownerId)?.name ?? 'organization';
            const slugNote = result.slugChanged
              ? ` Slug changed from "${result.previousSlug}" to "${result.project.slug}" to avoid a collision in the destination.`
              : '';
            setMoveResult({
              message: `"${result.project.name}" was moved to ${dest}.${slugNote}`,
            });
            setTimeout(() => setMoveResult(null), 8000);
          }}
        />
      )}

      {moveResult && (
        <div className="fixed bottom-6 right-6 max-w-md bg-teal text-white px-4 py-3 rounded-xl shadow-lg z-50 text-sm">
          {moveResult.message}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete feed?"
          body={`"${deleteTarget.name}" will be removed. This action can't be undone from here.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async () => {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            try {
              await deleteProject(id);
              removeFeedProject(id);
            } catch (err) {
              const msg = err instanceof ApiError ? err.message : 'Delete failed';
              alert(msg);
            }
          }}
        />
      )}
    </div>
  );
}

function FeedCard({
  project,
  onOpen,
  onRename,
  onMove,
  onArchiveToggle,
  onDelete,
}: {
  project: ProjectSummary;
  onOpen: () => void;
  onRename: () => void;
  onMove: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}) {
  const archived = !!project.archivedAt;
  const lastEdited = project.workingStateUpdatedAt ?? project.updatedAt;

  return (
    <div
      className={`bg-white border rounded-2xl p-4 flex items-center gap-4 transition-colors ${
        archived ? 'border-sand opacity-70' : 'border-sand hover:border-coral/40'
      }`}
    >
      <button
        onClick={onOpen}
        className="flex-1 text-left focus:outline-none"
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="font-heading font-bold text-base text-dark-brown">{project.name}</span>
          {archived && <Badge variant="warning">Archived</Badge>}
        </div>
        <div className="text-xs text-warm-gray">
          <span className="font-mono">{project.slug}</span>
          <span className="mx-2">·</span>
          Edited {formatDate(lastEdited)}
          <span className="mx-2">·</span>
          {project.versionCount ?? 0} version{(project.versionCount ?? 0) === 1 ? '' : 's'}
        </div>
        {project.description && (
          <div className="text-sm text-warm-gray mt-1 line-clamp-2">{project.description}</div>
        )}
      </button>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className="w-8 h-8 rounded-md text-warm-gray hover:text-coral hover:bg-cream flex items-center justify-center"
            aria-label="Feed actions"
            title="Actions"
          >
            •••
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            className="bg-white rounded-xl shadow-lg border border-sand p-1 w-44 z-50"
          >
            <PopoverItem onSelect={onOpen}>Open</PopoverItem>
            <PopoverItem onSelect={onRename}>Rename</PopoverItem>
            <PopoverItem onSelect={onMove}>Move to…</PopoverItem>
            <PopoverItem onSelect={onArchiveToggle}>
              {archived ? 'Unarchive' : 'Archive'}
            </PopoverItem>
            <PopoverItem onSelect={onDelete} danger>
              Delete
            </PopoverItem>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function PopoverItem({
  onSelect,
  children,
  danger = false,
}: {
  onSelect: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Popover.Close asChild>
      <button
        onClick={onSelect}
        className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
          danger
            ? 'text-red-600 hover:bg-red-50'
            : 'text-dark-brown hover:bg-cream'
        }`}
      >
        {children}
      </button>
    </Popover.Close>
  );
}

function CreateFeedDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: ProjectSummary) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeWorkspace = useStore((s) => s.activeWorkspace);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const owner: { type: 'user' } | { type: 'org'; id: string } =
        activeWorkspace.type === 'org'
          ? { type: 'org', id: activeWorkspace.orgId }
          : { type: 'user' };
      const p = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        owner,
      });
      onCreated(p);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Create failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Create feed</h3>
        <FormField label="Name" value={name} onChange={setName} required />
        <FormField
          label="Description (optional)"
          value={description}
          onChange={setDescription}
        />
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : 'Create'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function RenameFeedDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onSaved: (p: ProjectSummary) => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [slug, setSlug] = useState(project.slug);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const updated = await patchProject(project.id, {
        name: name.trim(),
        description: description.trim() ? description.trim() : null,
        slug: slug.trim() !== project.slug ? slug.trim() : undefined,
      });
      onSaved(updated);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Update failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Edit feed</h3>
        <FormField label="Name" value={name} onChange={setName} required />
        <FormField label="Slug" value={slug} onChange={setSlug} required />
        <FormField label="Description" value={description} onChange={setDescription} />
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" disabled={busy || !name.trim() || !slug.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function MoveFeedDialog({
  project,
  onClose,
  onMoved,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onMoved: (result: TransferResult) => void;
}) {
  const userOrgs = useStore((s) => s.userOrgs);
  // Destination options: personal (if not already there) + every org I'm
  // editor+ in (excluding the current owner).
  const options = useMemo(() => {
    const opts: { value: string; label: string; type: 'user' | 'org'; orgId?: string }[] = [];
    if (project.ownerType !== 'user') {
      opts.push({ value: 'user', label: 'My personal feeds', type: 'user' });
    }
    for (const org of userOrgs) {
      if (project.ownerType === 'org' && project.ownerId === org.id) continue;
      if (!roleAtLeast(org.role, 'editor')) continue;
      opts.push({ value: `org:${org.id}`, label: org.name, type: 'org', orgId: org.id });
    }
    return opts;
  }, [userOrgs, project]);

  const [value, setValue] = useState<string>(options[0]?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setError(null);
    setBusy(true);
    try {
      const opt = options.find((o) => o.value === value);
      if (!opt) throw new Error('Pick a destination');
      const destination =
        opt.type === 'user'
          ? ({ type: 'user' } as const)
          : ({ type: 'org', id: opt.orgId! } as const);
      const result = await transferProject(project.id, destination);
      onMoved(result);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Move failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/30" onClick={busy ? undefined : onClose} />
      <form
        onSubmit={submit}
        className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-md mx-4"
      >
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-1">Move feed</h3>
        <p className="text-xs text-warm-gray mb-4">
          Move <span className="font-semibold text-dark-brown">{project.name}</span> to a different
          workspace. Versions, working state, and any active publication move with it.
        </p>
        {options.length === 0 ? (
          <div className="px-3 py-2 mb-3 rounded-md bg-cream text-sm text-warm-gray">
            No destinations available. Create an organization or join one as an editor to enable
            this.
          </div>
        ) : (
          <>
            <label className="block text-xs font-semibold text-dark-brown mb-1">Destination</label>
            <select
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              className="w-full mb-4 px-3 py-2 rounded-lg border border-sand focus:border-coral focus:outline-none text-sm bg-white"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-warm-gray mb-3">
              If the slug <span className="font-mono">{project.slug}</span> is already in use in the
              destination, a number will be appended.
            </p>
          </>
        )}
        {error && (
          <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-2">
          <AuthButton type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton type="submit" disabled={busy || options.length === 0 || !value}>
            {busy ? 'Moving…' : 'Move'}
          </AuthButton>
        </div>
      </form>
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-lg p-6 w-full max-w-sm mx-4">
        <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">{title}</h3>
        <p className="text-sm text-warm-gray mb-5">{body}</p>
        <div className="flex justify-end gap-2">
          <AuthButton variant="secondary" onClick={onCancel}>
            Cancel
          </AuthButton>
          <AuthButton variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </AuthButton>
        </div>
      </div>
    </div>
  );
}
